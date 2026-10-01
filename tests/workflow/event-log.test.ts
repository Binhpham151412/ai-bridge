import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvents, eventHash, readEventLog, sealEvents, truncateEventLog } from '../../src/core/workflow/event-log.ts';
import { canonicalJson } from '../../src/core/workflow/canonical-json.ts';
import type { WorkflowEventDraft } from '../../src/core/workflow/types.ts';
import { WF, at } from './runtime-fixtures.ts';

async function withDir<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-wf-log-'));
  try {
    return await fn(path.join(dir, 'events.jsonl'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const draft = (type: WorkflowEventDraft['type'], payload: WorkflowEventDraft['payload'] = {}): WorkflowEventDraft => ({
  type,
  timestamp: at(1),
  stepId: null,
  attemptId: null,
  executionId: null,
  actor: 'workflow-engine',
  provider: null,
  payload,
  artifacts: [],
});

test('sealEvents: gap-free seq, eventId, correlation, batch causation and a hash chain', () => {
  const [a, b, c] = sealEvents(WF, { seq: 0, hash: null }, [draft('INPUT_RECEIVED'), draft('WORKFLOW_STATE_CHANGED'), draft('STEP_STATE_CHANGED')]);
  assert.deepEqual(
    [a.seq, b.seq, c.seq],
    [1, 2, 3],
  );
  assert.equal(a.eventId, `${WF}#1`);
  assert.equal(a.correlationId, WF);
  assert.equal(a.causationId, null);
  assert.equal(b.causationId, a.eventId);
  assert.equal(c.causationId, a.eventId);
  assert.equal(a.prevHash, null);
  assert.equal(b.prevHash, a.hash);
  assert.equal(c.prevHash, b.hash);
  const { hash, ...rest } = b;
  assert.equal(eventHash(rest), hash);
  const next = sealEvents(WF, { seq: 3, hash: c.hash }, [draft('INPUT_RECEIVED')]);
  assert.equal(next[0].seq, 4);
  assert.equal(next[0].prevHash, c.hash);
});

test('append + read round-trips a verified chain in canonical JSON lines', () =>
  withDir(async (file) => {
    const first = sealEvents(WF, { seq: 0, hash: null }, [draft('WORKFLOW_CREATED', { note: 'é ✓' })]);
    const second = sealEvents(WF, { seq: 1, hash: first[0].hash }, [draft('INPUT_RECEIVED'), draft('PAUSE_REQUESTED')]);
    await appendEvents(file, first);
    await appendEvents(file, second);
    const text = await readFile(file, 'utf8');
    assert.equal(text, [...first, ...second].map((e) => `${canonicalJson(e)}\n`).join(''));
    const r = await readEventLog(file, WF);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.events, [...first, ...second]);
    assert.equal(r.tornTailBytes, null);
    assert.equal(r.validBytes, Buffer.byteLength(text));
  }));

test('a missing log is an empty, valid log', () =>
  withDir(async (file) => {
    assert.deepEqual(await readEventLog(file, WF), { ok: true, events: [], tornTailBytes: null, validBytes: 0 });
  }));

test('a partial final line is a torn tail (not corruption) and can be truncated away', () =>
  withDir(async (file) => {
    const events = sealEvents(WF, { seq: 0, hash: null }, [draft('WORKFLOW_CREATED'), draft('INPUT_RECEIVED')]);
    await appendEvents(file, events);
    const intact = Buffer.byteLength(await readFile(file, 'utf8'));
    await appendFile(file, '{"schema":1,"eventId":"wf_2026-10-01_001#3","pay', 'utf8');
    const r = await readEventLog(file, WF);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.events.length, 2);
    assert.equal(r.validBytes, intact);
    assert.equal(r.tornTailBytes, Buffer.byteLength('{"schema":1,"eventId":"wf_2026-10-01_001#3","pay'));
    await truncateEventLog(file, r.validBytes);
    const again = await readEventLog(file, WF);
    assert.equal(again.ok && again.tornTailBytes, null);
  }));

test('a torn tail with multi-byte characters is measured in bytes', () =>
  withDir(async (file) => {
    await appendEvents(file, sealEvents(WF, { seq: 0, hash: null }, [draft('WORKFLOW_CREATED')]));
    await appendFile(file, '{"note":"éé', 'utf8');
    const r = await readEventLog(file, WF);
    assert.equal(r.ok && r.tornTailBytes, Buffer.byteLength('{"note":"éé'));
  }));

test('tampering with any complete line breaks the chain', () =>
  withDir(async (file) => {
    const events = sealEvents(WF, { seq: 0, hash: null }, [draft('WORKFLOW_CREATED'), draft('INPUT_RECEIVED', { input: 'a' }), draft('PAUSE_REQUESTED')]);
    await appendEvents(file, events);
    const lines = (await readFile(file, 'utf8')).split('\n');

    const cases: [string, (ls: string[]) => void][] = [
      ['payload edited', (ls) => (ls[1] = ls[1].replace('"input":"a"', '"input":"b"'))],
      ['line removed', (ls) => ls.splice(1, 1)],
      ['lines swapped', (ls) => ([ls[1], ls[2]] = [ls[2], ls[1]])],
      ['garbage line', (ls) => (ls[1] = 'not json')],
      ['not an event', (ls) => (ls[1] = '{"hello":1}')],
      ['re-hashed but prevHash kept', (ls) => {
        const e = JSON.parse(ls[2]);
        e.payload = { x: 1 };
        const { hash: _h, ...rest } = e;
        e.hash = eventHash(rest);
        ls[2] = canonicalJson(e);
        // the chain still links 2→3, so this edit is only detectable because event 3 is the last: extend it
        const [tail] = sealEvents(WF, { seq: 3, hash: 'f'.repeat(64) }, [draft('RECONCILED')]);
        ls.splice(3, 0, canonicalJson(tail));
      }],
      ['non-canonical formatting', (ls) => (ls[0] = JSON.stringify(JSON.parse(ls[0]), null, 1).replace(/\n/g, ''))],
    ];
    for (const [name, mutate] of cases) {
      const copy = [...lines];
      mutate(copy);
      await writeFile(file, copy.join('\n'), 'utf8');
      const r = await readEventLog(file, WF);
      assert.equal(r.ok, false, name);
    }
  }));

test('events of another workflow are rejected', () =>
  withDir(async (file) => {
    await appendEvents(file, sealEvents('wf_2026-10-01_002', { seq: 0, hash: null }, [draft('WORKFLOW_CREATED')]));
    assert.equal((await readEventLog(file, WF)).ok, false);
  }));
