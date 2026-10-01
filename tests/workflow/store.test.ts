import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowStore, type WorkflowHandle } from '../../src/core/workflow/store.ts';
import { decideWorkflow } from '../../src/core/workflow/decider.ts';
import { hashDefinition } from '../../src/core/workflow/hash.ts';
import { canonicalJson } from '../../src/core/workflow/canonical-json.ts';
import { readEventLog } from '../../src/core/workflow/event-log.ts';
import type { WorkflowInput } from '../../src/core/workflow/types.ts';
import { at, definition, ended } from './runtime-fixtures.ts';

const DEF = definition();
const HASH = hashDefinition(DEF);
const DAY = new Date('2026-10-01T09:00:00.000Z');

async function withProject<T>(fn: (aiBridgeDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-wf-store-'));
  try {
    return await fn(path.join(root, '.ai-bridge'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const store = (dir: string, deps: ConstructorParameters<typeof WorkflowStore>[1] = {}) => new WorkflowStore(dir, { now: () => DAY, ...deps });

async function createOne(s: WorkflowStore): Promise<WorkflowHandle> {
  const r = await s.create(DEF, HASH, { task: 'do it' });
  assert.equal(r.ok, true, JSON.stringify(!r.ok && r.errors));
  if (!r.ok) throw new Error('unreachable');
  return r.handle;
}

async function step(s: WorkflowStore, h: WorkflowHandle, input: WorkflowInput): Promise<WorkflowHandle> {
  const d = decideWorkflow(h.definition, h.instance, input);
  assert.equal(d.accepted, true, !d.accepted ? d.reason : '');
  return s.commit(h, d);
}

/** START → linked → DONE → verifying: three commits, instance mid-flight. */
async function advanced(s: WorkflowStore): Promise<WorkflowHandle> {
  let h = await createOne(s);
  h = await step(s, h, { type: 'START', at: at(1) });
  const id = h.instance.steps[0].attempts[0].attemptId;
  h = await step(s, h, { type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: '2026-10-01_001' });
  h = await step(s, h, { type: 'EXECUTION_ENDED', at: at(3), attemptId: id, result: ended('2026-10-01_001', 'DONE') });
  return h;
}

async function loadOk(s: WorkflowStore, id: string, repair = false) {
  const r = await s.load(id, { repair });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('unreachable');
  return r;
}

// ---------------------------------------------------------------------------
// layout, ids, create
// ---------------------------------------------------------------------------

test('create writes definition, WORKFLOW_CREATED and the snapshot under workflows/instances/<id>/', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const h = await createOne(s);
    assert.equal(h.workflowId, 'wf_2026-10-01_001');
    assert.equal(h.paths.dir, path.join(dir, 'workflows', 'instances', 'wf_2026-10-01_001'));
    assert.deepEqual((await readdir(h.paths.dir)).sort(), ['definition.json', 'events.jsonl', 'instance.json']);
    const snap = JSON.parse(await readFile(h.paths.snapshot, 'utf8'));
    assert.equal(snap.lastEventSeq, 1);
    assert.equal(snap.instance.state, 'CREATED');
    assert.equal(snap.instance.definitionHash, HASH);
    assert.equal(hashDefinition(JSON.parse(await readFile(h.paths.definition, 'utf8'))), HASH);
    const r = await loadOk(s, h.workflowId);
    assert.equal(r.needsRepair, false);
    assert.equal(canonicalJson(r.handle.instance), canonicalJson(h.instance));
  }));

test('workflow ids are allocated from disk: sequential per day, across store restarts, never reused', () =>
  withProject(async (dir) => {
    assert.equal((await createOne(store(dir))).workflowId, 'wf_2026-10-01_001');
    assert.equal((await createOne(store(dir))).workflowId, 'wf_2026-10-01_002');
    await mkdir(path.join(dir, 'workflows', 'instances', 'wf_2026-10-01_005'), { recursive: true });
    assert.equal((await createOne(store(dir))).workflowId, 'wf_2026-10-01_006');
    const nextDay = new WorkflowStore(dir, { now: () => new Date('2026-10-02T00:00:01.000Z') });
    assert.equal((await createOne(nextDay)).workflowId, 'wf_2026-10-02_001');
    const all = await store(dir).list();
    assert.deepEqual(all, ['wf_2026-10-01_001', 'wf_2026-10-01_002', 'wf_2026-10-01_005', 'wf_2026-10-01_006', 'wf_2026-10-02_001']);
  }));

test('concurrent creates never share an id', () =>
  withProject(async (dir) => {
    const handles = await Promise.all([1, 2, 3, 4].map(() => createOne(store(dir))));
    assert.equal(new Set(handles.map((h) => h.workflowId)).size, 4);
  }));

test('create refuses a hash that does not match the definition, and bad inputs leave no directory behind', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const wrong = await s.create(DEF, 'b'.repeat(64), { task: 'x' });
    assert.equal(wrong.ok, false);
    const bad = await s.create(DEF, HASH, { nope: 'x' });
    assert.equal(bad.ok, false);
    assert.deepEqual(await s.list(), []);
  }));

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

test('commits persist decisions; a reload reproduces the instance exactly', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const h = await advanced(s);
    assert.equal(h.instance.steps[0].attempts[0].state, 'VERIFYING');
    const r = await loadOk(s, h.workflowId);
    assert.equal(r.needsRepair, false);
    assert.equal(r.handle.lastSeq, h.lastSeq);
    assert.equal(canonicalJson(r.handle.instance), canonicalJson(h.instance));
  }));

