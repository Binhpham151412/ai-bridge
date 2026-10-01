import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowEvent } from '../../src/core/workflow/types.ts';
import { forkChildHost } from '../../src/desktop/main/fork-run-host.ts';
import type { RunHostExit } from '../../src/desktop/main/run-controller.ts';
import { WorkflowController, type WorkflowEngineApi, type WorkflowHostProcess } from '../../src/desktop/main/workflow-controller.ts';
import type { WorkflowPanelSnapshot } from '../../src/desktop/shared/ipc-contract.ts';
import { WorkflowHost } from '../../src/hosts/workflow-host.ts';
import { FakeExecutionPort } from '../workflow/fake-execution-port.ts';
import { DEF_ID, aiBridgeOf, hostDefinition, hostDeps, runCommand, stoppablePort, until, withProject, writeDefinition } from '../workflow/host-fixtures.ts';

// M5.8: Main's WorkflowController — Main validates, forks at most one Workflow Host, relays
// typed commands/controls, publishes snapshots read from disk and the live events of its own
// host. A scripted host process covers the protocol edges; the real forked fake Workflow Host
// (tests/fixtures/workflow/fake-workflow-host.ts) covers the lifecycle end to end. No quota.

const HOST = fileURLToPath(new URL('../fixtures/workflow/fake-workflow-host.ts', import.meta.url));
const project = (p: string) => ({ path: p, name: path.basename(p) });
const idleEngine = (): WorkflowEngineApi => new FakeExecutionPort() as unknown as WorkflowEngineApi;

class ScriptedHost implements WorkflowHostProcess {
  readonly pid = 4242;
  readonly sent: unknown[] = [];
  readonly #onMessage: ((m: unknown) => void)[] = [];
  readonly #onExit: ((e: RunHostExit) => void)[] = [];
  readonly #script: (host: ScriptedHost, message: unknown) => void;
  constructor(script: (host: ScriptedHost, message: unknown) => void) {
    this.#script = script;
  }
  send(message: unknown): void {
    this.sent.push(message);
    queueMicrotask(() => this.#script(this, message));
  }
  onMessage(l: (m: unknown) => void): void {
    this.#onMessage.push(l);
  }
  onExit(l: (e: RunHostExit) => void): void {
    this.#onExit.push(l);
  }
  emit(m: unknown): void {
    for (const l of this.#onMessage) l(m);
  }
  exit(code: number, stderrTail = ''): void {
    for (const l of this.#onExit) l({ code, signal: null, stderrTail });
  }
}

function scripted(script: (host: ScriptedHost, message: unknown) => void, engine = idleEngine()) {
  const forks: ScriptedHost[] = [];
  const controller = new WorkflowController({ createEngine: () => engine, forkWorkflowHost: () => forks[forks.push(new ScriptedHost(script)) - 1], activePollMs: 20, idlePollMs: 1000 });
  return { controller, forks };
}

function real(env: () => Record<string, string>) {
  let forks = 0;
  const controller = new WorkflowController({
    createEngine: () => idleEngine(),
    forkWorkflowHost: () => {
      forks += 1;
      return forkChildHost({ scriptPath: HOST, execPath: process.execPath, env: { ...process.env, ...env() } });
    },
    activePollMs: 30,
    idlePollMs: 1000,
    controlTimeoutMs: 10_000,
  });
  const events: WorkflowEvent[] = [];
  controller.onEvent((e) => events.push(e));
  return { controller, events, forks: () => forks };
}

async function waitSnapshot(controller: WorkflowController, predicate: (s: WorkflowPanelSnapshot) => boolean, what: string, timeoutMs = 30_000): Promise<WorkflowPanelSnapshot> {
  const seen: { last: WorkflowPanelSnapshot | null } = { last: null };
  try {
    await until(async () => predicate((seen.last = await controller.getSnapshot())), timeoutMs, what);
  } catch (err) {
    throw new Error(`${(err as Error).message}; last: state=${seen.last?.workflow?.state} attached=${seen.last?.attached} error=${JSON.stringify(seen.last?.lastError)}`);
  }
  return seen.last!;
}

const WF = 'wf_2026-10-01_001';
const event = (seq: number) => ({ schema: 1, type: 'WORKFLOW_CREATED', workflowId: WF, seq, eventId: `${WF}#${seq}`, timestamp: 't', correlationId: WF, causationId: null, stepId: null, attemptId: null, executionId: null, actor: 'workflow-engine', provider: null, payload: {}, artifacts: [], prevHash: null, hash: 'h' });

// ---------------------------------------------------------------------------
// scripted host: the protocol edges
// ---------------------------------------------------------------------------

test('start: Main validates the definition hash, the inputs and availability first — a bad request never forks a host', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p, hostDefinition({ inputs: { feature: { type: 'string', required: true, maxLength: 10 } } }));
    const busy = new FakeExecutionPort();
    busy.statusValue = { runId: '2026-10-01_009', status: 'RUNNING', iteration: 1, claudePid: null, codexPid: null };
    const { controller, forks } = scripted(() => assert.fail('no host may be forked'), busy as unknown as WorkflowEngineApi);
    await controller.setProject(project(p));
    const code = async (req: Parameters<WorkflowController['start']>[0]) => {
      const r = await controller.start(req);
      return r.ok ? 'ok' : r.error.code;
    };
    assert.equal(await code({ definitionId: DEF_ID, definitionHash: 'f'.repeat(64), inputs: { feature: 'x' } }), 'DEFINITION_CHANGED');
    assert.equal(await code({ definitionId: 'no-such', definitionHash: hash, inputs: {} }), 'DEFINITION_NOT_FOUND');
    assert.equal(await code({ definitionId: DEF_ID, definitionHash: hash, inputs: {} }), 'INPUTS_INVALID');
    assert.equal(await code({ definitionId: DEF_ID, definitionHash: hash, inputs: { feature: 'far too long' } }), 'INPUTS_INVALID');
    assert.equal(await code({ definitionId: DEF_ID, definitionHash: hash, inputs: { feature: 'x' } }), 'RUN_ACTIVE', 'an ordinary run holds the project');
    assert.equal(forks.length, 0);
    const snap = await controller.getSnapshot();
    assert.equal(snap.canStartNew, false);
    assert.equal(snap.startBlockedBy?.code, 'RUN_ACTIVE');
    controller.dispose();
  }));

