import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowEngine, type WorkflowEngineDeps } from '../../src/core/workflow/engine.ts';
import { WorkflowStore } from '../../src/core/workflow/store.ts';
import { canonicalJson } from '../../src/core/workflow/canonical-json.ts';
import { readEventLog } from '../../src/core/workflow/event-log.ts';
import { FakeExecutionPort } from './fake-execution-port.ts';
import { step, type Mutable } from './definition-fixtures.ts';

// M5.5: the WorkflowEngine over a scripted ExecutionPort — sequencing, one attempt per step,
// OutcomeOnly verification, budgets, pause/stop, human answers. No process, no CLI, no quota.

async function withProject<T>(fn: (aiBridgeDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-engine-'));
  try {
    return await fn(path.join(root, '.ai-bridge'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function raw(ids: string[], extra: Mutable = {}, stepExtra: Record<string, Mutable> = {}): Mutable {
  return {
    schema: 1,
    id: 'engine-flow',
    version: 1,
    title: 'Engine flow',
    inputs: { task: { type: 'string', required: true, maxLength: 100 } },
    steps: ids.map((id) => step(id, { executor: { role: 'executor', maxIterations: 10 }, ...(stepExtra[id] ?? {}) })),
    ...extra,
  };
}

const deps = (aiBridgeDir: string, port: FakeExecutionPort, o: Partial<WorkflowEngineDeps> = {}): WorkflowEngineDeps => ({ aiBridgeDir, port, pollIntervalMs: 5, ...o });

async function create(dir: string, port: FakeExecutionPort, def: Mutable, o: Partial<WorkflowEngineDeps> = {}): Promise<WorkflowEngine> {
  const r = await WorkflowEngine.create(deps(dir, port, o), def, { task: 'do it' });
  assert.equal(r.ok, true, JSON.stringify(!r.ok && r));
  if (!r.ok) throw new Error('unreachable');
  return r.engine;
}

async function run(engine: WorkflowEngine): Promise<void> {
  await engine.start();
  await engine.idle();
}

test('single step: LAUNCHING → execution → OutcomeOnly verification → COMPLETED (AI_ATTESTED)', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    const engine = await create(dir, port, raw(['build']));
    await run(engine);
    const inst = engine.instance;
    assert.equal(inst.state, 'COMPLETED');
    assert.equal(inst.evidenceLevel, 'AI_ATTESTED');
    const att = inst.steps[0].attempts[0];
    assert.equal(att.state, 'PASSED');
    assert.deepEqual(att.verification, { verdict: 'PASS', evidenceLevel: 'AI_ATTESTED', failureSummary: null });
    assert.equal(att.executionId, '2026-10-01_001');
    assert.equal(port.starts.length, 1);
    assert.equal(port.starts[0].attemptId, `${engine.workflowId}/build/1`);
    assert.equal(port.starts[0].correlation, undefined, 'the port defaults the correlation to the attemptId');
    assert.match(await readFile(path.join(engine.handle.paths.attempts, 'build-1', 'task.md'), 'utf8'), /Do the build work\./);
    const reloaded = await new WorkflowStore(dir).load(engine.workflowId);
    assert.equal(reloaded.ok && canonicalJson(reloaded.handle.instance), canonicalJson(inst), 'reconstructable from the log');
    const log = await readEventLog(engine.handle.paths.events, engine.workflowId);
    assert.ok(log.ok && log.events.some((e) => e.type === 'EXECUTION_LINKED' && e.executionId === '2026-10-01_001'));
    assert.deepEqual(engine.errors, []);
    await engine.close();
  }));

test('the write-ahead intent is durable before ExecutionPort.start() is called', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    let persistedState = '';
    port.behave = async (call) => {
      const loaded = await new WorkflowStore(dir).load(call.request!.attemptId.split('/')[0]);
      persistedState = loaded.ok ? loaded.handle.instance.steps[0].attempts[0].state : 'none';
      return { kind: 'ENDED', executionId: '2026-10-01_001', finalStatus: 'DONE', errorCode: null, iterations: 1, reportedTokens: 1, usageLimitDetected: false };
    };
    const engine = await create(dir, port, raw(['build']));
    await run(engine);
    assert.equal(persistedState, 'LAUNCHING');
    await engine.close();
  }));

test('multi-step: strictly sequential — step N+1 starts only after step N PASSED; outputs flow as data', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    let engine: WorkflowEngine;
    const seen: string[] = [];
    const base = port.behave;
    port.behave = async (call, n) => {
      seen.push(`${call.request!.attemptId.split('/')[1]}:${engine.instance.steps.map((s) => s.state).join(',')}`);
      return base(call, n);
    };
    port.sessions = [{ runId: '2026-10-01_001', startedAt: '2026-10-01T00:00:00.000Z', status: 'DONE', iterations: 1, errorCode: null, correlation: null, report: '# AI Bridge Report\n\n## SUMMARY\nBuilt the parser\n' }];
    engine = await create(dir, port, raw(['build', 'docs', 'wrap'], {}, { build: { outputs: ['report.summary'] }, docs: { instruction: 'Document {{steps.build.outputs.report.summary}}' } }));
    await run(engine);
    assert.equal(engine.instance.state, 'COMPLETED');
    assert.deepEqual(seen, ['build:ACTIVE,PENDING,PENDING', 'docs:SUCCEEDED,ACTIVE,PENDING', 'wrap:SUCCEEDED,SUCCEEDED,ACTIVE']);
    assert.match(port.starts[1].task, /--- BEGIN STEP OUTPUT build report\.summary ---\nBuilt the parser\n--- END STEP OUTPUT/);
    assert.deepEqual(engine.instance.steps.map((s) => s.attempts.length), [1, 1, 1], 'one attempt per step');
    await engine.close();
  }));

