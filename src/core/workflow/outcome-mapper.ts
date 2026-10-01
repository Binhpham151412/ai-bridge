import type { ExecutionResultSummary, OutcomeClass, Retryability } from './types.ts';

/**
 * M5.2 — the outcome classification table (docs/26 §3), as data plus one pure function.
 * Maps what an execution produced to what happens to the attempt. It classifies only —
 * it never retries (M5 has no retries, ADR-020) and never reads CLI output itself (the
 * future ExecutionPort supplies `usageLimitDetected`). Unknown error codes are NEEDS_HUMAN,
 * never retry.
 */

export type AttemptEffect =
  /** Execution claims DONE → verify. */
  | 'VERIFY'
  /** Execution ended but the result is not acceptable without verification (max iterations). */
  | 'REJECT'
  | 'EXECUTION_FAILED'
  | 'NEEDS_HUMAN'
  | 'PAUSED_EXECUTION'
  | 'STOPPED'
  /** BridgeEngine refused before any work: no attempt consumed. */
  | 'NOT_STARTED'
  /** Unknown ending — the reconciler (M5.6) must establish the facts first. */
  | 'RECONCILE';

export interface OutcomeClassification {
  effect: AttemptEffect;
  class: OutcomeClass;
  retryable: Retryability;
}

const row = (effect: AttemptEffect, cls: OutcomeClass, retryable: Retryability): OutcomeClassification => ({ effect, class: cls, retryable });

/** Exact-match error codes (docs/26 §3). */
const ERROR_CODES: Record<string, OutcomeClassification> = {
  'CLAUDE_RUN_FAILED:SPAWN_FAILED': row('EXECUTION_FAILED', 'TRANSIENT_INFRA', 'YES'),
  'CLAUDE_RUN_FAILED:TIMEOUT': row('EXECUTION_FAILED', 'EXECUTOR_TIMEOUT', 'OPT_IN'),
  'CLAUDE_RUN_FAILED:NON_ZERO_EXIT': row('EXECUTION_FAILED', 'EXECUTOR_FAILED', 'OPT_IN'),
  'CLAUDE_RUN_FAILED:BAD_JSON': row('NEEDS_HUMAN', 'CONTRACT_ANOMALY', 'NO'),
  'CLAUDE_RUN_FAILED:NO_RESULT_EVENT': row('NEEDS_HUMAN', 'CONTRACT_ANOMALY', 'NO'),
  'CLAUDE_RUN_FAILED:SESSION_MISMATCH': row('NEEDS_HUMAN', 'CONTRACT_ANOMALY', 'NO'),
  REPORT_INVALID: row('EXECUTION_FAILED', 'REPORT_MISSING_OR_INVALID', 'ONCE'),
  RESPONSE_INVALID: row('NEEDS_HUMAN', 'REVIEWER_OUTPUT_INVALID', 'NO'),
  PROMPT_INTEGRITY_FAILURE: row('EXECUTION_FAILED', 'INTEGRITY', 'NEVER'),
  REPORT_TRANSPORT_INTEGRITY_FAILURE: row('EXECUTION_FAILED', 'INTEGRITY', 'NEVER'),
  BLOCKED_API_AUTH: row('NOT_STARTED', 'COST_GUARD', 'NEVER'),
};

const QUOTA = row('NEEDS_HUMAN', 'QUOTA', 'NEVER');
const REVIEWER_FAILED = row('NEEDS_HUMAN', 'REVIEWER_FAILED', 'NO');
const UNKNOWN = row('NEEDS_HUMAN', 'UNKNOWN', 'NO');

export function classifyExecutionResult(result: ExecutionResultSummary, policy: { acceptMaxIterationsOutcome: boolean }): OutcomeClassification {
  switch (result.kind) {
    case 'NOT_STARTED':
      return result.reason === 'INVALID_OPTIONS' ? row('NOT_STARTED', 'DEFINITION', 'NO') : row('NOT_STARTED', 'ENVIRONMENT', 'NO');
    case 'RESUME_REFUSED':
      return row('NEEDS_HUMAN', 'AMBIGUOUS_RECOVERY', 'NO');
    case 'HOST_FAILED':
      return row('RECONCILE', 'RECONCILE_REQUIRED', 'N/A');
    case 'ENDED':
      break;
  }
  switch (result.finalStatus) {
    case 'DONE':
      return row('VERIFY', 'CLAIM_DONE', 'N/A');
    case 'STOPPED_MAX_ITERATIONS':
      return row(policy.acceptMaxIterationsOutcome ? 'VERIFY' : 'REJECT', 'ITERATIONS_EXHAUSTED', 'YES');
    case 'NEED_HUMAN':
      return row('NEEDS_HUMAN', 'HUMAN_REQUESTED', 'NO');
    case 'PAUSED':
      return row('PAUSED_EXECUTION', 'PAUSED', 'N/A');
    case 'STOPPED':
      return row('STOPPED', 'STOPPED', 'NO');
    case 'ERROR':
      break;
  }
  const code = result.errorCode;
  if (code === null) return UNKNOWN;
  if (code === 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT' && result.usageLimitDetected) return QUOTA;
  if (Object.hasOwn(ERROR_CODES, code)) return ERROR_CODES[code];
  if (code.startsWith('CODEX_RUN_FAILED:')) return REVIEWER_FAILED;
  return UNKNOWN;
}