test('start → a typed run command → accepted → workflowId; only well-formed events are relayed; one host at a time', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const { controller, forks } = scripted((host, m) => {
      if ((m as { type?: string }).type !== 'run') return;
      host.emit({ type: 'accepted', workflowId: WF, state: 'RUNNING' });
      host.emit({ type: 'event', event: event(1) });
      host.emit({ type: 'event', event: { ...event(2), type: 'RUN_STARTED' } }); // malformed: never relayed
      host.emit('garbage');
    });
    const events: WorkflowEvent[] = [];
    controller.onEvent((e) => events.push(e));
    await controller.setProject(project(p));
    const r = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.deepEqual(r, { ok: true, data: { workflowId: WF } });
    assert.deepEqual(forks[0].sent, [{ type: 'run', projectPath: p, definitionId: DEF_ID, definitionHash: hash, inputs: {} }]);
    await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(events.map((e) => e.seq), [1]);
    assert.equal(controller.ownsHost(), true);
    assert.equal((await controller.getSnapshot()).attached, true);

    const second = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.equal(!second.ok && second.error.code, 'WORKFLOW_LOCKED');
    assert.equal(forks.length, 1, 'no duplicate host');
    forks[0].exit(0);
    assert.equal(controller.ownsHost(), false);
    assert.equal((await controller.getSnapshot()).attached, false);
    controller.dispose();
  }));

test('host failure: exit before accepting → HOST_UNAVAILABLE with the exit details; a refusal → its typed error; the next start forks afresh', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    let mode: 'die' | 'refuse' = 'die';
    const { controller, forks } = scripted((host) => {
      if (mode === 'die') host.exit(1, 'the host crashed: token sk-ant-api03-SECRETSECRETSECRETSECRET');
      else host.emit({ type: 'rejected', error: { code: 'WORKFLOW_ACTIVE', message: 'wf_2026-10-01_002 is RUNNING without a host' } });
    });
    await controller.setProject(project(p));
    const died = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.equal(!died.ok && died.error.code, 'HOST_UNAVAILABLE');
    assert.match((!died.ok && died.error.details) || '', /exit code: 1/);
    assert.doesNotMatch(JSON.stringify(died), /SECRETSECRET/, 'redacted before it reaches the renderer');
    assert.equal(controller.ownsHost(), false);
    mode = 'refuse';
    const refused = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.equal(!refused.ok && refused.error.code, 'WORKFLOW_ACTIVE');
    assert.equal(forks.length, 2);
    forks[1].exit(0);
    controller.dispose();
  }));

