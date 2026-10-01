import { canonicalJson } from './canonical-json.ts';
import { workflowInputEntries, type WorkflowDefinition, type WorkflowStepDefinition } from './definition.ts';
import { checkResumeBudget, checkStartBudget, deadlineExceeded, type StartBudgetCheck } from './budgets.ts';
import { classifyExecutionResult, type OutcomeClassification } from './outcome-mapper.ts';
import { assertValidAttemptTransition, assertValidInstanceTransition, assertValidStepTransition } from './transitions.ts';
import {
  LIVE_ATTEMPT_STATES,
  TERMINAL_ATTEMPT_STATES,
  TERMINAL_INSTANCE_STATES,
  WORKFLOW_INSTANCE_SCHEMA,
  attemptIdOf,
  isValidWorkflowId,
  type EvidenceLevel,
  type WorkflowActor,
  type WorkflowAttempt,
  type WorkflowAttemptState,
  type WorkflowCommand,
  type WorkflowEvent,
  type WorkflowEventDraft,
  type WorkflowEventPayload,
  type WorkflowInput,
  type WorkflowInstance,
  type WorkflowInstanceState,
  type WorkflowStepRuntime,
  type WorkflowStepState,
  type WorkflowTerminalReason,
} from './types.ts';
import type { WorkflowValidationError } from './validator.ts';

/**
 * M5.2 — the workflow decider: `(definition, snapshot, input) → (snapshot', commands, events)`
 * (docs/21 §3.2–3.3). This is the ONLY place workflow decisions are made. It is pure: no
 * I/O, no clock (time arrives on the input), no randomness — so a persisted input can be
 * replayed to the identical result (replayWorkflowLog, used by the store after a crash).
 *
 * M5 scope (ADR-020): strictly sequential steps, one attempt per step (no retries), and
 * OutcomeOnly verification — the decider requests VERIFY and accepts whatever verdict and
 * evidence level the verification port reports; it never sets a step PASSED on its own.
 *
 * Every state change is asserted against transitions.ts and every result is checked against
 * the instance invariants (at most one live attempt, strictly sequential steps, …).
 */

export type WorkflowDecision =
  | { accepted: true; instance: WorkflowInstance; commands: WorkflowCommand[]; events: WorkflowEventDraft[] }
  | { accepted: false; code: 'NOT_ALLOWED' | 'UNKNOWN_ATTEMPT' | 'NOT_IN_M5'; reason: string };

type Rejection = { code: 'NOT_ALLOWED' | 'UNKNOWN_ATTEMPT' | 'NOT_IN_M5'; reason: string };

const HUMAN_OPTIONS = ['fail', 'stop'];
const APPROVE_BYPASS = 'approve-bypass';
const ENVIRONMENT_OPTIONS = ['resume', 'stop'];

// ---------------------------------------------------------------------------
// instance creation
// ---------------------------------------------------------------------------

export type CreateInstanceResult = { ok: true; instance: WorkflowInstance; events: WorkflowEventDraft[] } | { ok: false; errors: WorkflowValidationError[] };

/** A new CREATED instance for a validated definition, with its input values checked against
 * the declared inputs (unknown → rejected, required → present, string, ≤ maxLength). */
