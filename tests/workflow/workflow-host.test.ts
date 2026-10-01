import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeWorkflowJournal } from '../../src/core/workflow/journal.ts';
import { WorkflowStore } from '../../src/core/workflow/store.ts';
import type { WorkflowEvent } from '../../src/core/workflow/types.ts';
import { readWorkflowLockOwner, workflowLockPath } from '../../src/core/workflow/workflow-lock.ts';
import { controlDir, readHostedWorkflow, requestWorkflowControl } from '../../src/hosts/workflow-control-channel.ts';
import { WorkflowHost } from '../../src/hosts/workflow-host.ts';
import type { WorkflowHostCommand } from '../../src/hosts/workflow-host-protocol.ts';
import { FakeExecutionPort, hang, type FakeSession } from './fake-execution-port.ts';
import { DEAD_PID, aiBridgeOf, hostDefinition, hostDeps, needsHumanPort, runCommand, stoppablePort, until, withProject, writeDefinition } from './host-fixtures.ts';

// M5.8: the Workflow Host in-process over scripted ExecutionPorts — lifecycle, refusals, one
// host at a time, control (IPC-free and cross-process), rest-state commands, recovery through
// the M5.6 reconciler, and journal wiring. No process, no CLI, no quota.

const instanceDir = (p: string, id: string) => path.join(aiBridgeOf(p), 'workflows', 'instances', id);
const persisted = async (p: string, id: string): Promise<WorkflowEvent[]> =>
  (await readFile(path.join(instanceDir(p, id), 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as WorkflowEvent);
const exists = (p: string) => stat(p).then(() => true, () => false);
const timelineRows = (md: string) => md.split('\n').filter((l) => /^\| \d+ \|/.test(l));

async function hosted(p: string, port: FakeExecutionPort, hash: string) {
  const events: WorkflowEvent[] = [];
  const host = new WorkflowHost(hostDeps(p, port), (e) => events.push(e));
  const began = await host.begin(runCommand(p, hash));
  assert.ok(began.ok, JSON.stringify(began));
  return { host, events, workflowId: began.ok ? began.workflowId : '' };
}

async function refusal(p: string, command: WorkflowHostCommand, port = new FakeExecutionPort()): Promise<string> {
  const r = await new WorkflowHost(hostDeps(p, port)).begin(command);
  assert.equal(r.ok, false, JSON.stringify(r));
  return r.ok ? '' : r.error.code;
}

const atIteration1 = (host: WorkflowHost) => () => host.engine?.instance.steps[0].attempts[0]?.observedIteration === 1;

test('run: accepted → every persisted event forwarded once, in order → COMPLETED → lock and host record released; workflow.md current', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const { host, events, workflowId } = await hosted(p, new FakeExecutionPort(), hash);
    assert.deepEqual(await readHostedWorkflow(aiBridgeOf(p)), { pid: process.pid, workflowId });
    const end = await host.finished();
    assert.deepEqual(end, { workflowId, state: 'COMPLETED', reason: 'REST', errors: [] });

    const log = await persisted(p, workflowId);
    assert.deepEqual(events, log, 'forwarded = persisted, byte for byte after parsing, none missing or repeated');
    assert.equal(await readWorkflowLockOwner(aiBridgeOf(p)), null);
    assert.equal(await readHostedWorkflow(aiBridgeOf(p)), null);
    assert.equal(await exists(path.join(aiBridgeOf(p), 'state', 'workflow-host.json')), false);

    const md = await readFile(path.join(instanceDir(p, workflowId), 'workflow.md'), 'utf8');
    const fresh = await writeWorkflowJournal(aiBridgeOf(p), workflowId);
    assert.ok(fresh.ok);
    assert.equal(fresh.written, false, 'the host already wrote the journal of the final persisted state');
    assert.equal(md, fresh.markdown);
    assert.equal(timelineRows(md).length, log.length);
    assert.match(md, /\| State \| COMPLETED \|/);
  }));

