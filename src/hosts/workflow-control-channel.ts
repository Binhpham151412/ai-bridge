import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isPidAlive } from '../core/lock/run-lock.ts';
import { isValidWorkflowId } from '../core/workflow/types.ts';
import { readWorkflowLockOwner } from '../core/workflow/workflow-lock.ts';
import { CONTROL_REQUEST_ID_PATTERN, WORKFLOW_CONTROL_ACTIONS, type WorkflowControlAction, type WorkflowControlResult, type WorkflowErrorCode } from './workflow-host-protocol.ts';

/**
 * M5.8 — how a live Workflow Host is reached by a process that did not start it (the CLI in
 * another terminal, or the desktop app after a restart). Same pattern as BridgeEngine's pause
 * marker: small files under `.ai-bridge/state/`, written by requesters, consumed by the one live
 * host. It is not a lock and decides nothing — the host submits each request to its
 * WorkflowEngine and writes back exactly what the engine answered.
 *
 *   state/workflow-host.json                    {schema, pid, workflowId, startedAt}: the workflow the
 *                                               workflow-lock holder serves. Written after the lock is
 *                                               taken, removed before it is released; trusted only while
 *                                               its pid is the live lock holder.
 *   state/workflow-control/<id>.request.json    {schema, requestId, workflowId, action, requestedAt}
 *   state/workflow-control/<id>.result.json     {schema, requestId, result}
 *
 * Only pause/stop travel this way: every other action needs a new host (the instance is at rest).
 */

export interface HostedWorkflow {
  /** pid of the live workflow-lock holder. */
  pid: number;
  /** The workflow it advertises; null while it is still starting (lock taken, not yet advertised). */
  workflowId: string | null;
}

const hostFile = (aiBridgeDir: string) => path.join(aiBridgeDir, 'state', 'workflow-host.json');
export const controlDir = (aiBridgeDir: string) => path.join(aiBridgeDir, 'state', 'workflow-control');
const REQUEST_SUFFIX = '.request.json';
const RESULT_SUFFIX = '.result.json';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), 'utf8');
  await rename(tmp, file);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const failure = (code: WorkflowErrorCode, message: string): WorkflowControlResult => ({ ok: false, error: { code, message } });

function isControlResult(v: unknown): v is WorkflowControlResult {
  return isObject(v) && (v.ok === true ? typeof v.state === 'string' : v.ok === false && isObject(v.error) && typeof v.error.code === 'string' && typeof v.error.message === 'string');
}

/** The live workflow-lock holder and the workflow it advertises; null when no Workflow Host is alive. */
export async function readHostedWorkflow(aiBridgeDir: string): Promise<HostedWorkflow | null> {
  const owner = await readWorkflowLockOwner(aiBridgeDir);
  if (!owner || !isPidAlive(owner.pid)) return null;
  const ad = await readJson(hostFile(aiBridgeDir));
  const workflowId = isObject(ad) && ad.pid === owner.pid && isValidWorkflowId(ad.workflowId) ? ad.workflowId : null;
  return { pid: owner.pid, workflowId };
}

/** Host side: called right after the workflow lock was taken for `workflowId`. */
export async function advertiseHostedWorkflow(aiBridgeDir: string, workflowId: string): Promise<void> {
  await mkdir(path.join(aiBridgeDir, 'state'), { recursive: true });
  await writeAtomic(hostFile(aiBridgeDir), { schema: 1, pid: process.pid, workflowId, startedAt: new Date().toISOString() });
}

/** Host side: called before the workflow lock is released. Never removes another process's record. */
export async function withdrawHostedWorkflow(aiBridgeDir: string, workflowId: string): Promise<void> {
  const ad = await readJson(hostFile(aiBridgeDir));
  if (isObject(ad) && ad.pid === process.pid && ad.workflowId === workflowId) await rm(hostFile(aiBridgeDir), { force: true });
}

let requestCounter = 0;

/** Unique within this machine and sortable by creation time. */
export function newControlRequestId(): string {
  requestCounter += 1;
  return `${Date.now()}-${process.pid}-${requestCounter}`;
}

