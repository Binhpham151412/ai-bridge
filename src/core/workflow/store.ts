import { mkdir, readdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Text } from '../integrity/integrity.ts';
import { AtomicJsonWriter } from '../state-manager/atomic-json-writer.ts';
import { canonicalJson } from './canonical-json.ts';
import type { WorkflowDefinition } from './definition.ts';
import { createWorkflowInstance, replayWorkflowLog, type WorkflowDecision } from './decider.ts';
import { appendEvents, readEventLog, sealEvents, truncateEventLog } from './event-log.ts';
import { hashDefinition } from './hash.ts';
import { isValidWorkflowId, type WorkflowAttempt, type WorkflowEvent, type WorkflowEventDraft, type WorkflowInstance } from './types.ts';
import { validateWorkflowDefinition, type WorkflowValidationError } from './validator.ts';

/**
 * M5.3 — workflow persistence under `<project>/.ai-bridge/workflows/instances/<workflowId>/`
 * (docs/34 §3). Single writer: the workflow host that holds the workflow lock. Nothing here
 * touches BridgeEngine's files (`state/current-session.json`, `sessions/`, `logs/`).
 *
 *   definition.json            the pinned definition (AtomicJsonWriter); its hash must equal
 *                              the definitionHash recorded at creation
 *   events.jsonl               hash-chained event log (event-log.ts) — the source of truth
 *   instance.json              snapshot {schema, lastEventSeq, lastEventHash, instance}
 *                              (AtomicJsonWriter, reused unchanged) — a checked cache
 *   attempts/<stepId>-<n>.json per-attempt audit copy, derived from the snapshot, never read back
 *
 * Commit order is events FIRST, then the snapshot (docs/27 §7). A crash in between leaves a
 * log ahead of its snapshot; `load()` re-derives the snapshot by replaying the log through
 * the pure decider (replayWorkflowLog) and cross-checks the older snapshot against the
 * replayed state at its seq. A torn final line is truncated; any other inconsistency is a
 * BROKEN instance, which is never written to again.
 */

export interface WorkflowPaths {
  dir: string;
  definition: string;
  snapshot: string;
  events: string;
  attempts: string;
}

interface SnapshotFile {
  schema: 1;
  lastEventSeq: number;
  lastEventHash: string;
  instance: WorkflowInstance;
}

export interface WorkflowHandle {
  readonly workflowId: string;
  readonly paths: WorkflowPaths;
  readonly definition: WorkflowDefinition;
  readonly instance: WorkflowInstance;
  readonly lastSeq: number;
  readonly lastHash: string;
  /** Loaded without repair while a repair was needed: may be viewed, never committed to. */
  readonly readOnly: boolean;
}

export type CreateResult = { ok: true; handle: WorkflowHandle } | { ok: false; errors: WorkflowValidationError[] };

export type LoadResult =
  | { ok: true; handle: WorkflowHandle; needsRepair: boolean; repairs: string[] }
  | { ok: false; code: 'INVALID_ID' | 'NOT_FOUND' | 'INCOMPLETE'; reason: string }
  /** Tampered or corrupt: read-only — the last snapshot (if readable) for display only. */
  | { ok: false; code: 'BROKEN'; reason: string; snapshot: WorkflowInstance | null };

export interface WorkflowStoreDeps {
  now?: () => Date;
  /** Test-only: runs after the events of a commit are appended and before the snapshot is
   * written — a deterministic "crash between event and snapshot". Never set in production. */
  beforeSnapshotWrite?: () => void | Promise<void>;
}

const MAX_PER_DAY = 999;

