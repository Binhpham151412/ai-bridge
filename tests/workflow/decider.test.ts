import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertWorkflowInvariants, createWorkflowInstance, decideWorkflow, replayWorkflowLog } from '../../src/core/workflow/decider.ts';
import { canonicalJson } from '../../src/core/workflow/canonical-json.ts';
import { workflowUsage } from '../../src/core/workflow/budgets.ts';
import { HASH, Sim, WF, at, created, definition, ended, envelopes } from './runtime-fixtures.ts';

const RUN1 = '2026-10-01_001';
const RUN2 = '2026-10-01_002';

function startedSim(def = definition()): Sim {
  const s = new Sim(def);
  s.feed({ type: 'START', at: at(1) });
  return s;
}

// ---------------------------------------------------------------------------
// creation
// ---------------------------------------------------------------------------

test('createWorkflowInstance: CREATED, one PENDING runtime step per definition step, one WORKFLOW_CREATED event', () => {
  const { instance, events } = created();
  assert.equal(instance.state, 'CREATED');
  assert.deepEqual(
    instance.steps.map((s) => [s.stepId, s.state, s.attempts.length]),
    [
      ['build', 'PENDING', 0],
      ['docs', 'PENDING', 0],
    ],
  );
  assert.deepEqual(instance.inputs, { task: 'do it' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'WORKFLOW_CREATED');
  assert.equal(events[0].payload.definitionHash, HASH);
});

test('createWorkflowInstance validates input values against the declared inputs', () => {
  const def = definition();
  const make = (inputs: unknown, workflowId = WF, definitionHash = HASH) => createWorkflowInstance(def, { workflowId, definitionHash, inputs, at: at(0) });
  const codes = (r: ReturnType<typeof make>) => (r.ok ? [] : r.errors.map((e) => [e.path, e.code]));
  assert.deepEqual(codes(make({})), [['$.inputs.task', 'MISSING_FIELD']]);
  assert.deepEqual(codes(make({ task: 'x', other: 'y' })), [['$.inputs.other', 'UNKNOWN_FIELD']]);
  assert.deepEqual(codes(make({ task: 5 })), [['$.inputs.task', 'INVALID_TYPE']]);
  assert.deepEqual(codes(make({ task: 'x'.repeat(101) })), [['$.inputs.task', 'OUT_OF_RANGE']]);
  assert.deepEqual(codes(make('task')), [['$.inputs', 'INVALID_TYPE']]);
  assert.deepEqual(codes(make({ task: 'x' }, '2026-10-01_001')), [['$.workflowId', 'INVALID_ID']]);
  assert.deepEqual(codes(make({ task: 'x' }, WF, 'nothex')), [['$.definitionHash', 'INVALID_VALUE']]);
});

// ---------------------------------------------------------------------------
// happy path + write-ahead
// ---------------------------------------------------------------------------

test('happy path: two steps run sequentially and complete as AI_ATTESTED', () => {
  const s = startedSim();
  assert.equal(s.instance.state, 'RUNNING');
  assert.deepEqual(s.commands, [{ type: 'START_EXECUTION', attemptId: `${WF}/build/1`, stepId: 'build', maxIterations: 10 }]);

  s.runExecution(ended(RUN1, 'DONE'), 2);
  assert.equal(s.attempt().state, 'VERIFYING');
  assert.deepEqual(s.commands, [{ type: 'VERIFY', attemptId: `${WF}/build/1` }]);

  s.pass(3);
  assert.deepEqual(
    s.instance.steps.map((x) => x.state),
    ['SUCCEEDED', 'ACTIVE'],
  );
  assert.deepEqual(s.commands, [{ type: 'START_EXECUTION', attemptId: `${WF}/docs/1`, stepId: 'docs', maxIterations: 10 }]);

  s.runExecution(ended(RUN2, 'DONE'), 4);
  s.pass(5);
  assert.equal(s.instance.state, 'COMPLETED');
  assert.equal(s.instance.terminalReason, 'ALL_STEPS_PASSED');
  assert.equal(s.instance.evidenceLevel, 'AI_ATTESTED');
  assert.equal(s.instance.endedAt, at(5));
  assert.deepEqual(s.commands, []);
  assert.equal(s.events.at(-1)!.type, 'WORKFLOW_COMPLETED');
});

test('write-ahead: the decision that emits START_EXECUTION already holds the attempt as LAUNCHING', () => {
  const s = startedSim();
  const a = s.attempt();
  assert.equal(a.state, 'LAUNCHING');
  assert.equal(a.launchedAt, at(1));
  assert.equal(a.executionId, null);
  assert.deepEqual(
    s.decisions[0].events.map((e) => e.type),
    ['INPUT_RECEIVED', 'WORKFLOW_STATE_CHANGED', 'STEP_STATE_CHANGED', 'ATTEMPT_PLANNED', 'ATTEMPT_STATE_CHANGED', 'ATTEMPT_LAUNCHING'],
  );
});

test('every accepted decision starts with INPUT_RECEIVED carrying the exact input', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'DONE'), 2);
  for (const d of s.decisions) {
    assert.equal(d.events[0].type, 'INPUT_RECEIVED');
    const input = JSON.parse(String(d.events[0].payload.input));
    assert.equal(d.events[0].timestamp, input.at);
  }
});

