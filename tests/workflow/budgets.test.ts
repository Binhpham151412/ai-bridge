import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_TOTAL_ITERATIONS, checkResumeBudget, checkStartBudget, deadlineExceeded, effectiveBudgets, workflowUsage } from '../../src/core/workflow/budgets.ts';
import type { WorkflowAttempt, WorkflowInstance } from '../../src/core/workflow/types.ts';
import { at, created, definition } from './runtime-fixtures.ts';

function started(budgets: Record<string, number> = {}): { def: ReturnType<typeof definition>; inst: WorkflowInstance } {
  const def = definition(['build', 'docs'], Object.keys(budgets).length ? { budgets } : {});
  const inst = structuredClone(created(def).instance);
  inst.state = 'RUNNING';
  inst.startedAt = at(0);
  return { def, inst };
}

function addAttempt(inst: WorkflowInstance, stepIndex: number, patch: Partial<WorkflowAttempt>): void {
  const step = inst.steps[stepIndex];
  step.attempts.push({
    attemptId: `${inst.workflowId}/${step.stepId}/${step.attempts.length + 1}`,
    stepId: step.stepId,
    attemptNo: step.attempts.length + 1,
    state: 'PASSED',
    maxIterations: 10,
    maxIterationsClamped: false,
    executionId: 'r',
    plannedAt: at(0),
    launchedAt: at(0),
    endedAt: at(1),
    launches: 1,
    observedIteration: 1,
    iterationsUsed: 1,
    reportedTokens: 0,
    tokensIncomplete: false,
    lastOutcome: null,
    verification: null,
    stopCause: null,
    ...patch,
  });
}

test('documented defaults apply to unset budgets (docs/26 §7)', () => {
  const { def } = started();
  assert.deepEqual(effectiveBudgets(def), { maxDurationMs: DEFAULT_MAX_DURATION_MS, maxTotalIterations: DEFAULT_MAX_TOTAL_ITERATIONS, maxExecutions: 2, maxReportedTokens: null });
  assert.equal(DEFAULT_MAX_DURATION_MS, 8 * 60 * 60 * 1000);
  assert.equal(DEFAULT_MAX_TOTAL_ITERATIONS, 200);
});

test('usage is derived from attempts; NOT_STARTED and PLANNED attempts consume no execution', () => {
  const { inst } = started();
  addAttempt(inst, 0, { state: 'PASSED', iterationsUsed: 4, reportedTokens: 50 });
  addAttempt(inst, 1, { state: 'NOT_STARTED', iterationsUsed: 0 });
  assert.deepEqual(workflowUsage(inst), { executions: 1, iterations: 4, reportedTokens: 50, tokensIncomplete: false });
  inst.steps[1].attempts[0].state = 'LAUNCHING';
  inst.steps[1].attempts[0].tokensIncomplete = true;
  assert.deepEqual(workflowUsage(inst), { executions: 2, iterations: 4, reportedTokens: 50, tokensIncomplete: true });
});

test('deadline: exceeded exactly at maxDurationMs, never before start', () => {
  const { def, inst } = started({ maxDurationMs: 60_000 });
  assert.equal(deadlineExceeded(def, inst, at(0.99)), false);
  assert.equal(deadlineExceeded(def, inst, at(1)), true);
  inst.startedAt = null;
  assert.equal(deadlineExceeded(def, inst, at(999)), false);
});

test('start budget: next maxIterations is clamped to the remaining iteration budget, and the clamp is reported', () => {
  const { def, inst } = started({ maxTotalIterations: 12 });
  assert.deepEqual(checkStartBudget(def, inst, def.steps[0], at(1)), { ok: true, maxIterations: 10, clamped: false });
  addAttempt(inst, 0, { iterationsUsed: 9 });
  assert.deepEqual(checkStartBudget(def, inst, def.steps[1], at(1)), { ok: true, maxIterations: 3, clamped: true });
});

test('start budget reasons follow the documented priority: deadline > executions > iterations > tokens', () => {
  const { def, inst } = started({ maxDurationMs: 60_000, maxExecutions: 1, maxTotalIterations: 3, maxReportedTokens: 10 });
  addAttempt(inst, 0, { iterationsUsed: 3, reportedTokens: 10 });
  assert.deepEqual(checkStartBudget(def, inst, def.steps[1], at(5)), { ok: false, reason: 'DEADLINE_EXCEEDED' });
  assert.deepEqual(checkStartBudget(def, inst, def.steps[1], at(0.5)), { ok: false, reason: 'BUDGET_EXECUTIONS_EXHAUSTED' });

  const iter = started({ maxExecutions: 5, maxTotalIterations: 3, maxReportedTokens: 10 });
  addAttempt(iter.inst, 0, { iterationsUsed: 3, reportedTokens: 10 });
  assert.deepEqual(checkStartBudget(iter.def, iter.inst, iter.def.steps[1], at(1)), { ok: false, reason: 'BUDGET_ITERATIONS_EXHAUSTED' });

  const tok = started({ maxReportedTokens: 10 });
  addAttempt(tok.inst, 0, { iterationsUsed: 1, reportedTokens: 10 });
  assert.deepEqual(checkStartBudget(tok.def, tok.inst, tok.def.steps[1], at(1)), { ok: false, reason: 'BUDGET_TOKENS_EXHAUSTED' });
});

test('unknown token usage never blocks a start by itself', () => {
  const { def, inst } = started({ maxReportedTokens: 10 });
  addAttempt(inst, 0, { reportedTokens: 0, tokensIncomplete: true });
  assert.equal(checkStartBudget(def, inst, def.steps[1], at(1)).ok, true);
});

test('resume budget checks only time and tokens — the execution already exists', () => {
  const { def, inst } = started({ maxDurationMs: 60_000, maxExecutions: 1, maxTotalIterations: 1 });
  addAttempt(inst, 0, { iterationsUsed: 1 });
  assert.deepEqual(checkResumeBudget(def, inst, at(0.5)), { ok: true });
  assert.deepEqual(checkResumeBudget(def, inst, at(2)), { ok: false, reason: 'DEADLINE_EXCEEDED' });
});