test('journal wiring: workflow.md follows each persisted checkpoint while hosting — derived, never read back', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const port = stoppablePort();
    const { host, workflowId } = await hosted(p, port, hash);
    await until(atIteration1(host), 5000, 'iteration 1');
    await until(async () => timelineRows(await readFile(path.join(instanceDir(p, workflowId), 'workflow.md'), 'utf8')).length === (await persisted(p, workflowId)).length, 5000, 'journal catching up');
    const md = await readFile(path.join(instanceDir(p, workflowId), 'workflow.md'), 'utf8');
    assert.match(md, /\| State \| RUNNING \|/);
    assert.match(md, /EXECUTING/);
    // Tampering with the derived journal changes nothing the engine does.
    await writeFile(path.join(instanceDir(p, workflowId), 'workflow.md'), '# forged: COMPLETED\n', 'utf8');
    assert.equal((await host.control('stop')).ok, true);
    const end = await host.finished();
    assert.equal(end.state, 'STOPPED');
    const after = await readFile(path.join(instanceDir(p, workflowId), 'workflow.md'), 'utf8');
    assert.match(after, /\| State \| STOPPED \|/, 'rebuilt from the log, the forged file ignored');
  }));

test('refusals leave nothing behind: invalid command, missing/changed definition, bad inputs, an ordinary run in the way', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p, hostDefinition({ inputs: { feature: { type: 'string', required: true, maxLength: 50 } } }));
    const inputs = { feature: 'x' };
    assert.equal(await refusal(p, { ...runCommand(p, hash, inputs), type: 'exec' } as unknown as WorkflowHostCommand), 'INVALID_REQUEST');
    assert.equal(await refusal(p, runCommand(p, hash, inputs, 'no-such-flow')), 'DEFINITION_NOT_FOUND');
    assert.equal(await refusal(p, runCommand(p, 'b'.repeat(64), inputs)), 'DEFINITION_CHANGED');
    const badInputs = await new WorkflowHost(hostDeps(p, new FakeExecutionPort())).begin(runCommand(p, hash, {}));
    assert.equal(!badInputs.ok && badInputs.error.code, 'INPUTS_INVALID');
    assert.ok(!badInputs.ok && (badInputs.error.details ?? []).length > 0, 'names the missing input');

    const running = new FakeExecutionPort();
    running.statusValue = { runId: '2026-10-01_009', status: 'RUNNING', iteration: 1, claudePid: null, codexPid: null };
    assert.equal(await refusal(p, runCommand(p, hash, inputs), running), 'RUN_ACTIVE');
    const paused = new FakeExecutionPort();
    paused.statusValue = { ...running.statusValue, status: 'PAUSED' };
    assert.equal(await refusal(p, runCommand(p, hash, inputs), paused), 'RUN_UNFINISHED');
    const interrupted = new FakeExecutionPort();
    interrupted.statusValue = { ...running.statusValue, status: 'INTERRUPTED' };
    interrupted.recoverable = true;
    assert.equal(await refusal(p, runCommand(p, hash, inputs), interrupted), 'RUN_UNFINISHED');

    assert.deepEqual(await new WorkflowStore(aiBridgeOf(p)).list(), [], 'no instance was created');
    assert.equal(await readWorkflowLockOwner(aiBridgeOf(p)), null, 'no lock left behind');
    const ok = new WorkflowHost(hostDeps(p, new FakeExecutionPort()));
    assert.ok((await ok.begin(runCommand(p, hash, inputs))).ok, 'a valid run still starts afterwards');
    assert.equal((await ok.finished()).state, 'COMPLETED');
  }));