test('executionId is linked from RUN_STARTED; relinking the same run is a no-op; a different run is rejected', () => {
  const s = startedSim();
  const a = s.attempt();
  s.feed({ type: 'EXECUTION_LINKED', at: at(2), attemptId: a.attemptId, executionId: RUN1 });
  assert.equal(s.attempt().state, 'EXECUTING');
  assert.equal(s.attempt().executionId, RUN1);
  const again = s.feed({ type: 'EXECUTION_LINKED', at: at(3), attemptId: a.attemptId, executionId: RUN1 });
  assert.deepEqual(again.events, []);
  assert.equal(s.reject({ type: 'EXECUTION_LINKED', at: at(3), attemptId: a.attemptId, executionId: RUN2 }).code, 'NOT_ALLOWED');
  assert.equal(s.reject({ type: 'EXECUTION_ENDED', at: at(3), attemptId: a.attemptId, result: ended(RUN2, 'DONE') }).code, 'NOT_ALLOWED');
});

test('an outcome arriving before RUN_STARTED links the run itself', () => {
  const s = startedSim();
  s.feed({ type: 'EXECUTION_ENDED', at: at(2), attemptId: s.attempt().attemptId, result: ended(RUN1, 'DONE') });
  assert.equal(s.attempt().executionId, RUN1);
  assert.equal(s.attempt().state, 'VERIFYING');
});

// ---------------------------------------------------------------------------
// failures: no retries in M5
// ---------------------------------------------------------------------------

const FAILURES: [string, ReturnType<typeof ended>, string, string][] = [
  ['REPORT_INVALID', ended(RUN1, 'ERROR', { errorCode: 'REPORT_INVALID' }), 'EXECUTION_FAILED', 'ATTEMPTS_EXHAUSTED'],
  ['Claude timeout', ended(RUN1, 'ERROR', { errorCode: 'CLAUDE_RUN_FAILED:TIMEOUT' }), 'EXECUTION_FAILED', 'STEP_FAILED'],
  ['Claude non-zero exit', ended(RUN1, 'ERROR', { errorCode: 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT' }), 'EXECUTION_FAILED', 'STEP_FAILED'],
  ['spawn failure', ended(RUN1, 'ERROR', { errorCode: 'CLAUDE_RUN_FAILED:SPAWN_FAILED' }), 'EXECUTION_FAILED', 'ATTEMPTS_EXHAUSTED'],
  ['integrity failure', ended(RUN1, 'ERROR', { errorCode: 'PROMPT_INTEGRITY_FAILURE' }), 'EXECUTION_FAILED', 'STEP_FAILED'],
  ['max iterations', ended(RUN1, 'STOPPED_MAX_ITERATIONS', { iterations: 10 }), 'REJECTED', 'ATTEMPTS_EXHAUSTED'],
];

for (const [name, result, attemptState, reason] of FAILURES) {
  test(`${name}: the step fails with ${reason}, and no second attempt is ever created`, () => {
    const s = startedSim();
    s.runExecution(result, 2);
    assert.equal(s.attempt(0).state, attemptState);
    assert.equal(s.instance.steps[0].state, 'FAILED');
    assert.equal(s.instance.state, 'FAILED');
    assert.equal(s.instance.terminalReason, reason);
    assert.equal(s.instance.steps[0].attempts.length, 1);
    assert.equal(s.instance.steps[1].state, 'PENDING');
    assert.deepEqual(s.commands, []);
  });
}

test('verification FAIL rejects the attempt and fails the workflow (retries are M6)', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'DONE'), 2);
  s.feed({ type: 'VERIFICATION_COMPLETED', at: at(3), attemptId: s.attempt().attemptId, verdict: 'FAIL', evidenceLevel: 'AI_ATTESTED', failureSummary: 'nope' });
  assert.equal(s.attempt(0).state, 'REJECTED');
  assert.equal(s.instance.terminalReason, 'ATTEMPTS_EXHAUSTED');
  assert.equal(s.instance.steps[0].attempts.length, 1);
});