// ---------------------------------------------------------------------------
// real forked Workflow Host (scripted ExecutionPort inside it)
// ---------------------------------------------------------------------------

test('lifecycle: start → live events (each once, in order) → rest; list/get/events/attempt/journal read from disk', { timeout: 60_000 }, () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const { controller, events, forks } = real(() => ({ FAKE_WF_BEHAVE: 'done' }));
    await controller.setProject(project(p));
    const defs = await controller.listDefinitions();
    assert.ok(defs.ok);
    assert.deepEqual(defs.data.map((d) => [d.definitionId, d.valid, d.definitionHash]), [[DEF_ID, true, hash]]);
    const started = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.ok(started.ok, JSON.stringify(started));
    const id = started.data.workflowId;
    const done = await waitSnapshot(controller, (s) => s.workflow?.state === 'COMPLETED' && !s.attached, 'COMPLETED and detached');
    assert.equal(done.workflow?.workflowId, id);
    assert.equal(done.workflow?.evidenceLevel, 'AI_ATTESTED');
    assert.equal(done.canStartNew, true);
    assert.equal(forks(), 1);

    const log = (await readFile(path.join(aiBridgeOf(p), 'workflows', 'instances', id, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as WorkflowEvent);
    assert.deepEqual(events.map((e) => e.seq), log.map((e) => e.seq), 'every persisted event relayed once, in order');

    const list = await controller.list();
    assert.ok(list.ok);
    assert.deepEqual(list.data.map((w) => [w.workflowId, w.state, w.integrity]), [[id, 'COMPLETED', 'OK']]);
    const page = await controller.getEvents({ workflowId: id, afterSeq: 2, limit: 3 });
    assert.ok(page.ok);
    assert.deepEqual(page.data.map((e) => e.seq), [3, 4, 5]);
    const attempt = await controller.getAttempt({ attemptId: `${id}/build/1` });
    assert.ok(attempt.ok);
    assert.equal(attempt.data.attempt.state, 'PASSED');
    assert.match(attempt.data.task ?? '', /Do the build work\./);
    const journal = await controller.getJournal({ workflowId: id });
    assert.ok(journal.ok);
    assert.match(journal.data.markdown, /\| State \| COMPLETED \|/);
    const missing = await controller.get({ workflowId: 'wf_2026-01-01_404' });
    assert.equal(!missing.ok && missing.error.code, 'WORKFLOW_NOT_FOUND');
    controller.dispose();
  }));

test('controls follow Core: pause/stop go to the own host over IPC; resume forks a new host; nothing is allowed that Core does not allow', { timeout: 60_000 }, () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const { controller, forks } = real(() => ({ FAKE_WF_BEHAVE: 'stoppable' }));
    await controller.setProject(project(p));
    const started = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.ok(started.ok);
    const id = started.data.workflowId;
    await waitSnapshot(controller, (s) => s.workflow?.steps[0].current?.state === 'EXECUTING' && s.workflow.controls.canPause, 'EXECUTING');
    const early = await controller.resume({ workflowId: id });
    assert.equal(!early.ok && early.error.code, 'NOT_ALLOWED', 'RUNNING in its host: resume is not offered');
    assert.equal((await controller.pause({ workflowId: id })).ok, true);
    await waitSnapshot(controller, (s) => s.workflow?.state === 'PAUSED' && !s.attached, 'PAUSED at rest');
    const again = await controller.pause({ workflowId: id });
    assert.equal(!again.ok && again.error.code, 'NOT_ALLOWED');

    assert.equal((await controller.resume({ workflowId: id })).ok, true);
    assert.equal(forks(), 2);
    await waitSnapshot(controller, (s) => s.workflow?.steps[1].current?.state === 'EXECUTING' && s.attached, 'step 2 executing');
    assert.equal((await controller.stop({ workflowId: id })).ok, true);
    const stopped = await waitSnapshot(controller, (s) => s.workflow?.state === 'STOPPED' && !s.attached, 'STOPPED');
    assert.deepEqual(stopped.workflow?.controls, { canStart: false, canPause: false, canResume: false, canStop: false, canAnswer: [] });
    assert.equal(forks(), 2);
    controller.dispose();
  }));