test('one Workflow Host at a time: concurrent starts, a second host and a re-host of the hosted workflow are refused', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const hosts = [new WorkflowHost(hostDeps(p, stoppablePort())), new WorkflowHost(hostDeps(p, stoppablePort()))];
    const results = await Promise.all(hosts.map((h) => h.begin(runCommand(p, hash))));
    assert.deepEqual(results.map((r) => r.ok).sort(), [false, true], 'exactly one concurrent start wins');
    const loser = results.find((r) => !r.ok);
    assert.equal(loser && !loser.ok && loser.error.code, 'WORKFLOW_LOCKED');
    const winner = hosts[results.findIndex((r) => r.ok)];
    const workflowId = winner.workflowId!;

    assert.equal(await refusal(p, runCommand(p, hash)), 'WORKFLOW_LOCKED');
    assert.equal(await refusal(p, { type: 'resume', projectPath: p, workflowId }), 'WORKFLOW_LOCKED');
    assert.equal((await new WorkflowStore(aiBridgeOf(p)).list()).length, 1, 'exactly one instance');

    assert.deepEqual(await winner.control('stop'), { ok: true, state: 'RUNNING' }, 'stop accepted; the execution is being stopped');
    assert.equal((await winner.finished()).state, 'STOPPED');
    assert.equal(await readWorkflowLockOwner(aiBridgeOf(p)), null);
  }));

test('control channel: another process pauses the hosted workflow; wrong id NOT_HOSTED; no host HOST_UNAVAILABLE; no files left', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const dir = aiBridgeOf(p);
    const none = await requestWorkflowControl(dir, 'wf_2026-10-01_001', 'pause');
    assert.equal(!none.ok && none.error.code, 'HOST_UNAVAILABLE');

    const port = stoppablePort();
    const { host, workflowId } = await hosted(p, port, hash);
    await until(atIteration1(host), 5000, 'iteration 1');
    const wrong = await requestWorkflowControl(dir, 'wf_1999-01-01_001', 'pause', { pollMs: 5 });
    assert.equal(!wrong.ok && wrong.error.code, 'NOT_HOSTED');
    assert.deepEqual(await requestWorkflowControl(dir, workflowId, 'pause', { pollMs: 5 }), { ok: true, state: 'RUNNING' });
    const again = await requestWorkflowControl(dir, workflowId, 'pause', { pollMs: 5 });
    assert.equal(!again.ok && again.error.code, 'NOT_ALLOWED', 'the engine refuses a second pause — reported, not invented');
    assert.deepEqual(await host.finished(), { workflowId, state: 'PAUSED', reason: 'REST', errors: [] });
    assert.equal(port.pauseCalls, 1);
    assert.deepEqual(await readdir(controlDir(dir)), [], 'every request and result was consumed');
    const gone = await requestWorkflowControl(dir, workflowId, 'stop');
    assert.equal(!gone.ok && gone.error.code, 'HOST_UNAVAILABLE');
  }));

test('at rest nothing is hosted: resume / stop / answer re-host the instance just for that; refused commands open nothing', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const dir = aiBridgeOf(p);

    // PAUSED → resume (a clean re-open: nothing to repair or reconcile) → COMPLETED
    const a = await hosted(p, stoppablePort(), hash);
    await until(atIteration1(a.host), 5000, 'iteration 1');
    await a.host.control('pause');
    assert.equal((await a.host.finished()).state, 'PAUSED');
    const events: WorkflowEvent[] = [];
    const resumer = new WorkflowHost(hostDeps(p, new FakeExecutionPort()), (e) => events.push(e));
    assert.ok((await resumer.begin({ type: 'resume', projectPath: p, workflowId: a.workflowId })).ok);
    assert.equal((await resumer.finished()).state, 'COMPLETED');
    assert.ok(events.length > 0 && events.every((e) => e.type !== 'RECONCILED'), 'a clean re-open forwards the new events only, and repairs nothing');
    assert.equal(events[0].seq, (await persisted(p, a.workflowId)).length - events.length + 1);

    for (const command of [{ type: 'resume' }, { type: 'stop' }, { type: 'answer', answer: 'fail' }] as const) {
      assert.equal(await refusal(p, { ...command, projectPath: p, workflowId: a.workflowId } as WorkflowHostCommand), 'NOT_ALLOWED', `${command.type} of a COMPLETED workflow`);
    }
    assert.equal(await readWorkflowLockOwner(dir), null, 'refused before the engine (and its lock) was ever opened');
    assert.equal(await refusal(p, { type: 'resume', projectPath: p, workflowId: 'wf_2026-01-01_404' }), 'WORKFLOW_NOT_FOUND');

    // PAUSED → stop → STOPPED
    const b = await hosted(p, stoppablePort(), hash);
    await until(atIteration1(b.host), 5000, 'iteration 1');
    await b.host.control('pause');
    await b.host.finished();
    const stopper = new WorkflowHost(hostDeps(p, new FakeExecutionPort()));
    assert.ok((await stopper.begin({ type: 'stop', projectPath: p, workflowId: b.workflowId })).ok);
    assert.equal((await stopper.finished()).state, 'STOPPED');

    // WAITING_HUMAN → resume refused → answer fail → FAILED
    const c = await hosted(p, needsHumanPort(), hash);
    assert.equal((await c.host.finished()).state, 'WAITING_HUMAN');
    assert.equal(await refusal(p, { type: 'resume', projectPath: p, workflowId: c.workflowId }), 'NOT_ALLOWED');
    const answerer = new WorkflowHost(hostDeps(p, new FakeExecutionPort()));
    assert.ok((await answerer.begin({ type: 'answer', projectPath: p, workflowId: c.workflowId, answer: 'fail' })).ok);
    assert.equal((await answerer.finished()).state, 'FAILED');
  }));