test('a verification result for an attempt that is not VERIFYING, or an unknown attempt, is rejected', () => {
  const s = startedSim();
  assert.equal(s.reject({ type: 'VERIFICATION_COMPLETED', at: at(2), attemptId: s.attempt().attemptId, verdict: 'PASS', evidenceLevel: 'AI_ATTESTED', failureSummary: null }).code, 'NOT_ALLOWED');
  assert.equal(s.reject({ type: 'VERIFICATION_COMPLETED', at: at(2), attemptId: `${WF}/nope/1`, verdict: 'PASS', evidenceLevel: 'AI_ATTESTED', failureSummary: null }).code, 'UNKNOWN_ATTEMPT');
});

test('the decider never marks a step passed without a verification verdict', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'DONE'), 2);
  assert.equal(s.instance.steps[0].state, 'ACTIVE');
  assert.equal(s.attempt().state, 'VERIFYING');
});

// ---------------------------------------------------------------------------
// human decisions
// ---------------------------------------------------------------------------

test('NEED_HUMAN → WAITING_HUMAN; "fail" → FAILED HUMAN_MARKED_FAILED', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'NEED_HUMAN'), 2);
  assert.equal(s.instance.state, 'WAITING_HUMAN');
  assert.deepEqual(s.instance.waitingFor, { kind: 'HUMAN', reason: 'HUMAN_REQUESTED', attemptId: `${WF}/build/1`, options: ['fail', 'stop', 'approve-bypass'] });
  s.feed({ type: 'HUMAN_ANSWER', at: at(3), answer: 'fail' });
  assert.equal(s.instance.state, 'FAILED');
  assert.equal(s.instance.terminalReason, 'HUMAN_MARKED_FAILED');
  assert.equal(s.instance.waitingFor, null);
});

test('WAITING_HUMAN: "stop" → STOPPED; "retry" (M6) and "resume-execution" (M5.6) are not available in M5', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'ERROR', { errorCode: 'RESPONSE_INVALID' }), 2);
  assert.equal(s.instance.state, 'WAITING_HUMAN');
  const retry = s.reject({ type: 'HUMAN_ANSWER', at: at(3), answer: 'retry' });
  assert.equal(retry.code, 'NOT_IN_M5');
  assert.match(retry.reason, /M6/);
  assert.equal(s.reject({ type: 'HUMAN_ANSWER', at: at(3), answer: 'resume-execution' }).code, 'NOT_IN_M5');
  s.feed({ type: 'HUMAN_ANSWER', at: at(3), answer: 'stop' });
  assert.equal(s.instance.state, 'STOPPED');
  assert.equal(s.instance.terminalReason, 'STOPPED_BY_USER');
  assert.equal(s.instance.steps[0].state, 'STOPPED');
});

// M5.10.1 — "Approve (bypass) & retry step"

test('approve-bypass: NEED_HUMAN → a NEW attempt of the same step with permission bypass; attempt 1 stays NEEDS_HUMAN', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'NEED_HUMAN'), 2);
  const accepted = s.feed({ type: 'HUMAN_ANSWER', at: at(3), answer: 'approve-bypass' });
  assert.equal(s.instance.state, 'RUNNING');
  assert.equal(s.instance.waitingFor, null);
  const [first, second] = s.instance.steps[0].attempts;
  assert.equal(first.state, 'NEEDS_HUMAN');
  assert.equal(second.attemptId, `${WF}/build/2`);
  assert.equal(second.state, 'LAUNCHING');
  assert.equal(second.permissionPolicy, 'bypass');
  assert.equal(first.permissionPolicy, undefined, 'normal attempts inherit the project setting');
  assert.deepEqual(accepted.commands, [{ type: 'START_EXECUTION', attemptId: `${WF}/build/2`, stepId: 'build', maxIterations: second.maxIterations, permissionPolicy: 'bypass' }]);
  const human = s.events.filter((e) => e.type === 'HUMAN_INPUT_RECEIVED').at(-1);
  assert.deepEqual(human?.payload, { answer: 'approve-bypass' });

  // The approved re-run passes → the workflow continues with the next step; the extra
  // execution was the human's, not the definition's budget (steps × 1 = 2 executions).
  s.runExecution(ended(RUN2, 'DONE'), 4);
  s.pass(5);
  assert.equal(s.instance.steps[0].state, 'SUCCEEDED');
  assert.equal(s.instance.steps[1].attempts.length, 1);
  assert.equal(s.instance.steps[1].attempts[0].state, 'LAUNCHING');
  assert.equal(s.instance.steps[1].attempts[0].permissionPolicy, undefined);
});