export function createWorkflowInstance(definition: WorkflowDefinition, params: { workflowId: string; definitionHash: string; inputs: unknown; at: string }): CreateInstanceResult {
  const errors: WorkflowValidationError[] = [];
  if (!isValidWorkflowId(params.workflowId)) errors.push({ path: '$.workflowId', code: 'INVALID_ID', message: `must match wf_YYYY-MM-DD_NNN, got ${JSON.stringify(params.workflowId)}` });
  if (!/^[0-9a-f]{64}$/.test(params.definitionHash)) errors.push({ path: '$.definitionHash', code: 'INVALID_VALUE', message: 'must be a sha256 hex digest' });

  const raw = params.inputs ?? {};
  const values: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ path: '$.inputs', code: 'INVALID_TYPE', message: 'input values must be an object of strings' });
  } else {
    const declared = new Map(workflowInputEntries(definition));
    const given = raw as Record<string, unknown>;
    for (const name of Object.keys(given).sort()) {
      if (!declared.has(name)) errors.push({ path: `$.inputs.${name}`, code: 'UNKNOWN_FIELD', message: `"${name}" is not an input of this workflow` });
    }
    for (const [name, def] of declared) {
      const path = `$.inputs.${name}`;
      if (!(name in given)) {
        if (def.required) errors.push({ path, code: 'MISSING_FIELD', message: `required input "${name}" is missing` });
        continue;
      }
      const value = given[name];
      if (typeof value !== 'string') errors.push({ path, code: 'INVALID_TYPE', message: 'must be a string' });
      else if (value.length > def.maxLength) errors.push({ path, code: 'OUT_OF_RANGE', message: `must be at most ${def.maxLength} characters, got ${value.length}` });
      else values[name] = value;
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const instance: WorkflowInstance = {
    schema: WORKFLOW_INSTANCE_SCHEMA,
    workflowId: params.workflowId,
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionHash: params.definitionHash,
    state: 'CREATED',
    inputs: values,
    createdAt: params.at,
    startedAt: null,
    endedAt: null,
    updatedAt: params.at,
    steps: definition.steps.map((s) => ({ stepId: s.id, state: 'PENDING', evidenceLevel: null, attempts: [] })),
    pauseRequested: false,
    pauseForwarded: false,
    stopRequested: null,
    waitingFor: null,
    terminalReason: null,
    evidenceLevel: null,
  };
  assertWorkflowInvariants(definition, instance);
  const created = draftEvent('WORKFLOW_CREATED', params.at, 'host', {
    payload: { definitionId: definition.id, definitionVersion: definition.version, definitionHash: params.definitionHash, inputs: canonicalJson(values) },
  });
  return { ok: true, instance, events: [created] };
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

export function decideWorkflow(definition: WorkflowDefinition, instance: WorkflowInstance, input: WorkflowInput): WorkflowDecision {
  const d = new Draft(definition, instance, input.at);
  const rejection = apply(d, input);
  if (rejection) return { accepted: false, ...rejection };
  if (!d.changed()) return { accepted: true, instance, commands: [], events: [] };
  d.inst.updatedAt = input.at;
  assertWorkflowInvariants(definition, d.inst);
  return { accepted: true, instance: d.inst, commands: d.commands, events: [inputEvent(input), ...d.events] };
}

function apply(d: Draft, input: WorkflowInput): Rejection | null {
  const inst = d.inst;
  switch (input.type) {
    case 'START': {
      if (inst.state !== 'CREATED') return notAllowed(`cannot start a workflow in state ${inst.state}`);
      inst.startedAt = input.at;
      d.setInstance('RUNNING');
      settle(d);
      return null;
    }

    case 'EXECUTION_LINKED': {
      const att = d.attempt(input.attemptId);
      if (!att) return unknownAttempt(input.attemptId);
      if (att.state === 'LAUNCHING') link(d, att, input.executionId);
      else if (att.state !== 'EXECUTING' || att.executionId !== input.executionId) return notAllowed(`attempt ${att.attemptId} is ${att.state} (execution ${att.executionId ?? 'none'}); cannot link ${input.executionId}`);
      return null; // re-link of the same run (e.g. RUN_STARTED again on resume) is a no-op
    }

    case 'EXECUTION_PROGRESS': {
      const att = d.attempt(input.attemptId);
      if (!att) return unknownAttempt(input.attemptId);
      if (att.state !== 'EXECUTING') return notAllowed(`attempt ${att.attemptId} is ${att.state}, not EXECUTING`);
      if (!Number.isInteger(input.iteration) || input.iteration < 0) return notAllowed('iteration must be a non-negative integer');
      if (input.iteration > att.observedIteration) att.observedIteration = input.iteration;
      forwardPauseIfPossible(d);
      return null;
    }

    case 'EXECUTION_ENDED':
      return executionEnded(d, input.attemptId, input.result);

    case 'VERIFICATION_COMPLETED': {
      const att = d.attempt(input.attemptId);
      if (!att) return unknownAttempt(input.attemptId);
      if (att.state !== 'VERIFYING') return notAllowed(`attempt ${att.attemptId} is ${att.state}, not VERIFYING`);
      att.verification = { verdict: input.verdict, evidenceLevel: input.evidenceLevel, failureSummary: input.failureSummary };
      d.emit('VERIFICATION_COMPLETED', 'verification', { attempt: att, payload: { verdict: input.verdict, evidenceLevel: input.evidenceLevel } });
      const step = d.stepOf(att);
      if (input.verdict === 'PASS') {
        d.setAttempt(att, 'PASSED');
        step.evidenceLevel = input.evidenceLevel;
        d.setStep(step, 'SUCCEEDED');
      } else if (input.verdict === 'FAIL') {
        d.setAttempt(att, 'REJECTED');
        failStep(d, step, 'ATTEMPTS_EXHAUSTED'); // verification failures are retryable in M6; M5 has 1 attempt
      } else {
        d.setAttempt(att, 'NEEDS_HUMAN');
        if (!inst.stopRequested) waitForHuman(d, 'VERIFICATION_NEEDS_HUMAN', att);
      }
      settle(d);
      return null;
    }

    case 'PAUSE_REQUESTED': {
      if (inst.state !== 'RUNNING') return notAllowed(`cannot pause a workflow in state ${inst.state}`);
      if (inst.pauseRequested || inst.stopRequested) return notAllowed('a pause or stop is already pending');
      inst.pauseRequested = true;
      d.emit('PAUSE_REQUESTED', 'human');
      forwardPauseIfPossible(d); // otherwise pending: until iteration ≥ 1, or the next step boundary
      return null;
    }

    case 'RESUME_REQUESTED':
      return resume(d);

    case 'STOP_REQUESTED': {
      if (TERMINAL_INSTANCE_STATES.includes(inst.state)) return notAllowed(`workflow already ended (${inst.state})`);
      if (inst.stopRequested) return notAllowed('a stop is already pending');
      if (input.cause === 'DEADLINE' && inst.state !== 'RUNNING') return notAllowed('a deadline stop applies only to a RUNNING workflow; other states are checked at their next boundary');
      inst.stopRequested = input.cause;
      inst.pauseRequested = false;
      d.emit('STOP_REQUESTED', input.cause === 'USER' ? 'human' : 'host', { payload: { cause: input.cause } });
      if (inst.state === 'CREATED') {
        inst.terminalReason = 'STOPPED_BY_USER';
        d.setInstance('STOPPED');
        return null;
      }
      const live = d.liveAttempt();
      if (live) d.commands.push({ type: 'STOP_EXECUTION', attemptId: live.attemptId });
      else settle(d);
      return null;
    }

    case 'EXECUTION_HOST_SPAWNED': {
      const att = d.attempt(input.attemptId);
      if (!att) return unknownAttempt(input.attemptId);
      if (!LIVE_ATTEMPT_STATES.includes(att.state)) return notAllowed(`attempt ${att.attemptId} is ${att.state}; no host is being launched`);
      if (!Number.isInteger(input.hostPid) || input.hostPid <= 0) return notAllowed('hostPid must be a positive integer');
      att.hostPid = input.hostPid;
      return null;
    }

    case 'RECONCILED':
      return reconciled(d, input.attemptId, input.finding);

    case 'HUMAN_ANSWER': {
      if (inst.state !== 'WAITING_HUMAN') return notAllowed(`no decision is pending (state ${inst.state})`);
      if (input.answer === 'retry') return { code: 'NOT_IN_M5', reason: 'retries belong to M6; in M5 a step runs exactly once' };
      if (input.answer === 'resume-execution') return { code: 'NOT_IN_M5', reason: 'resuming an execution from WAITING_HUMAN needs the reconciler (M5.6)' };
      if (input.answer === 'approve-bypass') return approveBypass(d);
      d.emit('HUMAN_INPUT_RECEIVED', 'human', { attemptId: inst.waitingFor?.attemptId ?? null, payload: { answer: input.answer } });
      if (input.answer === 'stop') {
        inst.stopRequested = 'USER';
        settle(d);
      } else {
        const step = d.activeStep();
        if (step) failStep(d, step, 'HUMAN_MARKED_FAILED');
        finish(d, 'FAILED', 'HUMAN_MARKED_FAILED');
      }
      return null;
    }
  }
}

function executionEnded(d: Draft, attemptId: string, result: Extract<WorkflowInput, { type: 'EXECUTION_ENDED' }>['result']): Rejection | null {
  const inst = d.inst;
  const att = d.attempt(attemptId);
  if (!att) return unknownAttempt(attemptId);
  if (!LIVE_ATTEMPT_STATES.includes(att.state)) return notAllowed(`attempt ${att.attemptId} is ${att.state}; no execution is in flight`);
  const reportedId = result.kind === 'ENDED' || result.kind === 'HOST_FAILED' ? result.executionId : null;
  if (reportedId !== null && att.executionId !== null && reportedId !== att.executionId) {
    return notAllowed(`attempt ${att.attemptId} belongs to execution ${att.executionId}, not ${reportedId}`);
  }
  if (reportedId !== null && att.state === 'LAUNCHING') link(d, att, reportedId);

  const step = d.stepOf(att);
  const cls = classifyExecutionResult(result, { acceptMaxIterationsOutcome: d.stepDef(step).verification.acceptMaxIterationsOutcome ?? false });
  if (cls.effect === 'RECONCILE') {
    d.commands.push({ type: 'RECONCILE', attemptId: att.attemptId });
    return null;
  }

  att.lastOutcome = {
    kind: result.kind,
    finalStatus: result.kind === 'ENDED' ? result.finalStatus : null,
    errorCode: result.kind === 'ENDED' ? result.errorCode : null,
    class: cls.class,
    retryable: cls.retryable,
  };
  if (result.kind === 'ENDED') {
    att.iterationsUsed += result.iterations;
    if (result.reportedTokens === null) att.tokensIncomplete = true;
    else att.reportedTokens += result.reportedTokens;
    d.emit('EXECUTION_ENDED', 'host', {
      attempt: att,
      payload: { finalStatus: result.finalStatus, errorCode: result.errorCode, iterations: result.iterations, class: cls.class },
    });
  }
  inst.pauseForwarded = false; // the execution is no longer live

  switch (cls.effect) {
    case 'VERIFY':
      d.setAttempt(att, 'EXECUTION_ENDED');
      att.endedAt = d.at;
      if (!inst.stopRequested) {
        d.setAttempt(att, 'VERIFYING');
        d.emit('VERIFICATION_STARTED', 'workflow-engine', { attempt: att });
        d.commands.push({ type: 'VERIFY', attemptId: att.attemptId });
      }
      break;
    case 'REJECT':
      d.setAttempt(att, 'EXECUTION_ENDED');
      d.setAttempt(att, 'REJECTED');
      att.endedAt = d.at;
      failStep(d, step, failureReason(cls));
      break;
    case 'EXECUTION_FAILED':
      d.setAttempt(att, 'EXECUTION_FAILED');
      att.endedAt = d.at;
      failStep(d, step, failureReason(cls));
      break;
    case 'NEEDS_HUMAN':
      d.setAttempt(att, 'NEEDS_HUMAN');
      att.endedAt = d.at;
      if (!inst.stopRequested) waitForHuman(d, cls.class, att);
      break;
    case 'PAUSED_EXECUTION':
      d.setAttempt(att, 'PAUSED_EXECUTION');
      inst.pauseRequested = false;
      if (!inst.stopRequested) d.setInstance('PAUSED', { reason: 'EXECUTION_PAUSED' });
      break;
    case 'STOPPED':
      d.setAttempt(att, 'STOPPED');
      att.stopCause = inst.stopRequested ?? 'USER'; // stopped outside the workflow (Run view/CLI) counts as a user stop
      att.endedAt = d.at;
      if (!inst.stopRequested) inst.stopRequested = 'USER';
      break;
    case 'NOT_STARTED':
      d.setAttempt(att, 'NOT_STARTED');
      if (cls.class === 'DEFINITION') failStep(d, step, 'DEFINITION_INVALID');
      else if (!inst.stopRequested) block(d, result.kind === 'NOT_STARTED' ? result.reason : cls.class, att);
      break;
  }
  settle(d);
  return null;
}

/** M5.6: applies a reconciliation finding to a live attempt (docs/26 §6). Never creates an
 * attempt and never starts a second execution: NOT_STARTED relaunches the SAME attempt only
 * because it was proven that nothing ran; RESUME continues the SAME execution. */
function reconciled(d: Draft, attemptId: string, finding: Extract<WorkflowInput, { type: 'RECONCILED' }>['finding']): Rejection | null {
  const inst = d.inst;
  const att = d.attempt(attemptId);
  if (!att) return unknownAttempt(attemptId);
  if (inst.state !== 'RUNNING') return notAllowed(`cannot reconcile a workflow in state ${inst.state}`);
  if (!LIVE_ATTEMPT_STATES.includes(att.state)) return notAllowed(`attempt ${att.attemptId} is ${att.state}; nothing to reconcile`);
  if (finding.kind === 'NOT_STARTED' && att.state !== 'LAUNCHING') return notAllowed('NOT_STARTED applies only to a LAUNCHING attempt');
  if ((finding.kind === 'WATCH' || finding.kind === 'RESUME') && (att.state !== 'EXECUTING' || att.executionId !== finding.executionId)) {
    return notAllowed(`${finding.kind} needs attempt ${att.attemptId} EXECUTING execution ${finding.executionId} (it is ${att.state}, ${att.executionId ?? 'unlinked'})`);
  }

  const payload: WorkflowEventPayload = { finding: finding.kind };
  if (finding.kind === 'WATCH' || finding.kind === 'RESUME') payload.executionId = finding.executionId;
  if (finding.kind === 'UNRESOLVABLE') payload.reason = finding.reason;
  d.emit('RECONCILED', 'workflow-engine', { attempt: att, payload });

  switch (finding.kind) {
    case 'NOT_STARTED':
      d.setAttempt(att, 'PLANNED');
      if (inst.stopRequested) settle(d); // a pending stop wins: the attempt ends STOPPED, nothing is launched
      else launch(d, att);
      return null;
    case 'WATCH':
      d.commands.push({ type: 'WATCH_EXECUTION', attemptId: att.attemptId, executionId: finding.executionId });
      return null;
    case 'RESUME':
      d.commands.push({ type: 'RESUME_EXECUTION', attemptId: att.attemptId, executionId: finding.executionId });
      return null;
    case 'UNRESOLVABLE':
      if (att.state === 'LAUNCHING') d.setAttempt(att, 'LAUNCH_UNKNOWN');
      d.setAttempt(att, 'NEEDS_HUMAN');
      att.endedAt = d.at;
      inst.pauseForwarded = false;
      if (!inst.stopRequested) waitForHuman(d, finding.reason, att);
      settle(d);
      return null;
  }
}

function resume(d: Draft): Rejection | null {
  const inst = d.inst;
  if (inst.state === 'PAUSED') {
    d.setInstance('RUNNING', { reason: 'RESUMED' });
    const cur = d.openAttempt();
    if (cur?.state === 'PAUSED_EXECUTION') {
      const check = checkResumeBudget(d.def, inst, d.at);
      if (!check.ok) {
        abortOpenAttempt(d, check.reason === 'DEADLINE_EXCEEDED' ? 'DEADLINE' : null);
        finish(d, 'FAILED', check.reason);
        return null;
      }
      d.setAttempt(cur, 'EXECUTING');
      d.commands.push({ type: 'RESUME_EXECUTION', attemptId: cur.attemptId, executionId: cur.executionId! });
      return null;
    }
    settle(d); // paused at a step boundary → continue with the next step
    return null;
  }
  if (inst.state === 'BLOCKED') {
    const cur = d.openAttempt() ?? d.lastAttemptOfActiveStep();
    if (!cur || cur.state !== 'NOT_STARTED') return notAllowed('nothing to restart');
    inst.waitingFor = null;
    d.setInstance('RUNNING', { reason: 'RESTARTED' });
    const budget = checkStartBudget(d.def, inst, d.stepDef(d.stepOf(cur)), d.at);
    if (!budget.ok) {
      failStep(d, d.stepOf(cur), budget.reason);
      finish(d, 'FAILED', budget.reason);
      return null;
    }
    cur.maxIterations = budget.maxIterations;
    cur.maxIterationsClamped = budget.clamped;
    launch(d, cur);
    return null;
  }
  return notAllowed(`cannot resume a workflow in state ${inst.state}`);
}

// ---------------------------------------------------------------------------
// boundaries
// ---------------------------------------------------------------------------

/** Moves the workflow forward whenever nothing is in flight. */
function settle(d: Draft): void {
  const inst = d.inst;
  if (TERMINAL_INSTANCE_STATES.includes(inst.state)) return;
  if (d.liveAttempt()) return; // wait for the execution to end
  if (inst.stopRequested) {
    finalizeStop(d);
    return;
  }
  if (inst.state !== 'RUNNING') return; // PAUSED / WAITING_HUMAN / BLOCKED wait for the user
  const open = d.openAttempt();
  if (open) return; // VERIFYING / EXECUTION_ENDED / PAUSED_EXECUTION — waiting for a result or a resume
  boundary(d);
}

/** A step boundary: nothing open. Priority (docs/22 §7.6): stop (handled by settle) >
 * DEADLINE_EXCEEDED > BUDGET_* > STEP_FAILED > ALL_STEPS_PASSED; then a pending pause;
 * then the next step. */
function boundary(d: Draft): void {
  const inst = d.inst;
  if (deadlineExceeded(d.def, inst, d.at)) return finish(d, 'FAILED', 'DEADLINE_EXCEEDED');
  if (d.failure) return finish(d, 'FAILED', d.failure);
  const next = inst.steps.findIndex((s) => s.state === 'PENDING');
  if (next === -1) return complete(d);
  const budget = checkStartBudget(d.def, inst, d.def.steps[next], d.at);
  if (!budget.ok) return finish(d, 'FAILED', budget.reason);
  if (inst.pauseRequested) {
    inst.pauseRequested = false;
    d.setInstance('PAUSED', { reason: 'PAUSED_AT_STEP_BOUNDARY' });
    return;
  }
  startAttempt(d, next, budget);
}

function startAttempt(d: Draft, stepIndex: number, budget: Extract<StartBudgetCheck, { ok: true }>, permissionPolicy?: 'bypass'): void {
  const step = d.inst.steps[stepIndex];
  if (step.state === 'PENDING') d.setStep(step, 'ACTIVE');
  const attemptNo = step.attempts.length + 1;
  const att: WorkflowAttempt = {
    attemptId: attemptIdOf(d.inst.workflowId, step.stepId, attemptNo),
    stepId: step.stepId,
    attemptNo,
    state: 'PLANNED',
    maxIterations: budget.maxIterations,
    maxIterationsClamped: budget.clamped,
    executionId: null,
    plannedAt: d.at,
    launchedAt: null,
    endedAt: null,
    launches: 0,
    observedIteration: 0,
    iterationsUsed: 0,
    reportedTokens: 0,
    tokensIncomplete: false,
    lastOutcome: null,
    verification: null,
    stopCause: null,
    ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
  };
  step.attempts.push(att);
  d.emit('ATTEMPT_PLANNED', 'workflow-engine', {
    attempt: att,
    payload: { attemptNo, maxIterations: att.maxIterations, maxIterationsClamped: att.maxIterationsClamped, ...(permissionPolicy !== undefined ? { permissionPolicy } : {}) },
  });
  launch(d, att);
}

/**
 * M5.10.1 (docs/61 §13): the provider asked for a human (NEED_HUMAN) — typically a permission
 * it could not get headless. The human approves: the same step runs again as a NEW attempt
 * (new execution, new CLI sessions) with permission policy `bypass`. Offered once per step;
 * this is not the M6 retry (`retry` stays NOT_IN_M5).
 */
function approveBypass(d: Draft): Rejection | null {
  const inst = d.inst;
  if (!inst.waitingFor?.options.includes(APPROVE_BYPASS)) return notAllowed('approve-bypass is offered only when the provider asked for a human, once per step');
  const step = d.activeStep();
  if (!step) return notAllowed('no active step to run again');
  d.emit('HUMAN_INPUT_RECEIVED', 'human', { attemptId: inst.waitingFor.attemptId, payload: { answer: APPROVE_BYPASS } });
  inst.waitingFor = null;
  const budget = checkStartBudget(d.def, inst, d.stepDef(step), d.at, { humanApprovedExtraExecution: true });
  if (!budget.ok) {
    failStep(d, step, budget.reason);
    finish(d, 'FAILED', budget.reason);
    return null;
  }
  d.setInstance('RUNNING');
  startAttempt(d, inst.steps.indexOf(step), budget, 'bypass');
  return null;
}

/** Write-ahead: the attempt is LAUNCHING in the persisted snapshot before the engine shell
 * ever calls the execution port (commands run only after the decision is persisted). */
function launch(d: Draft, att: WorkflowAttempt): void {
  d.setAttempt(att, 'LAUNCHING');
  att.launchedAt = d.at;
  att.launches += 1;
  d.emit('ATTEMPT_LAUNCHING', 'workflow-engine', { attempt: att, payload: { launch: att.launches, maxIterations: att.maxIterations } });
  d.commands.push({
    type: 'START_EXECUTION',
    attemptId: att.attemptId,
    stepId: att.stepId,
    maxIterations: att.maxIterations,
    ...(att.permissionPolicy !== undefined ? { permissionPolicy: att.permissionPolicy } : {}),
  });
}

function link(d: Draft, att: WorkflowAttempt, executionId: string): void {
  att.executionId = executionId;
  d.setAttempt(att, 'EXECUTING');
  d.emit('EXECUTION_LINKED', 'host', { attempt: att });
}

function forwardPauseIfPossible(d: Draft): void {
  const inst = d.inst;
  const live = d.liveAttempt();
  // docs/22 §7.1: a pause during iteration 0 cannot land on a resumable checkpoint — keep it pending.
  if (inst.pauseRequested && !inst.pauseForwarded && live?.state === 'EXECUTING' && live.observedIteration >= 1) {
    inst.pauseForwarded = true;
    d.commands.push({ type: 'PAUSE_EXECUTION', attemptId: live.attemptId });
  }
}

function failureReason(cls: OutcomeClassification): WorkflowTerminalReason {
  if (cls.class === 'DEFINITION') return 'DEFINITION_INVALID';
  return cls.retryable === 'YES' || cls.retryable === 'ONCE' ? 'ATTEMPTS_EXHAUSTED' : 'STEP_FAILED';
}

function failStep(d: Draft, step: WorkflowStepRuntime, reason: WorkflowTerminalReason): void {
  if (step.state === 'ACTIVE') d.setStep(step, 'FAILED');
  d.failure ??= reason;
}

function waitForHuman(d: Draft, reason: string, att: WorkflowAttempt): void {
  // M5.10.1: when the provider itself asked for a human, offer one bypass re-run of the step.
  const bypassOffered = reason === 'HUMAN_REQUESTED' && !d.stepOf(att).attempts.some((a) => a.permissionPolicy === 'bypass');
  const options = bypassOffered ? [...HUMAN_OPTIONS, APPROVE_BYPASS] : [...HUMAN_OPTIONS];
  d.inst.waitingFor = { kind: 'HUMAN', reason, attemptId: att.attemptId, options };
  d.setInstance('WAITING_HUMAN', { reason });
  d.emit('HUMAN_INPUT_REQUESTED', 'workflow-engine', { attempt: att, payload: { reason, options: [...options] } });
}

function block(d: Draft, reason: string, att: WorkflowAttempt): void {
  d.inst.waitingFor = { kind: 'ENVIRONMENT', reason, attemptId: att.attemptId, options: [...ENVIRONMENT_OPTIONS] };
  d.setInstance('BLOCKED', { reason });
}

/** Ends the open attempt (if any) and the active step as STOPPED. */
function abortOpenAttempt(d: Draft, cause: 'USER' | 'DEADLINE' | null): void {
  const open = d.openAttempt();
  if (open) {
    d.setAttempt(open, 'STOPPED');
    open.stopCause = cause;
    open.endedAt ??= d.at;
  }
  const step = d.activeStep();
  if (step) d.setStep(step, 'STOPPED');
}

function finalizeStop(d: Draft): void {
  const cause = d.inst.stopRequested!;
  abortOpenAttempt(d, cause);
  if (cause === 'DEADLINE') finish(d, 'FAILED', 'DEADLINE_EXCEEDED');
  else finish(d, 'STOPPED', 'STOPPED_BY_USER');
}

function finish(d: Draft, state: 'FAILED' | 'STOPPED', reason: WorkflowTerminalReason): void {
  const inst = d.inst;
  inst.terminalReason = reason;
  inst.waitingFor = null;
  inst.pauseRequested = false;
  if (reason.startsWith('BUDGET_')) d.emit('BUDGET_EXHAUSTED', 'workflow-engine', { payload: { reason } });
  d.setInstance(state, { terminalReason: reason });
}

const EVIDENCE_ORDER: EvidenceLevel[] = ['NONE', 'AI_ATTESTED', 'VERIFIED'];

function complete(d: Draft): void {
  const inst = d.inst;
  const levels = inst.steps.map((s) => s.evidenceLevel ?? 'NONE');
  inst.evidenceLevel = levels.reduce((weakest, l) => (EVIDENCE_ORDER.indexOf(l) < EVIDENCE_ORDER.indexOf(weakest) ? l : weakest), 'VERIFIED' as EvidenceLevel);
  inst.terminalReason = 'ALL_STEPS_PASSED';
  d.setInstance('COMPLETED', { terminalReason: 'ALL_STEPS_PASSED' });
  d.emit('WORKFLOW_COMPLETED', 'workflow-engine', { payload: { evidenceLevel: inst.evidenceLevel } });
}

// ---------------------------------------------------------------------------
// draft (mutable working copy of one decision)
// ---------------------------------------------------------------------------

class Draft {
  readonly def: WorkflowDefinition;
  readonly inst: WorkflowInstance;
  readonly at: string;
  readonly events: WorkflowEventDraft[] = [];
  readonly commands: WorkflowCommand[] = [];
  /** A step failed in this decision; the boundary turns it into the terminal reason. */
  failure: WorkflowTerminalReason | null = null;
  private readonly before: string;

  constructor(def: WorkflowDefinition, instance: WorkflowInstance, at: string) {
    this.def = def;
    this.inst = structuredClone(instance);
    this.at = at;
    this.before = canonicalJson(instance);
  }

  changed(): boolean {
    return this.events.length > 0 || this.commands.length > 0 || canonicalJson(this.inst) !== this.before;
  }

  emit(type: WorkflowEventDraft['type'], actor: WorkflowActor, o: { attempt?: WorkflowAttempt; attemptId?: string | null; stepId?: string | null; payload?: WorkflowEventPayload } = {}): void {
    this.events.push(
      draftEvent(type, this.at, actor, {
        stepId: o.attempt?.stepId ?? o.stepId ?? null,
        attemptId: o.attempt?.attemptId ?? o.attemptId ?? null,
        executionId: o.attempt?.executionId ?? null,
        payload: o.payload,
      }),
    );
  }

  setInstance(to: WorkflowInstanceState, extra: WorkflowEventPayload = {}): void {
    const from = this.inst.state;
    assertValidInstanceTransition(from, to);
    if (from === to) return;
    this.inst.state = to;
    if (TERMINAL_INSTANCE_STATES.includes(to)) this.inst.endedAt = this.at;
    this.emit('WORKFLOW_STATE_CHANGED', 'workflow-engine', { payload: { from, to, ...extra } });
  }

  setStep(step: WorkflowStepRuntime, to: WorkflowStepState): void {
    const from = step.state;
    assertValidStepTransition(from, to);
    if (from === to) return;
    step.state = to;
    this.emit('STEP_STATE_CHANGED', 'workflow-engine', { stepId: step.stepId, payload: { from, to } });
  }

  setAttempt(att: WorkflowAttempt, to: WorkflowAttemptState): void {
    const from = att.state;
    assertValidAttemptTransition(from, to);
    att.state = to;
    this.emit('ATTEMPT_STATE_CHANGED', 'workflow-engine', { attempt: att, payload: { from, to } });
  }

  attempt(attemptId: string): WorkflowAttempt | null {
    for (const s of this.inst.steps) for (const a of s.attempts) if (a.attemptId === attemptId) return a;
    return null;
  }

  stepOf(att: WorkflowAttempt): WorkflowStepRuntime {
    return this.inst.steps.find((s) => s.stepId === att.stepId)!;
  }

  stepDef(step: WorkflowStepRuntime): WorkflowStepDefinition {
    return this.def.steps.find((s) => s.id === step.stepId)!;
  }

  activeStep(): WorkflowStepRuntime | null {
    return this.inst.steps.find((s) => s.state === 'ACTIVE') ?? null;
  }

  /** The single non-terminal attempt, if any. */
  openAttempt(): WorkflowAttempt | null {
    for (const s of this.inst.steps) for (const a of s.attempts) if (!TERMINAL_ATTEMPT_STATES.includes(a.state)) return a;
    return null;
  }

  liveAttempt(): WorkflowAttempt | null {
    const open = this.openAttempt();
    return open && LIVE_ATTEMPT_STATES.includes(open.state) ? open : null;
  }

  lastAttemptOfActiveStep(): WorkflowAttempt | null {
    const step = this.activeStep();
    return step?.attempts.at(-1) ?? null;
  }
}

function draftEvent(
  type: WorkflowEventDraft['type'],
  at: string,
  actor: WorkflowActor,
  o: { stepId?: string | null; attemptId?: string | null; executionId?: string | null; payload?: WorkflowEventPayload } = {},
): WorkflowEventDraft {
  return { type, timestamp: at, stepId: o.stepId ?? null, attemptId: o.attemptId ?? null, executionId: o.executionId ?? null, actor, provider: null, payload: o.payload ?? {}, artifacts: [] };
}

const INPUT_ACTOR: Record<WorkflowInput['type'], WorkflowActor> = {
  START: 'human',
  EXECUTION_LINKED: 'host',
  EXECUTION_PROGRESS: 'host',
  EXECUTION_ENDED: 'host',
  VERIFICATION_COMPLETED: 'verification',
  PAUSE_REQUESTED: 'human',
  RESUME_REQUESTED: 'human',
  STOP_REQUESTED: 'human',
  HUMAN_ANSWER: 'human',
  EXECUTION_HOST_SPAWNED: 'host',
  RECONCILED: 'workflow-engine',
};

/** The first event of every decision: the input itself, so the log alone can replay it. */
function inputEvent(input: WorkflowInput): WorkflowEventDraft {
  const actor = input.type === 'STOP_REQUESTED' && input.cause === 'DEADLINE' ? 'host' : INPUT_ACTOR[input.type];
  return draftEvent('INPUT_RECEIVED', input.at, actor, { attemptId: 'attemptId' in input ? input.attemptId : null, payload: { inputType: input.type, input: canonicalJson(input) } });
}

function notAllowed(reason: string): Rejection {
  return { code: 'NOT_ALLOWED', reason };
}
function unknownAttempt(attemptId: string): Rejection {
  return { code: 'UNKNOWN_ATTEMPT', reason: `unknown attempt ${attemptId}` };
}

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

/** Structural invariants of an instance; throws WORKFLOW_INVARIANT_VIOLATION (a bug, never a
 * user error). Checked on every decision, like assertValidTransition in the Orchestrator. */
export function assertWorkflowInvariants(definition: WorkflowDefinition, inst: WorkflowInstance): void {
  const fail = (msg: string): never => {
    throw new Error(`WORKFLOW_INVARIANT_VIOLATION: ${msg}`);
  };
  if (inst.steps.length !== definition.steps.length || inst.steps.some((s, i) => s.stepId !== definition.steps[i].id)) fail('steps do not match the definition');

  const firstUnfinished = inst.steps.findIndex((s) => s.state !== 'SUCCEEDED');
  inst.steps.forEach((s, i) => {
    if (firstUnfinished !== -1 && i > firstUnfinished && s.state !== 'PENDING') fail(`step ${s.stepId} is ${s.state} although an earlier step has not succeeded`);
    if (s.state === 'PENDING' && s.attempts.length > 0) fail(`pending step ${s.stepId} has attempts`);
    s.attempts.forEach((a, j) => {
      if (a.attemptNo !== j + 1 || a.attemptId !== attemptIdOf(inst.workflowId, s.stepId, j + 1) || a.stepId !== s.stepId) fail(`attempt ${a.attemptId} is misnumbered`);
      if (!TERMINAL_ATTEMPT_STATES.includes(a.state) && (j !== s.attempts.length - 1 || s.state !== 'ACTIVE')) fail(`open attempt ${a.attemptId} is not the latest attempt of the active step`);
    });
  });
  const open = inst.steps.flatMap((s) => s.attempts).filter((a) => !TERMINAL_ATTEMPT_STATES.includes(a.state));
  if (open.length > 1) fail(`${open.length} open attempts (at most one execution at a time)`);
  if (inst.steps.filter((s) => s.state === 'ACTIVE').length > 1) fail('more than one active step');

  if (TERMINAL_INSTANCE_STATES.includes(inst.state)) {
    if (open.length > 0) fail(`terminal workflow has open attempt ${open[0].attemptId}`);
    if (inst.terminalReason === null) fail('terminal workflow without a terminal reason');
  }
  if (inst.state === 'COMPLETED' && inst.steps.some((s) => s.state !== 'SUCCEEDED')) fail('COMPLETED with unfinished steps');
  if (inst.state === 'CREATED' && inst.steps.some((s) => s.attempts.length > 0)) fail('CREATED workflow has attempts');
  if (inst.state === 'RUNNING' && open.length === 0) fail('RUNNING workflow with nothing in flight');
  if ((inst.state === 'WAITING_HUMAN' || inst.state === 'BLOCKED') && inst.waitingFor === null) fail(`${inst.state} without waitingFor`);
}

// ---------------------------------------------------------------------------
// replay (used by the store to re-derive a snapshot after a crash)
// ---------------------------------------------------------------------------

export type ReplayResult =
  | {
      ok: true;
      instance: WorkflowInstance;
      /** State after each complete batch, keyed by the seq of the batch's last event. */
      states: Map<number, WorkflowInstance>;
      /** Events a crash cut off from the END of the last batch; to be appended on repair. */
      missing: WorkflowEventDraft[];
    }
  | { ok: false; reason: string; atSeq: number };

/** The draft fields of a persisted event (drops seq/ids/hash). */
export function eventDraftOf(e: WorkflowEventDraft): WorkflowEventDraft {
  return { type: e.type, timestamp: e.timestamp, stepId: e.stepId, attemptId: e.attemptId, executionId: e.executionId, actor: e.actor, provider: e.provider, payload: e.payload, artifacts: e.artifacts };
}

function sameDraft(a: WorkflowEventDraft, b: WorkflowEventDraft): boolean {
  return canonicalJson(eventDraftOf(a)) === canonicalJson(eventDraftOf(b));
}

/**
 * Rebuilds an instance from its event log alone: WORKFLOW_CREATED, then batches that each
 * start with INPUT_RECEIVED. Every batch must be exactly what the (pure) decider produces
 * for that input; any difference means the log was altered or written by a different
 * decider → not ok. Only the final batch may be cut short (a crash mid-append). Commands
 * are never re-executed — an interrupted START leaves the attempt LAUNCHING, which the
 * reconciler (M5.6) resolves like any other crash after the write-ahead intent.
 */
export function replayWorkflowLog(definition: WorkflowDefinition, events: readonly WorkflowEvent[]): ReplayResult {
  if (events.length === 0 || events[0].type !== 'WORKFLOW_CREATED') return { ok: false, reason: 'the log does not start with WORKFLOW_CREATED', atSeq: events[0]?.seq ?? 0 };
  const first = events[0];
  let values: unknown;
  try {
    values = JSON.parse(String(first.payload.inputs));
  } catch {
    return { ok: false, reason: 'WORKFLOW_CREATED has unreadable inputs', atSeq: first.seq };
  }
  const created = createWorkflowInstance(definition, { workflowId: first.workflowId, definitionHash: String(first.payload.definitionHash), inputs: values, at: first.timestamp });
  if (!created.ok || !sameDraft(created.events[0], first)) return { ok: false, reason: 'WORKFLOW_CREATED does not match this definition', atSeq: first.seq };

  let instance = created.instance;
  const states = new Map<number, WorkflowInstance>([[first.seq, instance]]);
  let i = 1;
  while (i < events.length) {
    const e = events[i];
    if (e.type === 'RECONCILED') {
      states.set(e.seq, instance);
      i += 1;
      continue;
    }
    if (e.type !== 'INPUT_RECEIVED') return { ok: false, reason: `event ${e.type} outside a decision batch`, atSeq: e.seq };
    let input: WorkflowInput;
    try {
      input = JSON.parse(String(e.payload.input)) as WorkflowInput;
    } catch {
      return { ok: false, reason: 'INPUT_RECEIVED has an unreadable input', atSeq: e.seq };
    }
    let decision: WorkflowDecision;
    try {
      decision = decideWorkflow(definition, instance, input);
    } catch (err) {
      return { ok: false, reason: `replaying the input failed: ${err instanceof Error ? err.message : String(err)}`, atSeq: e.seq };
    }
    if (!decision.accepted || decision.events.length === 0) return { ok: false, reason: 'a logged input is not accepted on replay', atSeq: e.seq };
    const expected = decision.events;
    for (let k = 0; k < expected.length; k++) {
      if (i + k >= events.length) {
        return { ok: true, instance: decision.instance, states, missing: expected.slice(k) };
      }
      if (!sameDraft(events[i + k], expected[k])) return { ok: false, reason: `event ${events[i + k].type} differs from the replayed decision`, atSeq: events[i + k].seq };
    }
    instance = decision.instance;
    i += expected.length;
    states.set(events[i - 1].seq, instance);
  }
  return { ok: true, instance, states, missing: [] };
}