export class WorkflowStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly beforeSnapshotWrite: (() => void | Promise<void>) | undefined;

  /** `aiBridgeDir` = `<project>/.ai-bridge`. */
  constructor(aiBridgeDir: string, deps: WorkflowStoreDeps = {}) {
    this.root = path.join(aiBridgeDir, 'workflows', 'instances');
    this.now = deps.now ?? (() => new Date());
    this.beforeSnapshotWrite = deps.beforeSnapshotWrite;
  }

  paths(workflowId: string): WorkflowPaths {
    const dir = path.join(this.root, workflowId);
    return { dir, definition: path.join(dir, 'definition.json'), snapshot: path.join(dir, 'instance.json'), events: path.join(dir, 'events.jsonl'), attempts: path.join(dir, 'attempts') };
  }

  /** Every instance directory with a valid workflow id, oldest first. */
  async list(): Promise<string[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    return names.filter(isValidWorkflowId).sort();
  }

  /** Creates a CREATED instance: allocate id → pin definition → WORKFLOW_CREATED → snapshot. */
  async create(definition: WorkflowDefinition, definitionHash: string, inputs: unknown): Promise<CreateResult> {
    if (hashDefinition(definition) !== definitionHash) {
      return { ok: false, errors: [{ path: '$.definitionHash', code: 'INVALID_VALUE', message: 'does not match the definition' }] };
    }
    const at = this.now();
    const workflowId = await this.allocateWorkflowId(at);
    const paths = this.paths(workflowId);
    const created = createWorkflowInstance(definition, { workflowId, definitionHash, inputs, at: at.toISOString() });
    if (!created.ok) {
      await rmdir(paths.dir).catch(() => {}); // our own, still-empty directory
      return { ok: false, errors: created.errors };
    }
    await new AtomicJsonWriter<WorkflowDefinition>(paths.definition).write(definition);
    const sealed = sealEvents(workflowId, { seq: 0, hash: null }, created.events);
    await appendEvents(paths.events, sealed);
    const handle = handleOf(workflowId, paths, definition, created.instance, sealed, false);
    await this.writeSnapshot(handle);
    return { ok: true, handle };
  }

  /**
   * Loads and verifies an instance. With `repair` (only the workflow-lock holder may pass
   * it), a torn tail is truncated, events a crash cut off are re-appended, a RECONCILED
   * event records the repair, and the snapshot is rewritten. Without it, nothing on disk
   * changes and the handle is read-only whenever a repair would have been needed.
   */
  async load(workflowId: string, options: { repair?: boolean } = {}): Promise<LoadResult> {
    if (!isValidWorkflowId(workflowId)) return { ok: false, code: 'INVALID_ID', reason: `not a workflow id: ${JSON.stringify(workflowId)}` };
    const paths = this.paths(workflowId);
    if (!(await exists(paths.dir))) return { ok: false, code: 'NOT_FOUND', reason: `no workflow ${workflowId}` };

    const snapshotRead = await readJson<SnapshotFile>(paths.snapshot);
    const broken = (reason: string): LoadResult => ({ ok: false, code: 'BROKEN', reason, snapshot: snapshotRead.ok && snapshotRead.value ? snapshotRead.value.instance : null });

    const log = await readEventLog(paths.events, workflowId);
    if (!log.ok) return broken(`event log: ${log.reason}`);
    const definitionRead = await readJson<unknown>(paths.definition);
    if (log.events.length === 0) {
      if (snapshotRead.ok && snapshotRead.value === null) return { ok: false, code: 'INCOMPLETE', reason: 'creation did not complete (no WORKFLOW_CREATED event)' };
      return broken('a snapshot exists but the event log is empty');
    }
    if (!definitionRead.ok || definitionRead.value === null) return broken('definition.json is missing or unreadable');
    const validated = validateWorkflowDefinition(definitionRead.value);
    if (!validated.valid) return broken('definition.json is not a valid definition');
    const definition = validated.definition;
    const pinned = log.events[0].payload.definitionHash;
    if (hashDefinition(definition) !== pinned) return broken('definition.json does not match the pinned definitionHash');

    const replay = replayWorkflowLog(definition, log.events);
    if (!replay.ok) return broken(`event ${replay.atSeq}: ${replay.reason}`);
    const lastEvent = log.events.at(-1)!;

    if (!snapshotRead.ok) return broken('instance.json is unreadable');
    const snapshot = snapshotRead.value;
    if (snapshot) {
      if (snapshot.schema !== 1 || !Number.isInteger(snapshot.lastEventSeq) || snapshot.lastEventSeq < 1 || snapshot.lastEventSeq > lastEvent.seq) return broken('instance.json points past the event log');
      if (log.events[snapshot.lastEventSeq - 1].hash !== snapshot.lastEventHash) return broken('instance.json does not match the event it claims');
      const expected = replay.states.get(snapshot.lastEventSeq);
      if (!expected || canonicalJson(expected) !== canonicalJson(snapshot.instance)) return broken('instance.json differs from the state the event log produces');
    }

    const snapshotBehind = !snapshot || snapshot.lastEventSeq !== lastEvent.seq;
    const needsRepair = log.tornTailBytes !== null || replay.missing.length > 0 || snapshotBehind;
    let handle = handleOf(workflowId, paths, definition, replay.instance, log.events, needsRepair && !options.repair);
    const repairs: string[] = [];
    if (needsRepair && options.repair) {
      if (log.tornTailBytes !== null) {
        await truncateEventLog(paths.events, log.validBytes);
        repairs.push(`truncated a torn final line (${log.tornTailBytes} bytes)`);
      }
      const repairDrafts: WorkflowEventDraft[] = [...replay.missing];
      if (replay.missing.length > 0) repairs.push(`re-appended ${replay.missing.length} event(s) of an interrupted commit`);
      if (snapshotBehind) repairs.push(snapshot ? `snapshot was behind (seq ${snapshot.lastEventSeq} of ${lastEvent.seq})` : 'snapshot was missing');
      repairDrafts.push({
        type: 'RECONCILED',
        timestamp: this.now().toISOString(),
        stepId: null,
        attemptId: null,
        executionId: null,
        actor: 'workflow-engine',
        provider: null,
        payload: { repairs, tornTailBytes: log.tornTailBytes ?? 0, reappended: replay.missing.length, snapshotWasBehind: snapshotBehind },
        artifacts: [],
      });
      const sealed = sealEvents(workflowId, { seq: lastEvent.seq, hash: lastEvent.hash }, repairDrafts);
      await appendEvents(paths.events, sealed);
      handle = handleOf(workflowId, paths, definition, replay.instance, [...log.events, ...sealed], false);
      await this.writeSnapshot(handle);
    }
    return { ok: true, handle, needsRepair, repairs };
  }

  /** Persists one accepted decision: events first, then the snapshot, then attempt copies. */
  async commit(handle: WorkflowHandle, decision: WorkflowDecision): Promise<WorkflowHandle> {
    if (handle.readOnly) throw new Error(`WORKFLOW_READ_ONLY: ${handle.workflowId} must be loaded with repair before it can change`);
    if (!decision.accepted) throw new Error('WORKFLOW_COMMIT_REJECTED: a rejected decision cannot be committed');
    if (decision.events.length === 0) return handle;
    if (decision.events[0].type !== 'INPUT_RECEIVED' || decision.instance.workflowId !== handle.workflowId) throw new Error('WORKFLOW_COMMIT_INVALID: not a decision for this workflow');

    const sealed = sealEvents(handle.workflowId, { seq: handle.lastSeq, hash: handle.lastHash }, decision.events);
    await appendEvents(handle.paths.events, sealed);
    await this.beforeSnapshotWrite?.();
    const next = handleOf(handle.workflowId, handle.paths, handle.definition, decision.instance, sealed, false, handle);
    await this.writeSnapshot(next);
    await this.writeAttemptRecords(next, sealed);
    return next;
  }

  /** M5.5: the exact task text sent for an attempt (`attempts/<stepId>-<n>/task.md`, docs/34 §3);
   * an audit copy, never read back for decisions. Returns its sha256. */
  async writeAttemptTask(handle: WorkflowHandle, attempt: Pick<WorkflowAttempt, 'stepId' | 'attemptNo'>, task: string): Promise<string> {
    const dir = path.join(handle.paths.attempts, `${attempt.stepId}-${attempt.attemptNo}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'task.md'), task, 'utf8');
    return sha256Text(task);
  }

  /** `wf_YYYY-MM-DD_NNN` (UTC), numbered after what is on disk, so ids survive restarts;
   * the directory is created exclusively, so two allocations never get the same id. */
  private async allocateWorkflowId(at: Date): Promise<string> {
    const day = at.toISOString().slice(0, 10);
    await mkdir(this.root, { recursive: true });
    const taken = (await readdir(this.root))
      .map((n) => /^wf_(\d{4}-\d{2}-\d{2})_(\d{3})$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null && m[1] === day)
      .map((m) => Number(m[2]));
    for (let n = (taken.length ? Math.max(...taken) : 0) + 1; n <= MAX_PER_DAY; n++) {
      const workflowId = `wf_${day}_${String(n).padStart(3, '0')}`;
      try {
        await mkdir(path.join(this.root, workflowId));
        return workflowId;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error(`WORKFLOW_ID_EXHAUSTED: more than ${MAX_PER_DAY} workflows on ${day}`);
  }

  private async writeSnapshot(handle: WorkflowHandle): Promise<void> {
    const file: SnapshotFile = { schema: 1, lastEventSeq: handle.lastSeq, lastEventHash: handle.lastHash, instance: handle.instance };
    await new AtomicJsonWriter<SnapshotFile>(handle.paths.snapshot).write(file);
  }

  private async writeAttemptRecords(handle: WorkflowHandle, sealed: readonly WorkflowEvent[]): Promise<void> {
    const touched = new Set(sealed.map((e) => e.attemptId).filter((id): id is string => id !== null));
    for (const attempt of handle.instance.steps.flatMap((s) => s.attempts)) {
      if (!touched.has(attempt.attemptId)) continue;
      await new AtomicJsonWriter<{ schema: 1; workflowId: string; definitionHash: string; attempt: WorkflowAttempt }>(path.join(handle.paths.attempts, `${attempt.stepId}-${attempt.attemptNo}.json`)).write({
        schema: 1,
        workflowId: handle.workflowId,
        definitionHash: handle.instance.definitionHash,
        attempt,
      });
    }
  }
}

function handleOf(
  workflowId: string,
  paths: WorkflowPaths,
  definition: WorkflowDefinition,
  instance: WorkflowInstance,
  events: readonly WorkflowEvent[],
  readOnly: boolean,
  previous?: WorkflowHandle,
): WorkflowHandle {
  const last = events.at(-1);
  return { workflowId, paths, definition, instance, lastSeq: last?.seq ?? previous!.lastSeq, lastHash: last?.hash ?? previous!.lastHash, readOnly };
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** value null = file absent; ok false = present but not JSON. */
async function readJson<T>(file: string): Promise<{ ok: true; value: T | null } | { ok: false }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: null };
    throw err;
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false };
  }
}