test('events are appended BEFORE the snapshot is written', () =>
  withProject(async (dir) => {
    const observed: { value: { events: number; snapshotSeq: number } | null } = { value: null };
    const s = store(dir, {
      beforeSnapshotWrite: async () => {
        const [id] = await store(dir).list();
        const p = store(dir).paths(id);
        const log = await readEventLog(p.events, id);
        observed.value = { events: log.ok ? log.events.length : -1, snapshotSeq: JSON.parse(await readFile(p.snapshot, 'utf8')).lastEventSeq };
      },
    });
    const h = await createOne(s);
    const next = await step(s, h, { type: 'START', at: at(1) });
    assert.ok(observed.value);
    assert.equal(observed.value.events, next.lastSeq, 'all events of the commit are on disk');
    assert.equal(observed.value.snapshotSeq, 1, 'the snapshot still shows the previous state');
  }));

test('commit writes per-attempt audit copies', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const h = await advanced(s);
    const record = JSON.parse(await readFile(path.join(h.paths.attempts, 'build-1.json'), 'utf8'));
    assert.equal(record.workflowId, h.workflowId);
    assert.equal(record.attempt.state, 'VERIFYING');
    assert.equal(record.attempt.executionId, '2026-10-01_001');
  }));

test('a no-op decision commits nothing; a rejected decision cannot be committed', () =>
  withProject(async (dir) => {
    const s = store(dir);
    let h = await createOne(s);
    h = await step(s, h, { type: 'START', at: at(1) });
    const id = h.instance.steps[0].attempts[0].attemptId;
    h = await step(s, h, { type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: 'r1' });
    const seq = h.lastSeq;
    const same = await step(s, h, { type: 'EXECUTION_LINKED', at: at(3), attemptId: id, executionId: 'r1' });
    assert.equal(same.lastSeq, seq);
    const rejected = decideWorkflow(h.definition, h.instance, { type: 'START', at: at(4) });
    await assert.rejects(s.commit(h, rejected), /WORKFLOW_COMMIT_REJECTED/);
  }));

// ---------------------------------------------------------------------------
// crash recovery
// ---------------------------------------------------------------------------

