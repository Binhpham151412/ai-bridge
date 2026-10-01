import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutionResult } from '../../src/core/workflow/outcome-mapper.ts';
import type { ExecutionResultSummary } from '../../src/core/workflow/types.ts';
import { ended } from './runtime-fixtures.ts';

const POLICY = { acceptMaxIterationsOutcome: false };
const err = (errorCode: string | null, o: Partial<Extract<ExecutionResultSummary, { kind: 'ENDED' }>> = {}) => ended('2026-10-01_001', 'ERROR', { errorCode, ...o });

// One row per line of docs/26 §3: [description, result, effect, class, retryable].
const ROWS: [string, ExecutionResultSummary, string, string, string][] = [
  ['NOT_STARTED BLOCKED_PREFLIGHT', { kind: 'NOT_STARTED', reason: 'BLOCKED_PREFLIGHT' }, 'NOT_STARTED', 'ENVIRONMENT', 'NO'],
  ['NOT_STARTED ALREADY_RUNNING', { kind: 'NOT_STARTED', reason: 'ALREADY_RUNNING' }, 'NOT_STARTED', 'ENVIRONMENT', 'NO'],
  ['NOT_STARTED INVALID_OPTIONS', { kind: 'NOT_STARTED', reason: 'INVALID_OPTIONS' }, 'NOT_STARTED', 'DEFINITION', 'NO'],
  ['COMPLETED DONE', ended('r', 'DONE'), 'VERIFY', 'CLAIM_DONE', 'N/A'],
  ['COMPLETED STOPPED_MAX_ITERATIONS (not accepted)', ended('r', 'STOPPED_MAX_ITERATIONS'), 'REJECT', 'ITERATIONS_EXHAUSTED', 'YES'],
  ['COMPLETED NEED_HUMAN', ended('r', 'NEED_HUMAN'), 'NEEDS_HUMAN', 'HUMAN_REQUESTED', 'NO'],
  ['COMPLETED PAUSED', ended('r', 'PAUSED'), 'PAUSED_EXECUTION', 'PAUSED', 'N/A'],
  ['COMPLETED STOPPED', ended('r', 'STOPPED'), 'STOPPED', 'STOPPED', 'NO'],
  ['CLAUDE SPAWN_FAILED', err('CLAUDE_RUN_FAILED:SPAWN_FAILED'), 'EXECUTION_FAILED', 'TRANSIENT_INFRA', 'YES'],
  ['CLAUDE TIMEOUT', err('CLAUDE_RUN_FAILED:TIMEOUT'), 'EXECUTION_FAILED', 'EXECUTOR_TIMEOUT', 'OPT_IN'],
  ['CLAUDE NON_ZERO_EXIT + usage limit', err('CLAUDE_RUN_FAILED:NON_ZERO_EXIT', { usageLimitDetected: true }), 'NEEDS_HUMAN', 'QUOTA', 'NEVER'],
  ['CLAUDE NON_ZERO_EXIT (other)', err('CLAUDE_RUN_FAILED:NON_ZERO_EXIT'), 'EXECUTION_FAILED', 'EXECUTOR_FAILED', 'OPT_IN'],
  ['CLAUDE BAD_JSON', err('CLAUDE_RUN_FAILED:BAD_JSON'), 'NEEDS_HUMAN', 'CONTRACT_ANOMALY', 'NO'],
  ['CLAUDE NO_RESULT_EVENT', err('CLAUDE_RUN_FAILED:NO_RESULT_EVENT'), 'NEEDS_HUMAN', 'CONTRACT_ANOMALY', 'NO'],
  ['CLAUDE SESSION_MISMATCH', err('CLAUDE_RUN_FAILED:SESSION_MISMATCH'), 'NEEDS_HUMAN', 'CONTRACT_ANOMALY', 'NO'],
  ['REPORT_INVALID', err('REPORT_INVALID'), 'EXECUTION_FAILED', 'REPORT_MISSING_OR_INVALID', 'ONCE'],
  ['CODEX_RUN_FAILED:TIMEOUT', err('CODEX_RUN_FAILED:TIMEOUT'), 'NEEDS_HUMAN', 'REVIEWER_FAILED', 'NO'],
  ['CODEX_RUN_FAILED:THREAD_MISMATCH', err('CODEX_RUN_FAILED:THREAD_MISMATCH'), 'NEEDS_HUMAN', 'REVIEWER_FAILED', 'NO'],
  ['RESPONSE_INVALID', err('RESPONSE_INVALID'), 'NEEDS_HUMAN', 'REVIEWER_OUTPUT_INVALID', 'NO'],
  ['PROMPT_INTEGRITY_FAILURE', err('PROMPT_INTEGRITY_FAILURE'), 'EXECUTION_FAILED', 'INTEGRITY', 'NEVER'],
  ['REPORT_TRANSPORT_INTEGRITY_FAILURE', err('REPORT_TRANSPORT_INTEGRITY_FAILURE'), 'EXECUTION_FAILED', 'INTEGRITY', 'NEVER'],
  ['BLOCKED_API_AUTH', err('BLOCKED_API_AUTH'), 'NOT_STARTED', 'COST_GUARD', 'NEVER'],
  ['RESUME_REFUSED RECOVERY_BLOCKED', { kind: 'RESUME_REFUSED', reason: 'RECOVERY_BLOCKED' }, 'NEEDS_HUMAN', 'AMBIGUOUS_RECOVERY', 'NO'],
  ['RESUME_REFUSED NOT_CURRENT_SESSION', { kind: 'RESUME_REFUSED', reason: 'NOT_CURRENT_SESSION' }, 'NEEDS_HUMAN', 'AMBIGUOUS_RECOVERY', 'NO'],
  ['RESUME_REFUSED NO_STATE', { kind: 'RESUME_REFUSED', reason: 'NO_STATE' }, 'NEEDS_HUMAN', 'AMBIGUOUS_RECOVERY', 'NO'],
  ['HOST_FAILED', { kind: 'HOST_FAILED', executionId: null }, 'RECONCILE', 'RECONCILE_REQUIRED', 'N/A'],
];

for (const [name, result, effect, cls, retryable] of ROWS) {
  test(`classifies ${name}`, () => {
    assert.deepEqual(classifyExecutionResult(result, POLICY), { effect, class: cls, retryable });
  });
}

test('STOPPED_MAX_ITERATIONS is verified only when the step policy accepts it (M6)', () => {
  assert.equal(classifyExecutionResult(ended('r', 'STOPPED_MAX_ITERATIONS'), { acceptMaxIterationsOutcome: true }).effect, 'VERIFY');
});

test('unknown or missing error codes are NEEDS_HUMAN, never retryable', () => {
  for (const code of [null, 'CRASH_INJECTED:AFTER_CLAUDE_STARTED', 'SOMETHING_NEW', 'toString', '__proto__', 'CLAUDE_RUN_FAILED:NEW_CODE']) {
    assert.deepEqual(classifyExecutionResult(err(code), POLICY), { effect: 'NEEDS_HUMAN', class: 'UNKNOWN', retryable: 'NO' }, String(code));
  }
});

test('the usage-limit flag only matters for the Claude NON_ZERO_EXIT row', () => {
  assert.equal(classifyExecutionResult(err('CLAUDE_RUN_FAILED:TIMEOUT', { usageLimitDetected: true }), POLICY).class, 'EXECUTOR_TIMEOUT');
  assert.equal(classifyExecutionResult(ended('r', 'DONE', { usageLimitDetected: true }), POLICY).class, 'CLAIM_DONE');
});