test('approve-bypass is offered once per step: a bypass re-run that needs a human again offers only fail/stop', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'NEED_HUMAN'), 2);
  s.feed({ type: 'HUMAN_ANSWER', at: at(3), answer: 'approve-bypass' });
  s.runExecution(ended(RUN2, 'NEED_HUMAN'), 4);
  assert.equal(s.instance.state, 'WAITING_HUMAN');
  assert.deepEqual(s.instance.waitingFor?.options, ['fail', 'stop']);
  assert.equal(s.reject({ type: 'HUMAN_ANSWER', at: at(5), answer: 'approve-bypass' }).code, 'NOT_ALLOWED');
  s.feed({ type: 'HUMAN_ANSWER', at: at(5), answer: 'fail' });
  assert.equal(s.instance.terminalReason, 'HUMAN_MARKED_FAILED');
});

test('approve-bypass is not offered when bypassing permissions cannot help (quota, invalid response) — and is refused there', () => {
  const q = startedSim();
  q.runExecution(ended(RUN1, 'ERROR', { errorCode: 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT', usageLimitDetected: true }), 2);
  assert.deepEqual(q.instance.waitingFor?.options, ['fail', 'stop']);
  assert.equal(q.reject({ type: 'HUMAN_ANSWER', at: at(3), answer: 'approve-bypass' }).code, 'NOT_ALLOWED');
  const r = startedSim();
  r.runExecution(ended(RUN1, 'ERROR', { errorCode: 'RESPONSE_INVALID' }), 2);
  assert.ok(!r.instance.waitingFor?.options.includes('approve-bypass'));
  // Outside WAITING_HUMAN it is refused like every other answer.
  assert.equal(startedSim().reject({ type: 'HUMAN_ANSWER', at: at(2), answer: 'approve-bypass' }).code, 'NOT_ALLOWED');
});

test('approve-bypass on a one-step workflow is still allowed (human authorization), and replay reproduces it exactly', () => {
  const s = startedSim(definition(['build']));
  s.runExecution(ended(RUN1, 'NEED_HUMAN'), 2);
  s.feed({ type: 'HUMAN_ANSWER', at: at(3), answer: 'approve-bypass' });
  assert.equal(s.instance.steps[0].attempts[1].state, 'LAUNCHING');
  s.runExecution(ended(RUN2, 'DONE'), 4);
  s.pass(5);
  assert.equal(s.instance.state, 'COMPLETED');
  assert.equal(workflowUsage(s.instance).executions, 2);
  const r = replayWorkflowLog(s.def, envelopes(s.events));
  assert.equal(r.ok, true, !r.ok ? r.reason : '');
  if (r.ok) assert.equal(canonicalJson(r.instance), canonicalJson(s.instance));
});

test('quota limits and refused resumes wait for a human (never retried)', () => {
  const q = startedSim();
  q.runExecution(ended(RUN1, 'ERROR', { errorCode: 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT', usageLimitDetected: true }), 2);
  assert.equal(q.instance.state, 'WAITING_HUMAN');
  assert.equal(q.instance.waitingFor?.reason, 'QUOTA');
});

// ---------------------------------------------------------------------------
// NOT_STARTED / BLOCKED
// ---------------------------------------------------------------------------

test('BLOCKED_PREFLIGHT: BLOCKED without consuming an attempt; resume relaunches the SAME attempt', () => {
  const s = startedSim();
  const id = s.attempt().attemptId;
  s.feed({ type: 'EXECUTION_ENDED', at: at(2), attemptId: id, result: { kind: 'NOT_STARTED', reason: 'BLOCKED_PREFLIGHT' } });
  assert.equal(s.instance.state, 'BLOCKED');
  assert.equal(s.attempt().state, 'NOT_STARTED');
  assert.equal(workflowUsage(s.instance).executions, 0);
  assert.deepEqual(s.instance.waitingFor, { kind: 'ENVIRONMENT', reason: 'BLOCKED_PREFLIGHT', attemptId: id, options: ['resume', 'stop'] });

  s.feed({ type: 'RESUME_REQUESTED', at: at(3) });
  assert.equal(s.instance.state, 'RUNNING');
  assert.equal(s.instance.steps[0].attempts.length, 1);
  assert.equal(s.attempt().attemptId, id);
  assert.equal(s.attempt().state, 'LAUNCHING');
  assert.equal(s.attempt().launches, 2);
  assert.deepEqual(s.commands, [{ type: 'START_EXECUTION', attemptId: id, stepId: 'build', maxIterations: 10 }]);
});

test('the cost guard (BLOCKED_API_AUTH) blocks like a refused start', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'ERROR', { errorCode: 'BLOCKED_API_AUTH', iterations: 0 }), 2);
  assert.equal(s.instance.state, 'BLOCKED');
  assert.equal(s.attempt().state, 'NOT_STARTED');
  assert.equal(workflowUsage(s.instance).executions, 0);
});

test('INVALID_OPTIONS fails the workflow as DEFINITION_INVALID', () => {
  const s = startedSim();
  s.feed({ type: 'EXECUTION_ENDED', at: at(2), attemptId: s.attempt().attemptId, result: { kind: 'NOT_STARTED', reason: 'INVALID_OPTIONS' } });
  assert.equal(s.instance.state, 'FAILED');
  assert.equal(s.instance.terminalReason, 'DEFINITION_INVALID');
});

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

test('pause during iteration 0 stays pending; it is forwarded exactly once when iteration ≥ 1 is reported', () => {
  const s = startedSim();
  const id = s.attempt().attemptId;
  s.feed({ type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: RUN1 });
  const p = s.feed({ type: 'PAUSE_REQUESTED', at: at(2) });
  assert.deepEqual(p.commands, []);
  assert.equal(s.instance.pauseRequested, true);
  assert.deepEqual(s.feed({ type: 'EXECUTION_PROGRESS', at: at(3), attemptId: id, iteration: 0 }).commands, []);
  assert.deepEqual(s.feed({ type: 'EXECUTION_PROGRESS', at: at(3), attemptId: id, iteration: 1 }).commands, [{ type: 'PAUSE_EXECUTION', attemptId: id }]);
  assert.deepEqual(s.feed({ type: 'EXECUTION_PROGRESS', at: at(4), attemptId: id, iteration: 2 }).commands, []);

  s.feed({ type: 'EXECUTION_ENDED', at: at(5), attemptId: id, result: ended(RUN1, 'PAUSED', { iterations: 2 }) });
  assert.equal(s.instance.state, 'PAUSED');
  assert.equal(s.attempt().state, 'PAUSED_EXECUTION');
  assert.equal(s.instance.pauseRequested, false);

  s.feed({ type: 'RESUME_REQUESTED', at: at(6) });
  assert.equal(s.instance.state, 'RUNNING');
  assert.equal(s.attempt().state, 'EXECUTING');
  assert.deepEqual(s.commands, [{ type: 'RESUME_EXECUTION', attemptId: id, executionId: RUN1 }]);
  assert.equal(s.instance.steps[0].attempts.length, 1, 'resume never creates a new attempt');

  s.feed({ type: 'EXECUTION_ENDED', at: at(7), attemptId: id, result: ended(RUN1, 'DONE', { iterations: 1 }) });
  assert.equal(s.attempt().iterationsUsed, 3, 'iterations of the paused and the resumed segment add up');
});

test('pause requested while verifying is honored at the next step boundary', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'DONE'), 2);
  s.feed({ type: 'PAUSE_REQUESTED', at: at(3) });
  s.pass(4);
  assert.equal(s.instance.state, 'PAUSED');
  assert.equal(s.instance.steps[1].state, 'PENDING');
  assert.deepEqual(s.commands, []);
  s.feed({ type: 'RESUME_REQUESTED', at: at(5) });
  assert.deepEqual(s.commands, [{ type: 'START_EXECUTION', attemptId: `${WF}/docs/1`, stepId: 'docs', maxIterations: 10 }]);
});