test('crash between events and snapshot: the snapshot is re-derived from the log on repair', () =>
  withProject(async (dir) => {
    const s = store(dir);
    let h = await createOne(s);
    h = await step(s, h, { type: 'START', at: at(1) });
    const crashing = store(dir, {
      beforeSnapshotWrite: () => {
        throw new Error('simulated crash');
      },
    });
    const d = decideWorkflow(h.definition, h.instance, { type: 'EXECUTION_LINKED', at: at(2), attemptId: h.instance.steps[0].attempts[0].attemptId, executionId: 'r1' });
    assert.ok(d.accepted);
    await assert.rejects(crashing.commit(h, d), /simulated crash/);

    const view = await loadOk(s, h.workflowId);
    assert.equal(view.needsRepair, true);
    assert.equal(view.handle.readOnly, true, 'a viewer never writes and cannot commit');
    assert.equal(view.handle.instance.steps[0].attempts[0].state, 'EXECUTING', 'the logged decision is visible');
    await assert.rejects(s.commit(view.handle, d), /WORKFLOW_READ_ONLY/);

    const repaired = await loadOk(s, h.workflowId, true);
    assert.deepEqual(repaired.repairs, ['snapshot was behind (seq 7 of 10)']);
    assert.equal(repaired.handle.readOnly, false);
    assert.equal(canonicalJson(repaired.handle.instance), canonicalJson(d.accepted ? d.instance : null));
    const log = await readEventLog(h.paths.events, h.workflowId);
    assert.equal(log.ok && log.events.at(-1)!.type, 'RECONCILED');

    const again = await loadOk(s, h.workflowId, true);
    assert.equal(again.needsRepair, false, 'consistent after one repair');
    await step(s, again.handle, { type: 'EXECUTION_ENDED', at: at(3), attemptId: h.instance.steps[0].attempts[0].attemptId, result: ended('r1', 'DONE') });
  }));

test('crash right after WORKFLOW_CREATED (no snapshot yet): the instance is rebuilt from the log', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const h = await createOne(s);
    await rm(h.paths.snapshot);
    const r = await loadOk(s, h.workflowId, true);
    assert.equal(r.handle.instance.state, 'CREATED');
    assert.deepEqual(r.repairs, ['snapshot was missing']);
  }));

test('a torn final line is truncated and recorded; the instance stays consistent', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const h = await advanced(s);
    await appendFile(h.paths.events, '{"schema":1,"eventId":"wf_2026-10-01_001#99","typ', 'utf8');
    const view = await loadOk(s, h.workflowId);
    assert.equal(view.needsRepair, true);
    assert.equal(view.handle.readOnly, true);
    const r = await loadOk(s, h.workflowId, true);
    assert.match(r.repairs[0], /^truncated a torn final line \(\d+ bytes\)$/);
    assert.equal(canonicalJson(r.handle.instance), canonicalJson(h.instance));
    const log = await readEventLog(h.paths.events, h.workflowId);
    assert.equal(log.ok && log.tornTailBytes, null);
  }));