test('WAITING_HUMAN: answers are checked against Core’s canAnswer, then a host is forked just for the answer', { timeout: 60_000 }, () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const { controller, forks } = real(() => ({ FAKE_WF_BEHAVE: 'needs-human' }));
    await controller.setProject(project(p));
    const started = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.ok(started.ok);
    const id = started.data.workflowId;
    const waiting = await waitSnapshot(controller, (s) => s.workflow?.state === 'WAITING_HUMAN' && !s.attached, 'WAITING_HUMAN');
    assert.deepEqual(waiting.workflow?.controls.canAnswer, ['fail', 'stop']);
    assert.equal((await controller.pause({ workflowId: id })).ok, false);
    assert.equal(forks(), 1);
    assert.equal((await controller.answer({ workflowId: id, answer: 'fail' })).ok, true);
    const failed = await waitSnapshot(controller, (s) => s.workflow?.state === 'FAILED' && !s.attached, 'FAILED');
    assert.equal(failed.workflow?.terminalReason, 'HUMAN_MARKED_FAILED');
    assert.equal(forks(), 2);
    controller.dispose();
  }));

test('detached / reconnect: a workflow hosted by another process is followed, not attached; start is refused; stop travels the control channel', { timeout: 60_000 }, () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const elsewhere = new WorkflowHost(hostDeps(p, stoppablePort()));
    const began = await elsewhere.begin(runCommand(p, hash));
    assert.ok(began.ok);
    const id = began.ok ? began.workflowId : '';
    await until(() => elsewhere.engine?.instance.steps[0].attempts[0]?.observedIteration === 1, 5000, 'iteration 1');

    const { controller, forks } = real(() => ({}));
    await controller.setProject(project(p)); // e.g. the app restarted while the workflow kept running
    const snap = await controller.getSnapshot();
    assert.equal(snap.workflow?.workflowId, id);
    assert.equal(snap.workflow?.displayState, 'RUNNING');
    assert.equal(snap.attached, false);
    assert.deepEqual(snap.activity, { hostPid: process.pid, hostedWorkflowId: id, running: [id] });
    assert.equal(snap.canStartNew, false);
    assert.equal(snap.startBlockedBy?.code, 'WORKFLOW_LOCKED');
    const refused = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.equal(!refused.ok && refused.error.code, 'WORKFLOW_LOCKED');

    assert.equal((await controller.stop({ workflowId: id })).ok, true, 'delivered to the other host');
    assert.equal((await elsewhere.finished()).state, 'STOPPED');
    const after = await waitSnapshot(controller, (s) => s.workflow?.state === 'STOPPED', 'STOPPED');
    assert.equal(after.canStartNew, true);
    assert.equal(forks(), 0, 'no second Workflow Host was ever started');
    controller.dispose();
  }));

test('M5.8.1 normal quit: stopOwnedHost() STOPs the workflow this app hosts and waits for its host to end', { timeout: 60_000 }, () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const { controller } = real(() => ({ FAKE_WF_BEHAVE: 'stoppable' }));
    await controller.setProject(project(p));
    assert.equal(await controller.stopOwnedHost(), true, 'nothing owned: nothing to stop');
    const started = await controller.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
    assert.ok(started.ok);
    await waitSnapshot(controller, (s) => s.workflow?.steps[0].current?.state === 'EXECUTING', 'EXECUTING');
    assert.equal(await controller.stopOwnedHost(10_000), true);
    assert.equal(controller.ownsHost(), false);
    const stopped = await waitSnapshot(controller, (s) => s.workflow?.state === 'STOPPED', 'STOPPED');
    assert.equal(stopped.workflow?.terminalReason, 'STOPPED_BY_USER');
    controller.dispose();
  }));