test('an execution that finishes before the pause lands is verified, then the workflow pauses', () => {
  const s = startedSim();
  const id = s.attempt().attemptId;
  s.feed({ type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: RUN1 });
  s.feed({ type: 'EXECUTION_PROGRESS', at: at(2), attemptId: id, iteration: 1 });
  s.feed({ type: 'PAUSE_REQUESTED', at: at(3) });
  s.feed({ type: 'EXECUTION_ENDED', at: at(4), attemptId: id, result: ended(RUN1, 'DONE') });
  assert.equal(s.attempt().state, 'VERIFYING');
  s.pass(5);
  assert.equal(s.instance.state, 'PAUSED');
});

test('a second pause, or a pause outside RUNNING, is rejected', () => {
  const s = startedSim();
  s.feed({ type: 'PAUSE_REQUESTED', at: at(2) });
  assert.equal(s.reject({ type: 'PAUSE_REQUESTED', at: at(2) }).code, 'NOT_ALLOWED');
  const c = new Sim();
  assert.equal(c.reject({ type: 'PAUSE_REQUESTED', at: at(0) }).code, 'NOT_ALLOWED');
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

test('stop wins over a pending pause; a live execution is stopped through the port', () => {
  const s = startedSim();
  const id = s.attempt().attemptId;
  s.feed({ type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: RUN1 });
  s.feed({ type: 'PAUSE_REQUESTED', at: at(2) });
  const stop = s.feed({ type: 'STOP_REQUESTED', at: at(3), cause: 'USER' });
  assert.deepEqual(stop.commands, [{ type: 'STOP_EXECUTION', attemptId: id }]);
  assert.equal(s.instance.pauseRequested, false);
  assert.equal(s.instance.state, 'RUNNING', 'stays RUNNING until the execution actually ends');
  assert.equal(s.reject({ type: 'PAUSE_REQUESTED', at: at(3) }).code, 'NOT_ALLOWED');

  s.feed({ type: 'EXECUTION_ENDED', at: at(4), attemptId: id, result: ended(RUN1, 'STOPPED') });
  assert.equal(s.instance.state, 'STOPPED');
  assert.equal(s.instance.terminalReason, 'STOPPED_BY_USER');
  assert.equal(s.attempt().stopCause, 'USER');
  assert.equal(s.instance.steps[0].state, 'STOPPED');
});

test('a stop that races a finished execution still stops (stop wins over DONE)', () => {
  const s = startedSim();
  const id = s.attempt().attemptId;
  s.feed({ type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: RUN1 });
  s.feed({ type: 'STOP_REQUESTED', at: at(3), cause: 'USER' });
  s.feed({ type: 'EXECUTION_ENDED', at: at(4), attemptId: id, result: ended(RUN1, 'DONE') });
  assert.equal(s.instance.state, 'STOPPED');
  assert.equal(s.attempt().state, 'STOPPED');
  assert.deepEqual(s.commands, [], 'no VERIFY after a stop');
});

test('stop with nothing live ends immediately: while VERIFYING, while PAUSED, while BLOCKED, and from CREATED', () => {
  const v = startedSim();
  v.runExecution(ended(RUN1, 'DONE'), 2);
  v.feed({ type: 'STOP_REQUESTED', at: at(3), cause: 'USER' });
  assert.equal(v.instance.state, 'STOPPED');
  assert.equal(v.attempt().state, 'STOPPED');

  const p = startedSim();
  p.runExecution(ended(RUN1, 'DONE'), 2);
  p.feed({ type: 'PAUSE_REQUESTED', at: at(3) });
  p.pass(4);
  p.feed({ type: 'STOP_REQUESTED', at: at(5), cause: 'USER' });
  assert.equal(p.instance.state, 'STOPPED');

  const b = startedSim();
  b.feed({ type: 'EXECUTION_ENDED', at: at(2), attemptId: b.attempt().attemptId, result: { kind: 'NOT_STARTED', reason: 'ALREADY_RUNNING' } });
  b.feed({ type: 'STOP_REQUESTED', at: at(3), cause: 'USER' });
  assert.equal(b.instance.state, 'STOPPED');

  const c = new Sim();
  c.feed({ type: 'STOP_REQUESTED', at: at(1), cause: 'USER' });
  assert.equal(c.instance.state, 'STOPPED');
  assert.equal(c.instance.terminalReason, 'STOPPED_BY_USER');
  assert.equal(c.reject({ type: 'START', at: at(2) }).code, 'NOT_ALLOWED');
});

test('an execution stopped outside the workflow (Run view / CLI) counts as a user stop', () => {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'STOPPED'), 2);
  assert.equal(s.instance.state, 'STOPPED');
  assert.equal(s.instance.terminalReason, 'STOPPED_BY_USER');
});