test('a commit cut off mid-batch (some events lost) is completed from the replayed decision', () =>
  withProject(async (dir) => {
    const s = store(dir);
    let h = await createOne(s);
    const creationSnapshot = await readFile(h.paths.snapshot, 'utf8');
    h = await step(s, h, { type: 'START', at: at(1) }); // one batch of 6 events (seq 2–7)
    // Simulate a crash mid-append: only 3 of the 6 START events reached the disk, and the
    // snapshot was never rewritten.
    const lines = (await readFile(h.paths.events, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 7);
    await writeFile(h.paths.events, lines.slice(0, 4).join('\n') + '\n', 'utf8');
    await writeFile(h.paths.snapshot, creationSnapshot, 'utf8');

    const r = await loadOk(s, h.workflowId, true);
    assert.deepEqual(r.repairs, ['re-appended 3 event(s) of an interrupted commit', 'snapshot was behind (seq 1 of 4)']);
    assert.equal(canonicalJson(r.handle.instance), canonicalJson(h.instance));
    assert.equal(r.handle.instance.steps[0].attempts[0].state, 'LAUNCHING', 'write-ahead intent survives; the reconciler (M5.6) resolves it');
    const log = await readEventLog(h.paths.events, h.workflowId);
    assert.ok(log.ok);
    const lostTypes = lines.slice(1, 7).map((l) => JSON.parse(l).type);
    assert.deepEqual(
      log.events.slice(1, 7).map((e) => e.type),
      lostTypes,
      'the re-appended events are exactly the lost ones',
    );
    assert.equal(log.events[7].type, 'RECONCILED');
  }));

// ---------------------------------------------------------------------------
// broken / read-only
// ---------------------------------------------------------------------------

test('a tampered event log is BROKEN and read-only (the last snapshot is still viewable)', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const h = await advanced(s);
    const lines = (await readFile(h.paths.events, 'utf8')).split('\n');
    lines[2] = lines[2].replace('"actor":"workflow-engine"', '"actor":"host"');
    await writeFile(h.paths.events, lines.join('\n'), 'utf8');
    const r = await s.load(h.workflowId, { repair: true });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'BROKEN');
    assert.equal(r.code === 'BROKEN' && r.snapshot?.workflowId, h.workflowId);
  }));

test('a tampered snapshot, a snapshot ahead of the log, or a swapped definition is BROKEN', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const h = await advanced(s);
    const snap = JSON.parse(await readFile(h.paths.snapshot, 'utf8'));
    const def = await readFile(h.paths.definition, 'utf8');
    const cases: [string, () => Promise<void>][] = [
      ['snapshot state edited', () => writeFile(h.paths.snapshot, JSON.stringify({ ...snap, instance: { ...snap.instance, state: 'COMPLETED' } }), 'utf8')],
      ['snapshot ahead of log', () => writeFile(h.paths.snapshot, JSON.stringify({ ...snap, lastEventSeq: snap.lastEventSeq + 5 }), 'utf8')],
      ['snapshot hash mismatch', () => writeFile(h.paths.snapshot, JSON.stringify({ ...snap, lastEventHash: 'f'.repeat(64) }), 'utf8')],
      ['snapshot not JSON', () => writeFile(h.paths.snapshot, '{', 'utf8')],
      ['definition swapped', () => writeFile(h.paths.definition, JSON.stringify({ ...JSON.parse(def), title: 'Other' }), 'utf8')],
      ['definition deleted', () => rm(h.paths.definition)],
    ];
    for (const [name, damage] of cases) {
      await writeFile(h.paths.snapshot, JSON.stringify(snap), 'utf8');
      await writeFile(h.paths.definition, def, 'utf8');
      await damage();
      const r = await s.load(h.workflowId, { repair: true });
      assert.equal(!r.ok && r.code, 'BROKEN', name);
    }
  }));

test('load: invalid id, unknown id, and a directory whose creation never completed', () =>
  withProject(async (dir) => {
    const s = store(dir);
    const code = async (id: string) => {
      const r = await s.load(id);
      return r.ok ? 'OK' : r.code;
    };
    assert.equal(await code('../../etc'), 'INVALID_ID');
    assert.equal(await code('wf_2026-10-01_009'), 'NOT_FOUND');
    await mkdir(path.join(dir, 'workflows', 'instances', 'wf_2026-10-01_003'), { recursive: true });
    assert.equal(await code('wf_2026-10-01_003'), 'INCOMPLETE');
  }));

test('the store writes only under workflows/ — never BridgeEngine state, sessions or logs', () =>
  withProject(async (dir) => {
    await advanced(store(dir));
    assert.deepEqual(await readdir(dir), ['workflows']);
    await assert.rejects(stat(path.join(dir, 'state', 'current-session.json')));
  }));