/**
 * Requester side: asks the live host serving `workflowId` to pause or stop it, and waits for
 * its answer. Never reports success the host did not report: a host that is gone, serves
 * another workflow, or does not answer in time is HOST_UNAVAILABLE / NOT_HOSTED.
 */
export async function requestWorkflowControl(
  aiBridgeDir: string,
  workflowId: string,
  action: WorkflowControlAction,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<WorkflowControlResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 100;
  const hosted = await readHostedWorkflow(aiBridgeDir);
  if (!hosted) return failure('HOST_UNAVAILABLE', 'no Workflow Host is running for this project');
  if (hosted.workflowId === null) return failure('HOST_UNAVAILABLE', `the Workflow Host (pid ${hosted.pid}) is still starting — try again`);
  if (hosted.workflowId !== workflowId) return failure('NOT_HOSTED', `the running Workflow Host serves ${hosted.workflowId}, not ${workflowId}`);

  const dir = controlDir(aiBridgeDir);
  await mkdir(dir, { recursive: true });
  const requestId = newControlRequestId();
  const requestFile = path.join(dir, `${requestId}${REQUEST_SUFFIX}`);
  const resultFile = path.join(dir, `${requestId}${RESULT_SUFFIX}`);
  await writeAtomic(requestFile, { schema: 1, requestId, workflowId, action, requestedAt: new Date().toISOString() });

  const take = async (): Promise<WorkflowControlResult | null> => {
    const raw = await readJson(resultFile);
    if (!isObject(raw) || raw.requestId !== requestId || !isControlResult(raw.result)) return null;
    await rm(resultFile, { force: true });
    return raw.result;
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await take();
    if (result) return result;
    const hostGone = !isPidAlive(hosted.pid);
    if (hostGone || Date.now() > deadline) {
      await rm(requestFile, { force: true });
      const late = await take(); // answered in the last moment
      if (late) return late;
      return failure('HOST_UNAVAILABLE', hostGone ? 'the Workflow Host ended before answering' : `the Workflow Host did not answer within ${timeoutMs} ms`);
    }
    await sleep(pollMs);
  }
}

/**
 * Host side: takes every pending request (oldest first), hands the ones for `workflowId` to
 * `handle`, and writes one result per request. A request file is removed before it is handled,
 * so it is never applied twice. Returns how many requests were handled.
 */
export async function serveControlRequests(aiBridgeDir: string, workflowId: string, handle: (action: WorkflowControlAction) => Promise<WorkflowControlResult>): Promise<number> {
  const dir = controlDir(aiBridgeDir);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(REQUEST_SUFFIX)).sort();
  let handled = 0;
  for (const name of names) {
    const requestId = name.slice(0, -REQUEST_SUFFIX.length);
    if (!CONTROL_REQUEST_ID_PATTERN.test(requestId)) continue;
    // Claimed by an atomic rename: a request withdrawn by its requester, or already taken, is skipped.
    const claimed = path.join(dir, `${requestId}.taken.${process.pid}`);
    try {
      await rename(path.join(dir, name), claimed);
    } catch {
      continue;
    }
    const raw = await readJson(claimed);
    await rm(claimed, { force: true });
    let result: WorkflowControlResult;
    if (!isObject(raw) || raw.requestId !== requestId || !(WORKFLOW_CONTROL_ACTIONS as readonly unknown[]).includes(raw.action) || !isValidWorkflowId(raw.workflowId)) {
      result = failure('INVALID_REQUEST', 'malformed control request');
    } else if (raw.workflowId !== workflowId) {
      result = failure('NOT_HOSTED', `this Workflow Host serves ${workflowId}, not ${raw.workflowId}`);
    } else {
      result = await handle(raw.action as WorkflowControlAction);
    }
    await writeAtomic(path.join(dir, `${requestId}${RESULT_SUFFIX}`), { schema: 1, requestId, result });
    handled += 1;
  }
  return handled;
}