// ---------------------------------------------------------------------------
// deadline and budgets
// ---------------------------------------------------------------------------

test('a deadline stop from the host watchdog ends FAILED DEADLINE_EXCEEDED (not STOPPED)', () => {
  const s = startedSim(definition(['build', 'docs'], { budgets: { maxDurationMs: 600_000 } }));
  const id = s.attempt().attemptId;
  s.feed({ type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: RUN1 });
  s.feed({ type: 'STOP_REQUESTED', at: at(11), cause: 'DEADLINE' });
  s.feed({ type: 'EXECUTION_ENDED', at: at(12), attemptId: id, result: ended(RUN1, 'STOPPED') });
  assert.equal(s.instance.state, 'FAILED');
  assert.equal(s.instance.terminalReason, 'DEADLINE_EXCEEDED');
  assert.equal(s.attempt().stopCause, 'DEADLINE');
});

test('a deadline stop is only accepted while RUNNING', () => {
  const c = new Sim();
  assert.equal(c.reject({ type: 'STOP_REQUESTED', at: at(1), cause: 'DEADLINE' }).code, 'NOT_ALLOWED');
});

test('deadline at a step boundary outranks completing the next step (priority: DEADLINE > … > ALL_STEPS_PASSED)', () => {
  const s = startedSim(definition(['only'], { budgets: { maxDurationMs: 600_000 } }));
  s.runExecution(ended(RUN1, 'DONE'), 2);
  s.pass(20);
  assert.equal(s.instance.state, 'FAILED');
  assert.equal(s.instance.terminalReason, 'DEADLINE_EXCEEDED');
});