test('a failed step fails the workflow — no retry, no second attempt, later steps never run', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    port.behave = async () => ({ kind: 'ENDED', executionId: '2026-10-01_001', finalStatus: 'ERROR', errorCode: 'REPORT_INVALID', iterations: 1, reportedTokens: 1, usageLimitDetected: false });
    const engine = await create(dir, port, raw(['build', 'docs']));
    await run(engine);
    assert.equal(engine.instance.state, 'FAILED');
    assert.equal(engine.instance.terminalReason, 'ATTEMPTS_EXHAUSTED');
    assert.equal(port.starts.length, 1);
    assert.equal(engine.instance.steps[0].attempts.length, 1);
    assert.equal(engine.instance.steps[1].state, 'PENDING');
    await engine.close();
  }));

test('unknown error codes never complete a step: NEEDS_HUMAN → WAITING_HUMAN; "fail" ends FAILED; "retry" is M6', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    port.behave = async () => ({ kind: 'ENDED', executionId: '2026-10-01_001', finalStatus: 'ERROR', errorCode: 'SOMETHING_NEW', iterations: 1, reportedTokens: null, usageLimitDetected: false });
    const engine = await create(dir, port, raw(['build']));
    await run(engine);
    assert.equal(engine.instance.state, 'WAITING_HUMAN');
    const retry = await engine.answer('retry');
    assert.equal(retry.accepted, false);
    await engine.answer('fail');
    assert.equal(engine.instance.terminalReason, 'HUMAN_MARKED_FAILED');
    assert.equal(port.starts.length, 1);
    await engine.close();
  }));

