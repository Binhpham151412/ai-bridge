// Shared fixtures for the M5.8 host/CLI/desktop wiring tests: a temp project with a workflow
// definition under .ai-bridge/workflows/definitions/, and scripted ExecutionPorts. No real
// CLI, no quota. (No node:test imports — the forked fake Workflow Host imports this too.)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateAndHashWorkflowDefinition } from '../../src/core/workflow/hash.ts';
import type { WorkflowHostDeps } from '../../src/hosts/workflow-host.ts';
import type { WorkflowHostCommand } from '../../src/hosts/workflow-host-protocol.ts';
import { FakeExecutionPort } from './fake-execution-port.ts';
import { step, type Mutable } from './definition-fixtures.ts';

export const DEAD_PID = 2147483647;
export const DEF_ID = 'host-flow';

export function hostDefinition(extra: Mutable = {}): Mutable {
  return { schema: 1, id: DEF_ID, version: 1, title: 'Host flow', steps: [step('build', { outputs: ['report.summary'] }), step('docs')], ...extra };
}

export async function withProject<T>(fn: (projectPath: string) => Promise<T>, prefix = 'ai-bridge-wf-host-'): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export const aiBridgeOf = (projectPath: string) => path.join(projectPath, '.ai-bridge');

/** Writes `.ai-bridge/workflows/definitions/<id>.json`; returns its definitionHash. */
export async function writeDefinition(projectPath: string, def: Mutable = hostDefinition()): Promise<string> {
  const dir = path.join(aiBridgeOf(projectPath), 'workflows', 'definitions');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8');
  const v = validateAndHashWorkflowDefinition(def);
  if (!v.valid) throw new Error(`fixture definition is invalid: ${JSON.stringify(v.errors)}`);
  return v.definitionHash;
}

export function runCommand(projectPath: string, definitionHash: string, inputs: Record<string, string> = {}, definitionId = DEF_ID): WorkflowHostCommand {
  return { type: 'run', projectPath, definitionId, definitionHash, inputs };
}

/** Engine timings for scripted ports: fast polls, no preflight grace, no live pids. */
export function hostDeps(projectPath: string, port: FakeExecutionPort, o: Partial<WorkflowHostDeps> = {}): WorkflowHostDeps {
  return { projectPath, port, engine: { pollIntervalMs: 5, preflightGraceMs: 0, isPidAlive: () => false }, controlPollMs: 10, ...o };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `intervalMs`: poll anything that reads BridgeEngine's state files at a production-like cadence —
 * on Windows a reader holding current-session.json open makes the writer's atomic rename fail
 * (EPERM; AtomicJsonWriter retries ~0.6 s), so a 5 ms read loop can break the run it watches. */
export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = 'condition', intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/** Each start runs until the port is stopped or paused (→ ENDED STOPPED/PAUSED); resume ends DONE. */
export function stoppablePort(): FakeExecutionPort {
  const port = new FakeExecutionPort();
  let n = 0;
  port.behave = async (call) => {
    if (call.kind === 'resume') return { kind: 'ENDED', executionId: call.executionId!, finalStatus: 'DONE', errorCode: null, iterations: 1, reportedTokens: 1, usageLimitDetected: false };
    const runId = `2026-10-01_${String(++n).padStart(3, '0')}`;
    call.emit({ event: 'RUN_STARTED', runId, iteration: 0, correlation: call.request?.attemptId });
    call.emit({ event: 'CLAUDE_STARTED', runId, iteration: 1 });
    const stops = port.stopCalls;
    const pauses = port.pauseCalls;
    while (port.stopCalls === stops && port.pauseCalls === pauses) await sleep(2);
    return { kind: 'ENDED', executionId: runId, finalStatus: port.stopCalls > stops ? 'STOPPED' : 'PAUSED', errorCode: null, iterations: 1, reportedTokens: 1, usageLimitDetected: false };
  };
  return port;
}

/** Every execution ends with an error code the outcome table does not know → NEEDS_HUMAN. */
export function needsHumanPort(): FakeExecutionPort {
  const port = new FakeExecutionPort();
  port.behave = async () => ({ kind: 'ENDED', executionId: '2026-10-01_001', finalStatus: 'ERROR', errorCode: 'SOMETHING_NEW', iterations: 1, reportedTokens: null, usageLimitDetected: false });
  return port;
}