test('deadline outranks a step failure at the same boundary', () => {
  const s = startedSim(definition(['build', 'docs'], { budgets: { maxDurationMs: 600_000 } }));
  s.runExecution(ended(RUN1, 'ERROR', { errorCode: 'REPORT_INVALID' }), 30);
  assert.equal(s.instance.terminalReason, 'DEADLINE_EXCEEDED');
});

test('resuming a paused execution after the deadline fails the workflow instead', () => {
  const s = startedSim(definition(['build'], { budgets: { maxDurationMs: 600_000 } }));
  const id = s.attempt().attemptId;
  s.feed({ type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: RUN1 });
  s.feed({ type: 'EXECUTION_ENDED', at: at(3), attemptId: id, result: ended(RUN1, 'PAUSED') });
  s.feed({ type: 'RESUME_REQUESTED', at: at(30) });
  assert.equal(s.instance.state, 'FAILED');
  assert.equal(s.instance.terminalReason, 'DEADLINE_EXCEEDED');
  assert.equal(s.attempt().state, 'STOPPED');
  assert.deepEqual(s.commands, []);
});

test('exhausting maxExecutions fails at the next boundary with a BUDGET_EXHAUSTED event', () => {
  const s = startedSim(definition(['build', 'docs'], { budgets: { maxExecutions: 1 } }));
  s.runExecution(ended(RUN1, 'DONE'), 2);
  s.pass(3);
  assert.equal(s.instance.state, 'FAILED');
  assert.equal(s.instance.terminalReason, 'BUDGET_EXECUTIONS_EXHAUSTED');
  assert.ok(s.events.some((e) => e.type === 'BUDGET_EXHAUSTED' && e.payload.reason === 'BUDGET_EXECUTIONS_EXHAUSTED'));
  assert.equal(s.instance.steps[1].state, 'PENDING');
});

test('the iteration budget clamps the next execution and records the clamp', () => {
  const s = startedSim(definition(['build', 'docs'], { budgets: { maxTotalIterations: 13 } }));
  s.runExecution(ended(RUN1, 'DONE', { iterations: 9 }), 2);
  s.pass(3);
  const docs = s.attempt(1);
  assert.equal(docs.maxIterations, 4);
  assert.equal(docs.maxIterationsClamped, true);
  assert.deepEqual(s.commands, [{ type: 'START_EXECUTION', attemptId: `${WF}/docs/1`, stepId: 'docs', maxIterations: 4 }]);
});

test('token budget: exhausted → BUDGET_TOKENS_EXHAUSTED; unknown usage is flagged incomplete', () => {
  const s = startedSim(definition(['build', 'docs'], { budgets: { maxReportedTokens: 100 } }));
  s.runExecution(ended(RUN1, 'DONE', { reportedTokens: 150 }), 2);
  s.pass(3);
  assert.equal(s.instance.terminalReason, 'BUDGET_TOKENS_EXHAUSTED');

  const u = startedSim();
  u.runExecution(ended(RUN1, 'DONE', { reportedTokens: null }), 2);
  assert.equal(u.attempt().tokensIncomplete, true);
  assert.equal(workflowUsage(u.instance).tokensIncomplete, true);
});

// ---------------------------------------------------------------------------
// reconciliation hooks, rejections, purity, invariants
// ---------------------------------------------------------------------------

test('HOST_FAILED leaves the attempt as it is and asks for reconciliation (M5.6)', () => {
  const s = startedSim();
  const d = s.feed({ type: 'EXECUTION_ENDED', at: at(2), attemptId: s.attempt().attemptId, result: { kind: 'HOST_FAILED', executionId: null } });
  assert.deepEqual(d.commands, [{ type: 'RECONCILE', attemptId: `${WF}/build/1` }]);
  assert.equal(s.attempt().state, 'LAUNCHING');
  assert.equal(s.instance.state, 'RUNNING');
});

test('a refused resume waits for a human as AMBIGUOUS_RECOVERY', () => {
  const s = startedSim();
  const id = s.attempt().attemptId;
  s.feed({ type: 'EXECUTION_LINKED', at: at(2), attemptId: id, executionId: RUN1 });
  s.feed({ type: 'EXECUTION_ENDED', at: at(3), attemptId: id, result: ended(RUN1, 'PAUSED') });
  s.feed({ type: 'RESUME_REQUESTED', at: at(4) });
  s.feed({ type: 'EXECUTION_ENDED', at: at(5), attemptId: id, result: { kind: 'RESUME_REFUSED', reason: 'NOT_CURRENT_SESSION' } });
  assert.equal(s.instance.state, 'WAITING_HUMAN');
  assert.equal(s.instance.waitingFor?.reason, 'AMBIGUOUS_RECOVERY');
});

