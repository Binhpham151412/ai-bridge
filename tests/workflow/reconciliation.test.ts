import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowEngine, type WorkflowEngineDeps } from '../../src/core/workflow/engine.ts';
import { reconcileAttempt, type ReconcileFacts } from '../../src/core/workflow/reconciler.ts';
import { deriveWorkflowDisplayState } from '../../src/core/workflow/controls.ts';
import { readWorkflowLockOwner, workflowLockPath } from '../../src/core/workflow/workflow-lock.ts';
import type { WorkflowAttempt } from '../../src/core/workflow/types.ts';
import { FakeExecutionPort, hang, type FakeSession } from './fake-execution-port.ts';
import { step } from './definition-fixtures.ts';

// M5.6: reconciliation after a Workflow Host crash / host failure. A "crash" = the engine is
// abandoned (background work stops, lock not released) and its lock is made stale (dead
// pid); a new engine then re-hosts the instance against a fresh port with scripted facts.

const DEAD_PID = 2147483647;
const RUN = '2026-10-01_007';
const DEF = { schema: 1, id: 'recover-flow', version: 1, title: 'Recover', steps: [step('build')] };

async function withProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-reconcile-'));
  try {
    return await fn(path.join(root, '.ai-bridge'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const deps = (dir: string, port: FakeExecutionPort, o: Partial<WorkflowEngineDeps> = {}): WorkflowEngineDeps => ({ aiBridgeDir: dir, port, pollIntervalMs: 5, preflightGraceMs: 0, isPidAlive: () => false, ...o });

/** Runs until `ready` on port A, then crashes the Workflow Host. Returns workflowId + attemptId. */
async function crashedWorkflow(dir: string, behave: FakeExecutionPort['behave'], ready: (e: WorkflowEngine) => boolean, afterStart?: (e: WorkflowEngine) => Promise<void>) {
  const a = new FakeExecutionPort();
  a.behave = behave;
  const r = await WorkflowEngine.create(deps(dir, a), DEF, {});
  assert.ok(r.ok);
  const engine = r.engine;
  await engine.start();
  await afterStart?.(engine);
  for (let i = 0; i < 500 && !ready(engine); i++) await new Promise((res) => setTimeout(res, 2));
  assert.ok(ready(engine), 'engine A did not reach the crash point');
  engine.abandon();
  await writeFile(workflowLockPath(dir), JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
  return { workflowId: engine.workflowId, attemptId: engine.instance.steps[0].attempts[0].attemptId, instance: engine.instance };
}

async function reopen(dir: string, workflowId: string, port: FakeExecutionPort, o: Partial<WorkflowEngineDeps> = {}) {
  const r = await WorkflowEngine.open(deps(dir, port, o), workflowId);
  assert.equal(r.ok, true, JSON.stringify(!r.ok && r));
  if (!r.ok) throw new Error('unreachable');
  await r.engine.idle();
  return r.engine;
}

const linked = (e: WorkflowEngine) => e.instance.steps[0].attempts[0]?.state === 'EXECUTING';
const launching = (e: WorkflowEngine) => e.instance.steps[0].attempts[0]?.state === 'LAUNCHING';
const startedThenHang: FakeExecutionPort['behave'] = async (call) => {
  call.emit({ event: 'RUN_STARTED', runId: RUN, iteration: 0 });
  return hang();
};
const session = (o: Partial<FakeSession> & { correlation: string | null }): FakeSession => ({ runId: RUN, startedAt: '2999-01-01T00:00:00.000Z', status: 'DONE', iterations: 1, errorCode: null, ...o });

// ---------------------------------------------------------------------------
// pure reconciler
// ---------------------------------------------------------------------------

function facts(o: Partial<ReconcileFacts> = {}): ReconcileFacts {
  return { nowMs: Date.parse('2026-10-01T10:00:00.000Z'), preflightGraceMs: 60_000, current: { runId: null, status: 'NOT_STARTED' }, recoverable: false, sessions: [], hostAlive: null, cliAlive: false, ...o };
}
const attempt = (o: Partial<WorkflowAttempt>): WorkflowAttempt => ({ attemptId: 'wf_2026-10-01_001/build/1', stepId: 'build', attemptNo: 1, state: 'LAUNCHING', maxIterations: 10, maxIterationsClamped: false, executionId: null, plannedAt: '2026-10-01T09:00:00.000Z', launchedAt: '2026-10-01T09:00:00.000Z', endedAt: null, launches: 1, observedIteration: 0, iterationsUsed: 0, reportedTokens: 0, tokensIncomplete: false, lastOutcome: null, verification: null, stopCause: null, ...o });
const mine = (o: Partial<FakeSession> = {}) => ({ runId: RUN, startedAt: '2026-10-01T09:00:01.000Z', status: 'DONE', iterations: 3, errorCode: null, correlation: 'wf_2026-10-01_001/build/1', ...o });

test('reconciler: LAUNCHING — link our run, wait while a host may still start, prove NOT_STARTED, refuse duplicates', () => {
  assert.deepEqual(reconcileAttempt(attempt({}), facts({ sessions: [mine()] })), { action: 'LINK', executionId: RUN });
  assert.deepEqual(reconcileAttempt(attempt({}), facts({ sessions: [mine(), mine({ runId: 'x' })] })), { action: 'FINDING', finding: { kind: 'UNRESOLVABLE', reason: 'DUPLICATE_EXECUTIONS_FOR_ATTEMPT' } });
  assert.deepEqual(reconcileAttempt(attempt({}), facts({ hostAlive: true, nowMs: Date.parse('2026-10-01T09:00:30.000Z') })), { action: 'WAIT', reason: 'EXECUTION_HOST_STILL_STARTING' });
  assert.deepEqual(reconcileAttempt(attempt({}), facts({ hostAlive: true })), { action: 'FINDING', finding: { kind: 'UNRESOLVABLE', reason: 'EXECUTION_HOST_ALIVE_WITHOUT_SESSION' } });
  assert.deepEqual(reconcileAttempt(attempt({}), facts({ nowMs: Date.parse('2026-10-01T09:00:30.000Z') })), { action: 'WAIT', reason: 'LAUNCH_TOO_RECENT_TO_PROVE' });
  assert.deepEqual(reconcileAttempt(attempt({}), facts({ sessions: [mine({ correlation: 'wf_2026-10-01_009/other/1' }), mine({ correlation: null })] })), { action: 'FINDING', finding: { kind: 'NOT_STARTED' } }, 'runs of other attempts are not ours');
});

test('reconciler: EXECUTING — watch, adopt, resume, or hand to a human; never a new execution', () => {
  const ex = attempt({ state: 'EXECUTING', executionId: RUN, iterationsUsed: 1 });
  assert.deepEqual(reconcileAttempt(ex, facts({ sessions: [mine({ status: 'RUNNING' })], current: { runId: RUN, status: 'RUNNING' } })), { action: 'FINDING', finding: { kind: 'WATCH', executionId: RUN } });
  assert.deepEqual(reconcileAttempt(ex, facts({ sessions: [mine()] })), { action: 'ADOPT', result: { kind: 'ENDED', executionId: RUN, finalStatus: 'DONE', errorCode: null, iterations: 2, reportedTokens: null, usageLimitDetected: false } });
  const interrupted = { sessions: [mine({ status: 'INTERRUPTED' })], current: { runId: RUN, status: 'INTERRUPTED' } };
  assert.deepEqual(reconcileAttempt(ex, facts({ ...interrupted, recoverable: true })), { action: 'FINDING', finding: { kind: 'RESUME', executionId: RUN } });
  const reason = (f: ReconcileFacts) => {
    const a = reconcileAttempt(ex, f);
    return a.action === 'FINDING' && a.finding.kind === 'UNRESOLVABLE' ? a.finding.reason : a.action;
  };
  assert.equal(reason(facts(interrupted)), 'EXECUTION_NOT_RECOVERABLE');
  assert.equal(reason(facts({ ...interrupted, recoverable: true, cliAlive: true })), 'ORPHANED_CLI_PROCESS_ALIVE');
  assert.equal(reason(facts({ sessions: [mine({ correlation: 'wf_2026-10-01_001/other/1' })] })), 'CORRELATION_MISMATCH');
  assert.equal(reason(facts({ sessions: [mine({ correlation: null })] })), 'CORRELATION_MISMATCH');
  assert.equal(reason(facts({})), 'EXECUTION_NOT_FOUND');
  assert.equal(reconcileAttempt(attempt({ state: 'VERIFYING' }), facts()).action, 'NONE');
});

// ---------------------------------------------------------------------------
// crash scenarios through the engine
// ---------------------------------------------------------------------------

test('RUNNING on disk with a dead workflow-host lock is INTERRUPTED; re-hosting clears the stale lock', () =>
  withProject(async (dir) => {
    const { workflowId, instance } = await crashedWorkflow(dir, async () => hang(), launching);
    const owner = await readWorkflowLockOwner(dir);
    assert.equal(deriveWorkflowDisplayState(instance, owner !== null && owner.pid !== DEAD_PID), 'INTERRUPTED');
    const b = new FakeExecutionPort();
    const engine = await reopen(dir, workflowId, b);
    assert.equal((await readWorkflowLockOwner(dir))?.pid, process.pid);
    await engine.close();
  }));

test('crash after the START intent, before any host existed: proven NOT_STARTED → the SAME attempt is launched once', () =>
  withProject(async (dir) => {
    const { workflowId, attemptId } = await crashedWorkflow(dir, async () => hang(), launching);
    const b = new FakeExecutionPort();
    const engine = await reopen(dir, workflowId, b);
    assert.equal(engine.instance.state, 'COMPLETED');
    assert.deepEqual(b.starts.map((s) => s.attemptId), [attemptId]);
    assert.equal(engine.instance.steps[0].attempts.length, 1);
    assert.equal(engine.instance.steps[0].attempts[0].launches, 2);
    await engine.close();
  }));

test('crash while the Execution Host is alive but has no session yet: no relaunch (waits, then a human decides)', () =>
  withProject(async (dir) => {
    const { workflowId } = await crashedWorkflow(dir, async (call) => (call.spawn(4242), hang()), (e) => e.instance.steps[0].attempts[0]?.hostPid === 4242);
    const b = new FakeExecutionPort();
    let checks = 0;
    const engine = await reopen(dir, workflowId, b, { isPidAlive: (pid) => pid === 4242 && ++checks < 4, preflightGraceMs: 60 * 60 * 1000 });
    assert.ok(checks >= 4, 'it waited while the host was alive');
    assert.equal(engine.instance.state, 'COMPLETED', 'the host died without creating a session → proven not started');
    assert.equal(b.starts.length, 1);
    await engine.close();

    const { workflowId: w2 } = await crashedWorkflow(path.join(dir, 'x'), async (call) => (call.spawn(4242), hang()), (e) => e.instance.steps[0].attempts[0]?.hostPid === 4242);
    const c = new FakeExecutionPort();
    const e2 = await reopen(path.join(dir, 'x'), w2, c, { isPidAlive: () => true, preflightGraceMs: 0 });
    assert.equal(e2.instance.state, 'WAITING_HUMAN');
    assert.equal(e2.instance.waitingFor?.reason, 'EXECUTION_HOST_ALIVE_WITHOUT_SESSION');
    assert.equal(c.calls.length, 0);
    await e2.close();
  }));

test('crash after the execution started, execution still running elsewhere: watched, then its outcome adopted', () =>
  withProject(async (dir) => {
    const { workflowId, attemptId } = await crashedWorkflow(dir, startedThenHang, linked);
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
    const engine = await reopen(dir, workflowId, b);
    assert.equal(engine.instance.state, 'COMPLETED');
    assert.equal(b.calls.length, 0, 'no new execution, no resume');
    await engine.close();
  }));

test('crash before the outcome was persisted (execution already DONE, snapshot stale): outcome adopted, nothing re-run', () =>
  withProject(async (dir) => {
    const { workflowId, attemptId } = await crashedWorkflow(dir, startedThenHang, linked);
    const b = new FakeExecutionPort();
    b.statusValue = { runId: RUN, status: 'DONE', iteration: 1, claudePid: null, codexPid: null };
    b.sessions = [session({ correlation: attemptId })];
    const engine = await reopen(dir, workflowId, b);
    assert.equal(engine.instance.state, 'COMPLETED');
    assert.equal(b.calls.length, 0);
    await engine.close();
    const again = await reopen(dir, workflowId, b);
    assert.equal(b.calls.length, 0, 're-hosting a finished workflow does nothing');
    await again.close();
  }));

test('Execution Host died, execution RECOVERABLE: the SAME execution is resumed', () =>
  withProject(async (dir) => {
    const { workflowId, attemptId } = await crashedWorkflow(dir, startedThenHang, linked);
    const b = new FakeExecutionPort();
    b.statusValue = { runId: RUN, status: 'INTERRUPTED', iteration: 1, claudePid: 999, codexPid: null };
    b.recoverable = true;
    b.sessions = [session({ correlation: attemptId, status: 'INTERRUPTED' })];
    b.behave = async (call) => ({ kind: 'ENDED', executionId: call.executionId!, finalStatus: 'DONE', errorCode: null, iterations: 1, reportedTokens: 1, usageLimitDetected: false });
    const engine = await reopen(dir, workflowId, b);
    assert.equal(engine.instance.state, 'COMPLETED');
    assert.deepEqual(b.resumes, [RUN]);
    assert.equal(b.starts.length, 0);
    await engine.close();
  }));

test('non-recoverable execution, orphaned CLI, correlation mismatch, duplicates → WAITING_HUMAN, nothing launched', () =>
  withProject(async (dir) => {
    const cases: [string, (b: FakeExecutionPort, attemptId: string) => void, WorkflowEngineDeps['isPidAlive'], typeof linked][] = [
      ['EXECUTION_NOT_RECOVERABLE', (b, id) => ((b.statusValue = { runId: RUN, status: 'INTERRUPTED', iteration: 1, claudePid: null, codexPid: null }), (b.sessions = [session({ correlation: id, status: 'INTERRUPTED' })])), () => false, linked],
      ['ORPHANED_CLI_PROCESS_ALIVE', (b, id) => ((b.statusValue = { runId: RUN, status: 'INTERRUPTED', iteration: 1, claudePid: 777, codexPid: null }), (b.recoverable = true), (b.sessions = [session({ correlation: id, status: 'INTERRUPTED' })])), (pid) => pid === 777, linked],
      ['CORRELATION_MISMATCH', (b) => (b.sessions = [session({ correlation: 'wf_2026-10-01_099/build/1' })]), () => false, linked],
      ['DUPLICATE_EXECUTIONS_FOR_ATTEMPT', (b, id) => (b.sessions = [session({ correlation: id }), session({ runId: '2026-10-01_008', correlation: id })]), () => false, launching],
    ];
    for (const [reason, arrange, isPidAlive, ready] of cases) {
      const sub = path.join(dir, reason);
      await mkdir(sub, { recursive: true });
      const { workflowId, attemptId } = await crashedWorkflow(sub, ready === linked ? startedThenHang : async () => hang(), ready);
      const b = new FakeExecutionPort();
      arrange(b, attemptId);
      const engine = await reopen(sub, workflowId, b, { isPidAlive });
      assert.equal(engine.instance.state, 'WAITING_HUMAN', reason);
      assert.equal(engine.instance.waitingFor?.reason, reason);
      assert.equal(b.calls.length, 0, reason);
      assert.equal(engine.instance.steps[0].attempts.length, 1, reason);
      await engine.close();
    }
  }));

test('a foreign execution (another workflow/attempt) is never adopted; ours is proven not started', () =>
  withProject(async (dir) => {
    const { workflowId, attemptId } = await crashedWorkflow(dir, async () => hang(), launching);
    const b = new FakeExecutionPort();
    b.sessions = [session({ correlation: 'wf_2026-10-01_050/build/1' })];
    const engine = await reopen(dir, workflowId, b);
    assert.deepEqual(b.starts.map((s) => s.attemptId), [attemptId]);
    assert.equal(engine.instance.state, 'COMPLETED');
    await engine.close();
  }));

test('HOST_FAILED during a live run → reconcile → resume the same execution (no retry)', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    port.behave = async (call) => {
      if (call.kind === 'resume') return { kind: 'ENDED', executionId: call.executionId!, finalStatus: 'DONE', errorCode: null, iterations: 1, reportedTokens: 1, usageLimitDetected: false };
      call.emit({ event: 'RUN_STARTED', runId: RUN, iteration: 0 });
      port.statusValue = { runId: RUN, status: 'INTERRUPTED', iteration: 1, claudePid: null, codexPid: null };
      port.recoverable = true;
      port.sessions = [session({ correlation: call.request!.attemptId, status: 'INTERRUPTED' })];
      return { kind: 'HOST_FAILED', executionId: RUN };
    };
    const r = await WorkflowEngine.create(deps(dir, port), DEF, {});
    assert.ok(r.ok);
    await r.engine.start();
    await r.engine.idle();
    assert.equal(r.engine.instance.state, 'COMPLETED');
    assert.deepEqual(port.starts.length, 1);
    assert.deepEqual(port.resumes, [RUN]);
    await r.engine.close();
  }));

test('a stop pending at the crash wins: a not-started attempt ends STOPPED and is never relaunched', () =>
  withProject(async (dir) => {
    const { workflowId } = await crashedWorkflow(dir, async () => hang(), (e) => e.instance.stopRequested === 'USER', async (e) => void (await e.stop()));
    const b = new FakeExecutionPort();
    const engine = await reopen(dir, workflowId, b);
    assert.equal(engine.instance.state, 'STOPPED');
    assert.equal(b.starts.length, 0);
    await engine.close();
  }));
