import type { ExecutionFinalStatus, ExecutionResultSummary, ReconcileFinding, WorkflowAttempt } from './types.ts';

/**
 * M5.6 — the reconciler (docs/26 §6): given a LIVE attempt (LAUNCHING / EXECUTING) whose
 * outcome this engine did not see — Workflow Host restart, or HOST_FAILED — and the facts
 * BridgeEngine persisted, decide what is true. Pure. Execution facts win (ADR-014).
 *
 * It never starts a new attempt and never requests a second execution: NOT_STARTED is
 * returned only when no execution for the attempt can exist; an execution that exists is
 * linked, watched, adopted or resumed (the SAME execution); anything ambiguous or unsafe
 * goes to a human (UNRESOLVABLE). Retries are M6.
 */

export interface ReconcileSession {
  runId: string;
  startedAt: string | null;
  /** SessionSummary.status: live display status for the current session, else the recorded final status. */
  status: string;
  iterations: number;
  errorCode: string | null;
  /** The correlation its RUN_STARTED carried (null = none). */
  correlation: string | null;
}

export interface ReconcileFacts {
  nowMs: number;
  /** How long an Execution Host may plausibly still be in preflight (no lock/session yet). */
  preflightGraceMs: number;
  /** BridgeEngine.status() of the project's current session. */
  current: { runId: string | null; status: string };
  /** checkRecovery() says the attempt's execution is RECOVERABLE. */
  recoverable: boolean;
  /** Sessions started at/after the attempt's launch, plus the attempt's own execution. */
  sessions: ReconcileSession[];
  /** Liveness of attempt.hostPid; null when no pid was recorded. */
  hostAlive: boolean | null;
  /** A Claude/Codex process recorded for the attempt's execution is still alive. */
  cliAlive: boolean;
}

export type ReconcileAction =
  | { action: 'LINK'; executionId: string }
  | { action: 'ADOPT'; result: ExecutionResultSummary }
  | { action: 'FINDING'; finding: ReconcileFinding }
  | { action: 'WAIT'; reason: string }
  | { action: 'NONE' };

const FINAL: readonly string[] = ['DONE', 'NEED_HUMAN', 'ERROR', 'STOPPED', 'STOPPED_MAX_ITERATIONS'];
const unresolvable = (reason: string): ReconcileAction => ({ action: 'FINDING', finding: { kind: 'UNRESOLVABLE', reason } });

export function reconcileAttempt(attempt: WorkflowAttempt, facts: ReconcileFacts): ReconcileAction {
  if (attempt.state === 'LAUNCHING') return reconcileLaunching(attempt, facts);
  if (attempt.state === 'EXECUTING' && attempt.executionId !== null) return reconcileExecuting(attempt, attempt.executionId, facts);
  return { action: 'NONE' };
}

function reconcileLaunching(attempt: WorkflowAttempt, facts: ReconcileFacts): ReconcileAction {
  // Only a run carrying THIS attempt's correlation can be its execution (ADR-017); runs of
  // other workflows/attempts or without a correlation are not ours.
  const mine = facts.sessions.filter((s) => s.correlation === attempt.attemptId);
  if (mine.length > 1) return unresolvable('DUPLICATE_EXECUTIONS_FOR_ATTEMPT');
  if (mine.length === 1) return { action: 'LINK', executionId: mine[0].runId };

  const elapsed = facts.nowMs - Date.parse(attempt.launchedAt ?? attempt.plannedAt);
  // A host that is still in preflight holds no lock and has no session yet: relaunching now
  // could produce a second execution. Wait while that is plausible; a human decides after.
  if (facts.hostAlive === true) return elapsed < facts.preflightGraceMs ? { action: 'WAIT', reason: 'EXECUTION_HOST_STILL_STARTING' } : unresolvable('EXECUTION_HOST_ALIVE_WITHOUT_SESSION');
  if (facts.hostAlive === null && elapsed < facts.preflightGraceMs) return { action: 'WAIT', reason: 'LAUNCH_TOO_RECENT_TO_PROVE' };
  return { action: 'FINDING', finding: { kind: 'NOT_STARTED' } };
}

function reconcileExecuting(attempt: WorkflowAttempt, executionId: string, facts: ReconcileFacts): ReconcileAction {
  const session = facts.sessions.find((s) => s.runId === executionId);
  if (!session) return unresolvable('EXECUTION_NOT_FOUND');
  if (session.correlation !== attempt.attemptId) return unresolvable('CORRELATION_MISMATCH');
  const isCurrent = facts.current.runId === executionId;
  const status = isCurrent ? facts.current.status : session.status;

  if (status === 'RUNNING') return { action: 'FINDING', finding: { kind: 'WATCH', executionId } };
  const delta = Math.max(0, session.iterations - attempt.iterationsUsed);
  const adopt = (finalStatus: ExecutionFinalStatus): ReconcileAction => ({
    action: 'ADOPT',
    // Token usage and the usage-limit flag are not re-derived here: UNKNOWN, never guessed.
    result: { kind: 'ENDED', executionId, finalStatus, errorCode: session.errorCode, iterations: delta, reportedTokens: null, usageLimitDetected: false },
  });
  if (FINAL.includes(status)) return adopt(status as ExecutionFinalStatus);
  if (status === 'PAUSED') return isCurrent && facts.recoverable ? adopt('PAUSED') : unresolvable('PAUSED_EXECUTION_NOT_RECOVERABLE');
  if (status === 'INTERRUPTED') {
    // M5.4 note: a crashed Execution Host can leave its Claude/Codex child running; resuming
    // then would run two CLIs on one working tree.
    if (facts.cliAlive) return unresolvable('ORPHANED_CLI_PROCESS_ALIVE');
    return isCurrent && facts.recoverable ? { action: 'FINDING', finding: { kind: 'RESUME', executionId } } : unresolvable('EXECUTION_NOT_RECOVERABLE');
  }
  return unresolvable('EXECUTION_STATE_UNKNOWN');
}