// ---------------------------------------------------------------------------
// recovery: a Workflow Host crash (abandon + stale lock), then `resume` re-hosts through M5.6
// ---------------------------------------------------------------------------

const RUN = '2026-10-01_007';
const session = (o: Partial<FakeSession> & { correlation: string | null }): FakeSession => ({ runId: RUN, startedAt: '2999-01-01T00:00:00.000Z', status: 'DONE', iterations: 1, errorCode: null, ...o });
const startedThenHang: FakeExecutionPort['behave'] = async (call) => {
  call.emit({ event: 'RUN_STARTED', runId: RUN, iteration: 0 });
  return hang();
};
const linked = (h: WorkflowHost) => h.engine?.instance.steps[0].attempts[0]?.state === 'EXECUTING';
const launching = (h: WorkflowHost) => h.engine?.instance.steps[0].attempts[0]?.state === 'LAUNCHING';

async function crashedHost(p: string, behave: FakeExecutionPort['behave'], ready: (h: WorkflowHost) => boolean, afterStart?: (h: WorkflowHost) => Promise<void>) {
  const hash = await writeDefinition(p);
  const port = new FakeExecutionPort();
  port.behave = behave;
  const { host, workflowId } = await hosted(p, port, hash);
  await afterStart?.(host);
  await until(() => ready(host), 5000, 'the crash point');
  const attemptId = host.engine!.instance.steps[0].attempts[0].attemptId;
  host.abandon(); // the process "dies": lock and host record left behind
  await writeFile(workflowLockPath(aiBridgeOf(p)), JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
  return { workflowId, attemptId };
}

async function rehost(p: string, workflowId: string, port: FakeExecutionPort) {
  const events: WorkflowEvent[] = [];
  const host = new WorkflowHost(hostDeps(p, port), (e) => events.push(e));
  const began = await host.begin({ type: 'resume', projectPath: p, workflowId });
  assert.ok(began.ok, JSON.stringify(began));
  return { end: await host.finished(), events };
}

test('recovery — stale lock, attempt LAUNCHING, proven NOT_STARTED: the SAME attempt is launched once; the finding is forwarded and journaled', () =>
  withProject(async (p) => {
    const { workflowId, attemptId } = await crashedHost(p, async () => hang(), launching);
    assert.equal(await readHostedWorkflow(aiBridgeOf(p)), null, 'a dead lock holder hosts nothing');
    const b = new FakeExecutionPort();
    const { end, events } = await rehost(p, workflowId, b);
    assert.equal(end.state, 'COMPLETED');
    assert.deepEqual(b.starts.map((s) => s.attemptId), [attemptId, `${workflowId}/docs/1`], 'step 1 relaunched once (same attempt), then step 2');
    assert.ok(events.some((e) => e.type === 'RECONCILED'), 'the reconciliation decision reaches the caller');
    const md = await readFile(path.join(instanceDir(p, workflowId), 'workflow.md'), 'utf8');
    assert.match(md, /reconciliation finding NOT_STARTED/);
  }));

test('recovery — execution still running elsewhere (WATCH), then finished: its outcome is adopted, step 1 never re-run', () =>
  withProject(async (p) => {
    const { workflowId, attemptId } = await crashedHost(p, startedThenHang, linked);
    const b = new FakeExecutionPort();
    b.statusValue = { runId: RUN, status: 'RUNNING', iteration: 1, claudePid: null, codexPid: null };
    b.sessions = [session({ correlation: attemptId, status: 'RUNNING' })];
    let polls = 0;
    const status = b.status.bind(b);
    b.status = async () => {
      if (++polls === 4) {
        b.statusValue = { ...b.statusValue, status: 'DONE' };
        b.sessions[0].status = 'DONE';
      }
      return status();
    };
    const { end } = await rehost(p, workflowId, b);
    assert.equal(end.state, 'COMPLETED');
    assert.deepEqual(b.starts.map((s) => s.attemptId), [`${workflowId}/docs/1`]);
    assert.deepEqual(b.resumes, []);
  }));

test('recovery — execution completed before the restart (ADOPT): nothing re-run', () =>
  withProject(async (p) => {
    const { workflowId, attemptId } = await crashedHost(p, startedThenHang, linked);
    const b = new FakeExecutionPort();
    b.statusValue = { runId: RUN, status: 'DONE', iteration: 1, claudePid: null, codexPid: null };
    b.sessions = [session({ correlation: attemptId })];
    const { end } = await rehost(p, workflowId, b);
    assert.equal(end.state, 'COMPLETED');
    assert.deepEqual(b.starts.map((s) => s.attemptId), [`${workflowId}/docs/1`]);
  }));

test('recovery — execution interrupted and RECOVERABLE (RESUME): the SAME execution is resumed', () =>
  withProject(async (p) => {
    const { workflowId, attemptId } = await crashedHost(p, startedThenHang, linked);
    const b = new FakeExecutionPort();
    b.statusValue = { runId: RUN, status: 'INTERRUPTED', iteration: 1, claudePid: 999, codexPid: null };
    b.recoverable = true;
    b.sessions = [session({ correlation: attemptId, status: 'INTERRUPTED' })];
    const { end } = await rehost(p, workflowId, b);
    assert.equal(end.state, 'COMPLETED');
    assert.deepEqual(b.resumes, [RUN]);
    assert.deepEqual(b.starts.map((s) => s.attemptId), [`${workflowId}/docs/1`]);
  }));

test('recovery — not recoverable: WAITING_HUMAN, nothing launched; the host rests and releases the lock', () =>
  withProject(async (p) => {
    const { workflowId, attemptId } = await crashedHost(p, startedThenHang, linked);
    const b = new FakeExecutionPort();
    b.statusValue = { runId: RUN, status: 'INTERRUPTED', iteration: 1, claudePid: null, codexPid: null };
    b.sessions = [session({ correlation: attemptId, status: 'INTERRUPTED' })];
    const { end } = await rehost(p, workflowId, b);
    assert.deepEqual(end, { workflowId, state: 'WAITING_HUMAN', reason: 'REST', errors: [] });
    assert.equal(b.calls.length, 0);
    assert.equal(await readWorkflowLockOwner(aiBridgeOf(p)), null);
  }));

test('recovery — a stop pending at the crash wins: STOPPED, never relaunched', () =>
  withProject(async (p) => {
    const { workflowId } = await crashedHost(p, async () => hang(), (h) => h.engine?.instance.stopRequested === 'USER', async (h) => void (await h.control('stop')));
    const b = new FakeExecutionPort();
    const { end } = await rehost(p, workflowId, b);
    assert.equal(end.state, 'STOPPED');
    assert.equal(b.starts.length, 0);
  }));
