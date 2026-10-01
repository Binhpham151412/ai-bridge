import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { sha256Text } from '../integrity/integrity.ts';
import { canonicalJson } from './canonical-json.ts';
import { WORKFLOW_EVENT_TYPES, type WorkflowEvent, type WorkflowEventDraft } from './types.ts';

/**
 * M5.3 — the per-instance, append-only, hash-chained workflow event log
 * (`workflows/instances/<workflowId>/events.jsonl`, docs/27 §3.2–3.4). One canonical-JSON
 * line per event. `hash` = SHA-256 of the canonical event without `hash`; `prevHash` links
 * to the previous event; `seq` is gap-free from 1. The run event stream
 * (`logs/events.jsonl`, BridgeEngine) is a separate file and is never touched here.
 */

type Unsealed = Omit<WorkflowEvent, 'hash'>;

export function eventHash(event: Unsealed): string {
  return sha256Text(canonicalJson(event));
}

/** Turns one decision's drafts into chained envelopes. The first event of a batch (the
 * INPUT_RECEIVED) is the causation of the rest of the batch. */
export function sealEvents(workflowId: string, previous: { seq: number; hash: string | null }, drafts: readonly WorkflowEventDraft[]): WorkflowEvent[] {
  const sealed: WorkflowEvent[] = [];
  let seq = previous.seq;
  let prevHash = previous.hash;
  let batchHead: string | null = null;
  for (const draft of drafts) {
    seq += 1;
    const eventId = `${workflowId}#${seq}`;
    const unsealed: Unsealed = { schema: 1, eventId, seq, workflowId, correlationId: workflowId, causationId: batchHead, prevHash, ...draft };
    const event: WorkflowEvent = { ...unsealed, hash: eventHash(unsealed) };
    sealed.push(event);
    prevHash = event.hash;
    batchHead ??= eventId;
  }
  return sealed;
}

/** One append call for the whole batch (a crash can at worst tear the final line). */
export async function appendEvents(file: string, events: readonly WorkflowEvent[]): Promise<void> {
  if (events.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, events.map((e) => `${canonicalJson(e)}\n`).join(''), 'utf8');
}

export type ReadEventLogResult =
  | {
      ok: true;
      events: WorkflowEvent[];
      /** Bytes after the last newline — a line a crash cut off mid-write; null when none. */
      tornTailBytes: number | null;
      /** Length of the intact prefix (every complete line). */
      validBytes: number;
    }
  | { ok: false; reason: string; seq: number };

const NEWLINE = 0x0a;

/** Reads and verifies the whole chain. A partial final line (no trailing newline) is
 * reported as a torn tail, not as corruption; any problem in a COMPLETE line is a broken
 * chain (tampering or corruption) and makes the log unusable for writing. */
export async function readEventLog(file: string, workflowId: string): Promise<ReadEventLogResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, events: [], tornTailBytes: null, validBytes: 0 };
    throw err;
  }
  const validBytes = bytes.lastIndexOf(NEWLINE) + 1;
  const tornTailBytes = validBytes < bytes.length ? bytes.length - validBytes : null;
  const lines = validBytes === 0 ? [] : bytes.subarray(0, validBytes - 1).toString('utf8').split('\n');

  const events: WorkflowEvent[] = [];
  let prevHash: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const seq = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      return { ok: false, reason: `line ${seq} is not valid JSON`, seq };
    }
    if (!isWorkflowEvent(parsed)) return { ok: false, reason: `line ${seq} is not a workflow event`, seq };
    const e = parsed;
    if (e.seq !== seq || e.eventId !== `${workflowId}#${seq}`) return { ok: false, reason: `line ${seq} has seq ${e.seq} / id ${e.eventId}`, seq };
    if (e.workflowId !== workflowId || e.correlationId !== workflowId) return { ok: false, reason: `line ${seq} belongs to ${e.workflowId}`, seq };
    if (e.prevHash !== prevHash) return { ok: false, reason: `line ${seq} does not link to the previous event`, seq };
    const { hash, ...rest } = e;
    if (eventHash(rest) !== hash) return { ok: false, reason: `line ${seq} does not match its hash`, seq };
    if (canonicalJson(e) !== lines[i]) return { ok: false, reason: `line ${seq} is not in canonical form`, seq };
    events.push(e);
    prevHash = hash;
  }
  return { ok: true, events, tornTailBytes, validBytes };
}

/** Drops a torn final line (only ever called with `validBytes` from readEventLog). */
export async function truncateEventLog(file: string, validBytes: number): Promise<void> {
  await truncate(file, validBytes);
}

function isWorkflowEvent(v: unknown): v is WorkflowEvent {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  const nullableString = (x: unknown) => x === null || typeof x === 'string';
  return (
    e.schema === 1 &&
    typeof e.eventId === 'string' &&
    typeof e.seq === 'number' &&
    typeof e.timestamp === 'string' &&
    typeof e.workflowId === 'string' &&
    typeof e.correlationId === 'string' &&
    nullableString(e.causationId) &&
    nullableString(e.stepId) &&
    nullableString(e.attemptId) &&
    nullableString(e.executionId) &&
    typeof e.actor === 'string' &&
    (e.provider === null || e.provider === 'claude-code' || e.provider === 'codex') &&
    (WORKFLOW_EVENT_TYPES as readonly unknown[]).includes(e.type) &&
    typeof e.payload === 'object' &&
    e.payload !== null &&
    !Array.isArray(e.payload) &&
    Array.isArray(e.artifacts) &&
    nullableString(e.prevHash) &&
    typeof e.hash === 'string'
  );
}