test('M5.10.1 approve-bypass: the provider asked for a human → the step re-runs as attempt 2 with ExecutionRequest.permissionPolicy = bypass', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    port.behave = async (call, n) => {
      const runId = `2026-10-01_00${n + 1}`;
      call.emit({ event: 'RUN_STARTED', runId, iteration: 0, correlation: call.request?.attemptId });
      return { kind: 'ENDED', executionId: runId, finalStatus: n === 0 ? 'NEED_HUMAN' : 'DONE', errorCode: null, iterations: 1, reportedTokens: 5, usageLimitDetected: false };
    };
    const engine = await create(dir, port, raw(['build']));
    await run(engine);
    assert.equal(engine.instance.state, 'WAITING_HUMAN');
    assert.ok(engine.instance.waitingFor?.options.includes('approve-bypass'));
    const r = await engine.answer('approve-bypass');
    assert.equal(r.accepted, true);
    await engine.idle();
    assert.equal(engine.instance.state, 'COMPLETED');
    assert.equal(port.starts.length, 2);
    assert.equal('permissionPolicy' in port.starts[0], false, 'the first run inherits the project setting');
    assert.equal(port.starts[1].permissionPolicy, 'bypass');
    assert.ok(port.starts[1].attemptId.endsWith('/build/2'));
    const inst = engine.instance;
    const reloaded = await new WorkflowStore(dir).load(engine.workflowId);
    assert.equal(reloaded.ok && canonicalJson(reloaded.handle.instance), canonicalJson(inst), 'reconstructable from the log');
    assert.deepEqual(engine.errors, []);
    await engine.close();
  }));

test('a refused start is BLOCKED without consuming the attempt; resume relaunches the SAME attempt', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    const base = port.behave;
    port.behave = async (call, n) => (n === 0 ? { kind: 'NOT_STARTED', reason: 'BLOCKED_PREFLIGHT' } : base(call, n));
    const engine = await create(dir, port, raw(['build']));
    await run(engine);
    assert.equal(engine.instance.state, 'BLOCKED');
    await engine.resume();
    await engine.idle();
    assert.equal(engine.instance.state, 'COMPLETED');
    assert.deepEqual(port.starts.map((r) => r.attemptId), [`${engine.workflowId}/build/1`, `${engine.workflowId}/build/1`]);
    assert.equal(engine.instance.steps[0].attempts.length, 1);
    await engine.close();
  }));

test('stop during an execution stops it through the port; the workflow never advances', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    let release!: () => void;
    port.behave = async (call) => {
      call.emit({ event: 'RUN_STARTED', runId: '2026-10-01_001', iteration: 0 });
      await new Promise<void>((r) => (release = r));
      return { kind: 'ENDED', executionId: '2026-10-01_001', finalStatus: 'STOPPED', errorCode: null, iterations: 1, reportedTokens: 1, usageLimitDetected: false };
    };
    const stop = port.stop.bind(port);
    port.stop = async () => {
      release();
      return stop();
    };
    const engine = await create(dir, port, raw(['build', 'docs']));
    await engine.start();
    await engine.stop();
    await engine.idle();
    assert.equal(engine.instance.state, 'STOPPED');
    assert.equal(engine.instance.terminalReason, 'STOPPED_BY_USER');
    assert.equal(port.starts.length, 1);
    assert.equal(engine.instance.steps[1].state, 'PENDING');
    await engine.close();
  }));

test('stop during the Execution Host preflight window: stop is re-requested until the execution ends; never marked STOPPED early', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    port.stopOutcomes = ['NOT_RUNNING', 'NOT_RUNNING', 'STOPPED'];
    let stateWhileStopping = '';
    let engine: WorkflowEngine;
    port.behave = async (call) => {
      call.spawn(4242);
      while (port.stopCalls < 3) await new Promise((r) => setTimeout(r, 2));
      stateWhileStopping = engine.instance.steps[0].attempts[0].state;
      call.emit({ event: 'RUN_STARTED', runId: '2026-10-01_001', iteration: 0 });
      return { kind: 'ENDED', executionId: '2026-10-01_001', finalStatus: 'STOPPED', errorCode: null, iterations: 0, reportedTokens: null, usageLimitDetected: false };
    };
    engine = await create(dir, port, raw(['build', 'docs']));
    await engine.start();
    await engine.stop();
    await engine.idle();
    assert.equal(port.stopCalls, 3);
    assert.equal(stateWhileStopping, 'LAUNCHING', 'still LAUNCHING while the stop was a no-op');
    assert.equal(engine.instance.state, 'STOPPED');
    assert.equal(engine.instance.steps[0].attempts[0].hostPid, 4242);
    assert.equal(engine.instance.steps[1].state, 'PENDING');
    await engine.close();
  }));