test('inputs that do not fit the current state are rejected without changing anything', () => {
  const s = startedSim();
  const before = canonicalJson(s.instance);
  assert.equal(s.reject({ type: 'START', at: at(2) }).code, 'NOT_ALLOWED');
  assert.equal(s.reject({ type: 'RESUME_REQUESTED', at: at(2) }).code, 'NOT_ALLOWED');
  assert.equal(s.reject({ type: 'HUMAN_ANSWER', at: at(2), answer: 'fail' }).code, 'NOT_ALLOWED');
  assert.equal(s.reject({ type: 'EXECUTION_PROGRESS', at: at(2), attemptId: s.attempt().attemptId, iteration: 1 }).code, 'NOT_ALLOWED');
  assert.equal(canonicalJson(s.instance), before);
  s.runExecution(ended(RUN1, 'DONE'), 2);
  assert.equal(s.reject({ type: 'EXECUTION_ENDED', at: at(3), attemptId: s.attempt().attemptId, result: ended(RUN1, 'DONE') }).code, 'NOT_ALLOWED');
});

test('the decider is pure: the input snapshot is never mutated and identical inputs give identical decisions', () => {
  const def = definition();
  const { instance } = created(def);
  const frozen = canonicalJson(instance);
  const a = decideWorkflow(def, instance, { type: 'START', at: at(1) });
  const b = decideWorkflow(def, instance, { type: 'START', at: at(1) });
  assert.equal(canonicalJson(instance), frozen);
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test('invariants reject impossible snapshots (two open attempts, out-of-order steps)', () => {
  const s = startedSim();
  const bad = structuredClone(s.instance);
  bad.steps[1].state = 'ACTIVE';
  bad.steps[1].attempts.push({ ...structuredClone(bad.steps[0].attempts[0]), attemptId: `${WF}/docs/1`, stepId: 'docs' });
  assert.throws(() => assertWorkflowInvariants(s.def, bad), /WORKFLOW_INVARIANT_VIOLATION/);
  const running = structuredClone(s.instance);
  running.steps[0].attempts = [];
  running.steps[0].state = 'PENDING';
  assert.throws(() => assertWorkflowInvariants(s.def, running), /RUNNING workflow with nothing in flight/);
});

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

function fullRun(): Sim {
  const s = startedSim();
  s.runExecution(ended(RUN1, 'DONE'), 2);
  s.pass(3);
  s.feed({ type: 'PAUSE_REQUESTED', at: at(3) });
  s.feed({ type: 'EXECUTION_LINKED', at: at(4), attemptId: s.attempt().attemptId, executionId: RUN2 });
  s.feed({ type: 'EXECUTION_PROGRESS', at: at(4), attemptId: s.attempt().attemptId, iteration: 1 });
  s.feed({ type: 'EXECUTION_ENDED', at: at(5), attemptId: s.attempt().attemptId, result: ended(RUN2, 'PAUSED') });
  s.feed({ type: 'RESUME_REQUESTED', at: at(6) });
  s.feed({ type: 'EXECUTION_ENDED', at: at(7), attemptId: s.attempt().attemptId, result: ended(RUN2, 'DONE') });
  s.pass(8);
  return s;
}

test('replaying the log reproduces the exact final instance', () => {
  const s = fullRun();
  const r = replayWorkflowLog(s.def, envelopes(s.events));
  assert.equal(r.ok, true, !r.ok ? r.reason : '');
  if (!r.ok) return;
  assert.equal(canonicalJson(r.instance), canonicalJson(s.instance));
  assert.deepEqual(r.missing, []);
});

test('a log cut short inside the last batch replays to the complete decision and reports the missing tail', () => {
  const s = fullRun();
  const lastBatch = s.decisions.at(-1)!.events.length;
  const cut = envelopes(s.events).slice(0, s.events.length - lastBatch + 1);
  const r = replayWorkflowLog(s.def, cut);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(canonicalJson(r.instance), canonicalJson(s.instance));
  assert.equal(r.missing.length, lastBatch - 1);
});

test('replay refuses an altered log', () => {
  const s = fullRun();
  const events = envelopes(s.events);
  const i = events.findIndex((e) => e.type === 'EXECUTION_ENDED');
  events[i] = { ...events[i], payload: { ...events[i].payload, iterations: 99 } };
  assert.equal(replayWorkflowLog(s.def, events).ok, false);
  assert.equal(replayWorkflowLog(s.def, envelopes(s.events.slice(1))).ok, false, 'must start with WORKFLOW_CREATED');
  assert.equal(replayWorkflowLog(definition(['other']), envelopes(s.events)).ok, false, 'a different definition');
});
