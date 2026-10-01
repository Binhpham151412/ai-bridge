import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from '../../src/core/workflow/engine.ts';
import { describeEvent, renderWorkflowJournal, writeWorkflowJournal } from '../../src/core/workflow/journal.ts';
import { sealEvents } from '../../src/core/workflow/event-log.ts';
import { WORKFLOW_EVENT_TYPES, type WorkflowEventDraft } from '../../src/core/workflow/types.ts';
import { workflowLockPath } from '../../src/core/workflow/workflow-lock.ts';
import { FakeExecutionPort, hang } from './fake-execution-port.ts';
import { step } from './definition-fixtures.ts';
import { Sim, WF, at, definition, ended } from './runtime-fixtures.ts';

// M5.7: workflow.md is derived from the verified event log + snapshot — deterministic,
// idempotent, UNKNOWN for missing data, AI_ATTESTED never shown as VERIFIED, every event shown.

async function withProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-wf-journal-'));
  try {
    return await fn(path.join(root, '.ai-bridge'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const DEF = { schema: 1, id: 'journal-flow', version: 1, title: 'Journal flow', steps: [step('build', { outputs: ['report.summary'] }), step('docs')] };

async function completedWorkflow(dir: string): Promise<string> {
  const port = new FakeExecutionPort();
  const r = await WorkflowEngine.create({ aiBridgeDir: dir, port, pollIntervalMs: 5 }, DEF, {});
  assert.ok(r.ok);
  await r.engine.start();
  await r.engine.idle();
  assert.equal(r.engine.instance.state, 'COMPLETED');
  await r.engine.close();
  return r.engine.workflowId;
}

const timelineRows = (md: string) => md.split('\n').filter((l) => /^\| \d+ \|/.test(l));

test('end to end: step 1 → execution → AI_ATTESTED → step 2 → COMPLETED is journaled from the log', () =>
  withProject(async (dir) => {
    const id = await completedWorkflow(dir);
    const r = await writeWorkflowJournal(dir, id);
    assert.ok(r.ok);
    const md = await readFile(r.path, 'utf8');
    assert.equal(md, r.markdown);
    assert.equal(r.path, path.join(dir, 'workflows', 'instances', id, 'workflow.md'));
    for (const s of [id, 'journal-flow v1', `\`${id}/build/1\``, `\`${id}/docs/1\``, '`2026-10-01_001`', '`2026-10-01_002`', '| State | COMPLETED |', 'ALL_STEPS_PASSED']) assert.ok(md.includes(s), s);
    assert.match(md, /AI_ATTESTED \(OutcomeOnly: the execution claimed DONE; not deterministically checked\)/);
    assert.doesNotMatch(md, /\bVERIFIED\b/, 'AI_ATTESTED is never rendered as VERIFIED');
    assert.match(md, /\[attempts\/build-1\/task\.md\]\(attempts\/build-1\/task\.md\)/);
  }));

test('chronology: every persisted event appears exactly once, in seq order', () =>
  withProject(async (dir) => {
    const id = await completedWorkflow(dir);
    const r = await writeWorkflowJournal(dir, id);
    assert.ok(r.ok);
    const events = (await readFile(path.join(dir, 'workflows', 'instances', id, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const rows = timelineRows(r.markdown);
    assert.equal(rows.length, events.length);
    assert.deepEqual(rows.map((l) => Number(l.split('|')[1])), events.map((e) => e.seq));
    rows.forEach((row, i) => assert.ok(row.includes(`| ${events[i].type} |`)));
  }));

test('determinism + idempotency: identical bytes every time; the log, snapshot and definition are never touched', () =>
  withProject(async (dir) => {
    const id = await completedWorkflow(dir);
    const inst = path.join(dir, 'workflows', 'instances', id);
    const files = ['events.jsonl', 'instance.json', 'definition.json'];
    const before = await Promise.all(files.map((f) => readFile(path.join(inst, f))));
    const a = await writeWorkflowJournal(dir, id);
    const b = await writeWorkflowJournal(dir, id);
    const c = await writeWorkflowJournal(dir, id);
    assert.ok(a.ok && b.ok && c.ok);
    assert.deepEqual([a.written, b.written, c.written], [true, false, false]);
    assert.equal(a.markdown, b.markdown);
    assert.equal(b.markdown, c.markdown);
    const after = await Promise.all(files.map((f) => readFile(path.join(inst, f))));
    after.forEach((buf, i) => assert.ok(buf.equals(before[i]), files[i]));

    // The same persisted data copied elsewhere renders the same bytes (no clock, no paths, no env).
    const other = path.join(path.dirname(dir), 'copy', '.ai-bridge');
    await mkdir(path.join(other, 'workflows', 'instances'), { recursive: true });
    await cp(inst, path.join(other, 'workflows', 'instances', id), { recursive: true });
    const d = await writeWorkflowJournal(other, id);
    assert.ok(d.ok);
    assert.equal(d.markdown, a.markdown);
  }));

test('execution links: an existing session.md is linked; a missing one is UNKNOWN, never fabricated', () =>
  withProject(async (dir) => {
    const id = await completedWorkflow(dir);
    await mkdir(path.join(dir, 'sessions', '2026-10-01_001'), { recursive: true });
    await writeFile(path.join(dir, 'sessions', '2026-10-01_001', 'session.md'), '# s', 'utf8');
    const r = await writeWorkflowJournal(dir, id);
    assert.ok(r.ok);
    assert.match(r.markdown, /\[session\.md\]\(\.\.\/\.\.\/\.\.\/sessions\/2026-10-01_001\/session\.md\)/);
    assert.match(r.markdown, /Execution journal: UNKNOWN \(no session\.md for `2026-10-01_002`\)/);
    assert.doesNotMatch(r.markdown, /final-report\.md\]/);
  }));

test('UNKNOWN: a CREATED workflow shows UNKNOWN for what does not exist yet, and infers nothing', () =>
  withProject(async (dir) => {
    const r0 = await WorkflowEngine.create({ aiBridgeDir: dir, port: new FakeExecutionPort() }, DEF, {});
    assert.ok(r0.ok);
    await r0.engine.close();
    const r = await writeWorkflowJournal(dir, r0.engine.workflowId);
    assert.ok(r.ok);
    for (const s of ['| Started | UNKNOWN |', '| Ended | UNKNOWN |', '| Terminal reason | UNKNOWN |', '| Evidence level | UNKNOWN |', '- Attempts: none']) assert.ok(r.markdown.includes(s), s);
    assert.equal(timelineRows(r.markdown).length, 1);
  }));

test('unknown token usage, host pid, verdict and task render UNKNOWN', () => {
  const s = new Sim(definition(['build']));
  s.feed({ type: 'START', at: at(1) });
  s.runExecution(ended('2026-10-01_009', 'DONE', { reportedTokens: null }), 2);
  const md = renderWorkflowJournal({ definition: s.def, instance: s.instance, events: sealEvents(WF, { seq: 0, hash: null }, s.events), executions: new Map(), taskFiles: new Set(), repairPending: false });
  assert.match(md, /host pid: UNKNOWN/);
  assert.match(md, /reported tokens: UNKNOWN \(a segment reported no usage; 0 reported by the others\)/);
  assert.match(md, /Verification: UNKNOWN/, 'still VERIFYING: no verdict yet');
  assert.match(md, /Task sent: UNKNOWN/);
});

test('every declared event type renders a non-empty row — none silently disappears; order is by seq', () => {
  const drafts: WorkflowEventDraft[] = WORKFLOW_EVENT_TYPES.map((type) => ({ type, timestamp: at(1), stepId: null, attemptId: null, executionId: null, actor: 'workflow-engine', provider: null, payload: {}, artifacts: [] }));
  const events = sealEvents(WF, { seq: 0, hash: null }, drafts);
  for (const e of events) assert.ok(describeEvent(e).length > 0, e.type);
  const s = new Sim(definition(['build']));
  const md = renderWorkflowJournal({ definition: s.def, instance: s.instance, events: [...events].reverse(), executions: new Map(), taskFiles: new Set(), repairPending: false });
  const rows = timelineRows(md);
  assert.equal(rows.length, WORKFLOW_EVENT_TYPES.length);
  assert.deepEqual(rows.map((l) => Number(l.split('|')[1])), events.map((e) => e.seq), 'rendered by persisted seq, not array order');
  assert.match(md, /CHECK_COMPLETED \| .* event not produced by M5; payload \{\}/);
});

test('recovery is auditable: NOT_STARTED, HOST_FAILED, WATCH, RESUME, UNRESOLVABLE and WAITING_HUMAN in order', () => {
  const s = new Sim(definition(['build']));
  s.feed({ type: 'START', at: at(1) });
  const id = s.attempt().attemptId;
  s.feed({ type: 'RECONCILED', at: at(2), attemptId: id, finding: { kind: 'NOT_STARTED' } });
  s.feed({ type: 'EXECUTION_LINKED', at: at(3), attemptId: id, executionId: 'r1' });
  s.feed({ type: 'EXECUTION_ENDED', at: at(4), attemptId: id, result: { kind: 'HOST_FAILED', executionId: 'r1' } });
  s.feed({ type: 'RECONCILED', at: at(5), attemptId: id, finding: { kind: 'WATCH', executionId: 'r1' } });
  s.feed({ type: 'RECONCILED', at: at(6), attemptId: id, finding: { kind: 'RESUME', executionId: 'r1' } });
  s.feed({ type: 'RECONCILED', at: at(7), attemptId: id, finding: { kind: 'UNRESOLVABLE', reason: 'EXECUTION_NOT_RECOVERABLE' } });
  const md = renderWorkflowJournal({ definition: s.def, instance: s.instance, events: sealEvents(WF, { seq: 0, hash: null }, s.events), executions: new Map(), taskFiles: new Set(), repairPending: false });
  const section = md.slice(md.indexOf('## Recovery and decisions'), md.indexOf('## Timeline'));
  let from = 0;
  for (const needle of ['finding NOT_STARTED', 'HOST_FAILED, execution r1', 'finding WATCH for execution r1', 'finding RESUME for execution r1', 'finding UNRESOLVABLE (EXECUTION_NOT_RECOVERABLE)', 'a human decision is needed: EXECUTION_NOT_RECOVERABLE']) {
    const i = section.indexOf(needle, from);
    assert.ok(i >= from, `${needle} missing or out of order`);
    from = i;
  }
  assert.match(md, /\| State \| WAITING_HUMAN \|/);
  assert.match(md, /Waiting for \| HUMAN: EXECUTION_NOT_RECOVERABLE; options fail, stop/);
  assert.match(md, /launch 2 requested/, 'the relaunch after NOT_STARTED is visible');
});

test('a real crash + re-host is journaled with its reconciliation decision in chronological position', () =>
  withProject(async (dir) => {
    const a = new FakeExecutionPort();
    a.behave = async () => hang();
    const deps = { aiBridgeDir: dir, pollIntervalMs: 5, preflightGraceMs: 0, isPidAlive: () => false };
    const r = await WorkflowEngine.create({ ...deps, port: a }, DEF, {});
    assert.ok(r.ok);
    await r.engine.start();
    r.engine.abandon();
    await writeFile(workflowLockPath(dir), JSON.stringify({ pid: 2147483647 }), 'utf8');
    const b = await WorkflowEngine.open({ ...deps, port: new FakeExecutionPort() }, r.engine.workflowId);
    assert.ok(b.ok);
    await b.engine.idle();
    await b.engine.close();
    const j = await writeWorkflowJournal(dir, r.engine.workflowId);
    assert.ok(j.ok);
    const rows = timelineRows(j.markdown);
    const reconciled = rows.findIndex((l) => l.includes('| RECONCILED |') && l.includes('NOT_STARTED'));
    const relaunch = rows.findIndex((l) => l.includes('launch 2 requested'));
    assert.ok(reconciled > 0 && relaunch > reconciled, 'the NOT_STARTED decision precedes the relaunch');
    assert.match(j.markdown, /\| State \| COMPLETED \|/);
  }));

test('integrity: a tampered log produces no journal — only a BROKEN notice; nothing is repaired', () =>
  withProject(async (dir) => {
    const id = await completedWorkflow(dir);
    const events = path.join(dir, 'workflows', 'instances', id, 'events.jsonl');
    const lines = (await readFile(events, 'utf8')).split('\n');
    lines[3] = lines[3].replace('"actor":"workflow-engine"', '"actor":"host"');
    await writeFile(events, lines.join('\n'), 'utf8');
    const tampered = await readFile(events);
    const r = await writeWorkflowJournal(dir, id);
    assert.equal(!r.ok && r.code, 'BROKEN');
    const md = await readFile(path.join(dir, 'workflows', 'instances', id, 'workflow.md'), 'utf8');
    assert.match(md, /\*\*INTEGRITY BROKEN\*\*/);
    assert.doesNotMatch(md, /## Timeline|COMPLETED/);
    assert.ok((await readFile(events)).equals(tampered), 'the log was not repaired');
  }));

test('a torn tail (repair pending) renders only the intact chain, flagged, without repairing the log', () =>
  withProject(async (dir) => {
    const id = await completedWorkflow(dir);
    const events = path.join(dir, 'workflows', 'instances', id, 'events.jsonl');
    await appendFile(events, '{"schema":1,"eventId":"torn', 'utf8');
    const torn = await readFile(events);
    const r = await writeWorkflowJournal(dir, id);
    assert.ok(r.ok);
    assert.equal(r.repairPending, true);
    assert.match(r.markdown, /REPAIR PENDING/);
    assert.ok((await readFile(events)).equals(torn));
  }));

test('unknown / invalid workflow ids are reported, not rendered', () =>
  withProject(async (dir) => {
    const bad = await writeWorkflowJournal(dir, '../../etc');
    assert.equal(!bad.ok && bad.code, 'INVALID_ID');
    const missing = await writeWorkflowJournal(dir, 'wf_2026-10-01_404');
    assert.equal(!missing.ok && missing.code, 'NOT_FOUND');
  }));