test('pause is forwarded at iteration ≥ 1; resume continues the SAME execution', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    port.behave = async (call) => {
      if (call.kind === 'resume') return { kind: 'ENDED', executionId: call.executionId!, finalStatus: 'DONE', errorCode: null, iterations: 1, reportedTokens: 1, usageLimitDetected: false };
      call.emit({ event: 'RUN_STARTED', runId: '2026-10-01_001', iteration: 0 });
      call.emit({ event: 'CLAUDE_STARTED', runId: '2026-10-01_001', iteration: 1 });
      while (port.pauseCalls < 1) await new Promise((r) => setTimeout(r, 2));
      return { kind: 'ENDED', executionId: '2026-10-01_001', finalStatus: 'PAUSED', errorCode: null, iterations: 1, reportedTokens: 1, usageLimitDetected: false };
    };
    const engine = await create(dir, port, raw(['build']));
    await engine.start();
    await engine.pause();
    await engine.idle();
    assert.equal(engine.instance.state, 'PAUSED');
    await engine.resume();
    await engine.idle();
    assert.equal(engine.instance.state, 'COMPLETED');
    assert.deepEqual(port.resumes, ['2026-10-01_001']);
    assert.equal(port.starts.length, 1);
    assert.equal(engine.instance.steps[0].attempts[0].iterationsUsed, 2);
    await engine.close();
  }));

test('budgets: maxExecutions exhausted fails before the next step; the iteration budget clamps maxIterations', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    const engine = await create(dir, port, raw(['build', 'docs'], { budgets: { maxExecutions: 1 } }));
    await run(engine);
    assert.equal(engine.instance.terminalReason, 'BUDGET_EXECUTIONS_EXHAUSTED');
    assert.equal(port.starts.length, 1);
    await engine.close();

    const p2 = new FakeExecutionPort();
    const base = p2.behave;
    p2.behave = async (call, n) => ({ ...(await base(call, n)), iterations: 9 }) as never;
    const e2 = await create(dir, p2, raw(['build', 'docs'], { budgets: { maxTotalIterations: 13 } }));
    await run(e2);
    assert.deepEqual(p2.starts.map((s) => s.maxIterations), [10, 4]);
    assert.equal(e2.instance.steps[1].attempts[0].maxIterationsClamped, true);
    await e2.close();
  }));

test('invalid definitions and inputs are rejected before anything runs; the lock is held by one engine at a time', () =>
  withProject(async (dir) => {
    const port = new FakeExecutionPort();
    const bad = await WorkflowEngine.create(deps(dir, port), { ...raw(['a']), steps: [step('a', { verification: { checks: [{}], acceptAiOnly: true } })] }, { task: 'x' });
    assert.equal(!bad.ok && bad.code, 'INVALID');
    assert.equal(!bad.ok && bad.errors?.[0].milestone, 'M6');
    const noInput = await WorkflowEngine.create(deps(dir, port), raw(['a']), {});
    assert.equal(!noInput.ok && noInput.code, 'INVALID');
    const first = await create(dir, port, raw(['a']));
    const second = await WorkflowEngine.create(deps(dir, port), raw(['a']), { task: 'x' });
    assert.equal(!second.ok && second.code, 'LOCKED');
    await first.close();
    const third = await create(dir, port, raw(['a']));
    await third.close();
    assert.equal(port.calls.length, 0, 'nothing executed');
  }));
