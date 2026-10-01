import type { WorkflowAttemptState, WorkflowInstanceState, WorkflowStepState } from './types.ts';

/**
 * M5.2 — workflow, step and attempt transition tables (docs/22 §4.1, §5, §6). A separate
 * table from the execution state machine (core/state-machine/transitions.ts, unchanged):
 * the two machines are never merged (ADR-002). The decider asserts every change it makes
 * against these tables, the same safety-net pattern as Orchestrator.push().
 */

const INSTANCE: Record<WorkflowInstanceState, readonly WorkflowInstanceState[]> = {
  CREATED: ['RUNNING', 'STOPPED'],
  // RUNNING → RUNNING: step advanced / attempt created (a self-loop, recorded as events).
  RUNNING: ['RUNNING', 'PAUSED', 'WAITING_HUMAN', 'BLOCKED', 'COMPLETED', 'FAILED', 'STOPPED'],
  PAUSED: ['RUNNING', 'STOPPED'],
  WAITING_HUMAN: ['RUNNING', 'FAILED', 'STOPPED'],
  BLOCKED: ['RUNNING', 'STOPPED'],
  COMPLETED: [],
  FAILED: [],
  STOPPED: [],
};

const STEP: Record<WorkflowStepState, readonly WorkflowStepState[]> = {
  PENDING: ['ACTIVE'],
  // ACTIVE → ACTIVE: a new attempt of the same step (M6 retries; unused in M5).
  ACTIVE: ['ACTIVE', 'SUCCEEDED', 'FAILED', 'STOPPED'],
  SUCCEEDED: [],
  FAILED: [],
  STOPPED: [],
};

const ATTEMPT: Record<WorkflowAttemptState, readonly WorkflowAttemptState[]> = {
  PLANNED: ['LAUNCHING', 'STOPPED'],
  // → PLANNED: reconciliation proved the start never happened (docs/26 §6).
  LAUNCHING: ['EXECUTING', 'NOT_STARTED', 'LAUNCH_UNKNOWN', 'PLANNED'],
  // → NOT_STARTED: the cost guard refused inside the run (BLOCKED_API_AUTH, docs/26 §3).
  EXECUTING: ['PAUSED_EXECUTION', 'EXECUTION_ENDED', 'EXECUTION_FAILED', 'NEEDS_HUMAN', 'STOPPED', 'NOT_STARTED'],
  PAUSED_EXECUTION: ['EXECUTING', 'STOPPED', 'NEEDS_HUMAN'],
  // → REJECTED without verifying: STOPPED_MAX_ITERATIONS when the policy does not accept it.
  EXECUTION_ENDED: ['VERIFYING', 'REJECTED', 'STOPPED'],
  VERIFYING: ['PASSED', 'REJECTED', 'NEEDS_HUMAN', 'STOPPED'],
  LAUNCH_UNKNOWN: ['EXECUTING', 'NEEDS_HUMAN', 'PLANNED', 'STOPPED'],
  // Terminal for its launch; a user restart from BLOCKED relaunches the same attempt
  // (docs/22 §6 — no attempt is consumed by a start BridgeEngine refused).
  NOT_STARTED: ['LAUNCHING'],
  PASSED: [],
  REJECTED: [],
  EXECUTION_FAILED: [],
  NEEDS_HUMAN: [],
  STOPPED: [],
};

function check<S extends string>(table: Record<S, readonly S[]>, kind: string, from: S, to: S): void {
  if (!(table[from]?.includes(to) ?? false)) throw new Error(`INVALID_WORKFLOW_TRANSITION: ${kind} ${from} -> ${to} is not allowed`);
}

export function isValidInstanceTransition(from: WorkflowInstanceState, to: WorkflowInstanceState): boolean {
  return INSTANCE[from]?.includes(to) ?? false;
}
export function isValidStepTransition(from: WorkflowStepState, to: WorkflowStepState): boolean {
  return STEP[from]?.includes(to) ?? false;
}
export function isValidAttemptTransition(from: WorkflowAttemptState, to: WorkflowAttemptState): boolean {
  return ATTEMPT[from]?.includes(to) ?? false;
}

export function assertValidInstanceTransition(from: WorkflowInstanceState, to: WorkflowInstanceState): void {
  check(INSTANCE, 'instance', from, to);
}
export function assertValidStepTransition(from: WorkflowStepState, to: WorkflowStepState): void {
  check(STEP, 'step', from, to);
}
export function assertValidAttemptTransition(from: WorkflowAttemptState, to: WorkflowAttemptState): void {
  check(ATTEMPT, 'attempt', from, to);
}
