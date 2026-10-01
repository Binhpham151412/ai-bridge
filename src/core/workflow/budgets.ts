import type { WorkflowDefinition, WorkflowStepDefinition } from './definition.ts';
import type { WorkflowAttempt, WorkflowInstance, WorkflowTerminalReason } from './types.ts';

/**
 * M5.2 — workflow budgets (docs/26 §7, ADR-009). Pure: time comes from the caller.
 * Budgets are checked at boundaries only; a value beyond a hard cap never reaches here
 * (the definition validator rejects it). The one permitted adjustment is lowering the next
 * execution's maxIterations to the remaining iteration budget — and that clamp is recorded
 * on the attempt, never silent.
 */

/** Documented defaults (docs/26 §7) for budgets a definition leaves unset. */
export const DEFAULT_MAX_DURATION_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_MAX_TOTAL_ITERATIONS = 200;

export interface EffectiveBudgets {
  maxDurationMs: number;
  maxTotalIterations: number;
  /** Default: steps × maxAttempts (M5: one attempt per step). */
  maxExecutions: number;
  maxReportedTokens: number | null;
}

export function effectiveBudgets(definition: WorkflowDefinition): EffectiveBudgets {
  const b = definition.budgets ?? {};
  const attemptsPerStep = definition.steps.reduce((sum, s) => sum + s.retry.maxAttempts, 0);
  return {
    maxDurationMs: b.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    maxTotalIterations: b.maxTotalIterations ?? DEFAULT_MAX_TOTAL_ITERATIONS,
    maxExecutions: b.maxExecutions ?? attemptsPerStep,
    maxReportedTokens: b.maxReportedTokens ?? null,
  };
}

export interface WorkflowUsage {
  /** Attempts that consumed an execution (every state from LAUNCHING on, except NOT_STARTED). */
  executions: number;
  iterations: number;
  reportedTokens: number;
  /** At least one execution reported no usable token usage (docs/26 §7). */
  tokensIncomplete: boolean;
}

function consumesExecution(a: WorkflowAttempt): boolean {
  return a.state !== 'PLANNED' && a.state !== 'NOT_STARTED';
}

/** Derived from the attempts — there are no separate counters that could drift. */
export function workflowUsage(instance: WorkflowInstance): WorkflowUsage {
  const attempts = instance.steps.flatMap((s) => s.attempts);
  return {
    executions: attempts.filter(consumesExecution).length,
    iterations: attempts.reduce((n, a) => n + a.iterationsUsed, 0),
    reportedTokens: attempts.reduce((n, a) => n + a.reportedTokens, 0),
    tokensIncomplete: attempts.some((a) => a.tokensIncomplete),
  };
}

export function deadlineExceeded(definition: WorkflowDefinition, instance: WorkflowInstance, at: string): boolean {
  if (instance.startedAt === null) return false;
  return Date.parse(at) - Date.parse(instance.startedAt) >= effectiveBudgets(definition).maxDurationMs;
}

export type StartBudgetCheck =
  | { ok: true; maxIterations: number; clamped: boolean }
  | { ok: false; reason: Extract<WorkflowTerminalReason, 'DEADLINE_EXCEEDED' | 'BUDGET_EXECUTIONS_EXHAUSTED' | 'BUDGET_ITERATIONS_EXHAUSTED' | 'BUDGET_TOKENS_EXHAUSTED'> };

/**
 * May a NEW execution start now? Reasons in the documented priority order (docs/22 §7.6):
 * DEADLINE_EXCEEDED > BUDGET_EXECUTIONS > BUDGET_ITERATIONS > BUDGET_TOKENS.
 * Relaunching a NOT_STARTED attempt uses the same check: NOT_STARTED attempts are not
 * counted as executions (workflowUsage), so a refused start never consumes budget.
 */
export function checkStartBudget(definition: WorkflowDefinition, instance: WorkflowInstance, step: WorkflowStepDefinition, at: string): StartBudgetCheck {
  const budgets = effectiveBudgets(definition);
  const usage = workflowUsage(instance);
  if (deadlineExceeded(definition, instance, at)) return { ok: false, reason: 'DEADLINE_EXCEEDED' };
  if (usage.executions >= budgets.maxExecutions) return { ok: false, reason: 'BUDGET_EXECUTIONS_EXHAUSTED' };
  const remaining = budgets.maxTotalIterations - usage.iterations;
  if (remaining < 1) return { ok: false, reason: 'BUDGET_ITERATIONS_EXHAUSTED' };
  if (budgets.maxReportedTokens !== null && usage.reportedTokens >= budgets.maxReportedTokens) return { ok: false, reason: 'BUDGET_TOKENS_EXHAUSTED' };
  const wanted = step.executor.maxIterations;
  return { ok: true, maxIterations: Math.min(wanted, remaining), clamped: remaining < wanted };
}

/** Resuming the SAME execution needs no new execution/iteration budget — only time and tokens. */
export function checkResumeBudget(definition: WorkflowDefinition, instance: WorkflowInstance, at: string): { ok: true } | { ok: false; reason: 'DEADLINE_EXCEEDED' | 'BUDGET_TOKENS_EXHAUSTED' } {
  const budgets = effectiveBudgets(definition);
  if (deadlineExceeded(definition, instance, at)) return { ok: false, reason: 'DEADLINE_EXCEEDED' };
  if (budgets.maxReportedTokens !== null && workflowUsage(instance).reportedTokens >= budgets.maxReportedTokens) return { ok: false, reason: 'BUDGET_TOKENS_EXHAUSTED' };
  return { ok: true };
}
