/**
 * M5.2 — workflow RUNTIME types (docs/22, docs/26 §3, docs/27 §3.2). Kept separate from the
 * declarative definition types (definition.ts): a definition is immutable data, an instance
 * is the state the WorkflowEngine owns and persists (docs/21 §3.1, ADR-002). No execution
 * state lives here — an attempt only *references* its execution by runId (ADR-014).
 *
 * Everything is plain, JSON-serializable data so it can be persisted (M5.3) and shown by
 * hosts/UI (M5.8+) unchanged.
 */

export const WORKFLOW_INSTANCE_SCHEMA = 1;

/** `wf_YYYY-MM-DD_NNN` (docs/23 §5) — same allocation style as runId, separate namespace. */
export const WORKFLOW_ID_PATTERN = /^wf_\d{4}-\d{2}-\d{2}_\d{3}$/;

export function isValidWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_ID_PATTERN.test(value);
}

/** `<workflowId>/<stepId>/<n>` (docs/23 §5). */
export function attemptIdOf(workflowId: string, stepId: string, attemptNo: number): string {
  return `${workflowId}/${stepId}/${attemptNo}`;
}

// ---------------------------------------------------------------------------
// states (docs/22 §4–6)
// ---------------------------------------------------------------------------

export const WORKFLOW_INSTANCE_STATES = ['CREATED', 'RUNNING', 'PAUSED', 'WAITING_HUMAN', 'BLOCKED', 'COMPLETED', 'FAILED', 'STOPPED'] as const;
export type WorkflowInstanceState = (typeof WORKFLOW_INSTANCE_STATES)[number];
export const TERMINAL_INSTANCE_STATES: readonly WorkflowInstanceState[] = ['COMPLETED', 'FAILED', 'STOPPED'];

/** SKIPPED is a FUTURE EXTENSION (conditional steps) and deliberately not part of M5. */
export const WORKFLOW_STEP_STATES = ['PENDING', 'ACTIVE', 'SUCCEEDED', 'FAILED', 'STOPPED'] as const;
export type WorkflowStepState = (typeof WORKFLOW_STEP_STATES)[number];

export const WORKFLOW_ATTEMPT_STATES = [
  'PLANNED',
  'LAUNCHING',
  'EXECUTING',
  'PAUSED_EXECUTION',
  'EXECUTION_ENDED',
  'VERIFYING',
  'PASSED',
  'REJECTED',
  'EXECUTION_FAILED',
  'NEEDS_HUMAN',
  'STOPPED',
  'NOT_STARTED',
  'LAUNCH_UNKNOWN',
] as const;
export type WorkflowAttemptState = (typeof WORKFLOW_ATTEMPT_STATES)[number];
/** Terminal for the attempt. NOT_STARTED is terminal for its launch; a user restart from
 * BLOCKED relaunches the same attempt (docs/22 §6: "the attempt number is reused"). */
export const TERMINAL_ATTEMPT_STATES: readonly WorkflowAttemptState[] = ['PASSED', 'REJECTED', 'EXECUTION_FAILED', 'NEEDS_HUMAN', 'STOPPED', 'NOT_STARTED'];
/** A live execution process may exist (stop must go through BridgeEngine.stop()). */
export const LIVE_ATTEMPT_STATES: readonly WorkflowAttemptState[] = ['LAUNCHING', 'EXECUTING'];

/** docs/22 §7.6. */
export type WorkflowTerminalReason =
  | 'ALL_STEPS_PASSED'
  | 'STEP_FAILED'
  | 'ATTEMPTS_EXHAUSTED'
  | 'BUDGET_EXECUTIONS_EXHAUSTED'
  | 'BUDGET_ITERATIONS_EXHAUSTED'
  | 'BUDGET_TOKENS_EXHAUSTED'
  | 'DEADLINE_EXCEEDED'
  | 'DEFINITION_INVALID'
  | 'HUMAN_MARKED_FAILED'
  | 'STOPPED_BY_USER';

/** docs/24 §3.2. M5 only ever produces AI_ATTESTED (ADR-020); VERIFIED arrives with M6. */
export type EvidenceLevel = 'NONE' | 'AI_ATTESTED' | 'VERIFIED';
export type VerificationVerdict = 'PASS' | 'FAIL' | 'NEEDS_HUMAN';
export type StopCause = 'USER' | 'DEADLINE';

// ---------------------------------------------------------------------------
// execution results as seen by the workflow (docs/23 §3, docs/26 §3)
// ---------------------------------------------------------------------------

export type ExecutionFinalStatus = 'DONE' | 'NEED_HUMAN' | 'ERROR' | 'STOPPED' | 'STOPPED_MAX_ITERATIONS' | 'PAUSED';

/**
 * What an execution produced, reduced to the facts the workflow decides on. Structurally
 * mirrors docs/23 `ExecutionResult` without importing BridgeEngine (only the future
 * ExecutionPort, M5.4, may do that). `iterations`/`reportedTokens`/`usageLimitDetected` are
 * filled by the port from BridgeRunOutcome + execution records; `reportedTokens: null`
 * means the CLI reported no usable usage (UNKNOWN — never estimated).
 */
export type ExecutionResultSummary =
  | {
      kind: 'ENDED';
      executionId: string;
      finalStatus: ExecutionFinalStatus;
      errorCode: string | null;
      iterations: number;
      reportedTokens: number | null;
      /** The CLI's error text matched a plan/usage-limit phrase (providers' detectUsageLimit). */
      usageLimitDetected: boolean;
    }
  | { kind: 'NOT_STARTED'; reason: 'BLOCKED_PREFLIGHT' | 'ALREADY_RUNNING' | 'INVALID_OPTIONS' }
  | { kind: 'RESUME_REFUSED'; reason: 'NO_STATE' | 'RECOVERY_BLOCKED' | 'NOT_CURRENT_SESSION' }
  | { kind: 'HOST_FAILED'; executionId: string | null };

/** docs/26 §3 classes. */
export type OutcomeClass =
  | 'ENVIRONMENT'
  | 'DEFINITION'
  | 'CLAIM_DONE'
  | 'ITERATIONS_EXHAUSTED'
  | 'HUMAN_REQUESTED'
  | 'PAUSED'
  | 'STOPPED'
  | 'TRANSIENT_INFRA'
  | 'EXECUTOR_TIMEOUT'
  | 'QUOTA'
  | 'EXECUTOR_FAILED'
  | 'CONTRACT_ANOMALY'
  | 'REPORT_MISSING_OR_INVALID'
  | 'REVIEWER_FAILED'
  | 'REVIEWER_OUTPUT_INVALID'
  | 'INTEGRITY'
  | 'COST_GUARD'
  | 'AMBIGUOUS_RECOVERY'
  | 'VERIFICATION_FAILED'
  | 'RECONCILE_REQUIRED'
  | 'UNKNOWN';

/** "retryable by default" (docs/26 §3). Informational in M5 — no retries exist before M6. */
export type Retryability = 'NEVER' | 'NO' | 'OPT_IN' | 'ONCE' | 'YES' | 'N/A';

// ---------------------------------------------------------------------------
// instance snapshot
// ---------------------------------------------------------------------------

export interface AttemptOutcomeRecord {
  kind: ExecutionResultSummary['kind'];
  finalStatus: ExecutionFinalStatus | null;
  errorCode: string | null;
  class: OutcomeClass;
  retryable: Retryability;
}

export interface WorkflowAttempt {
  attemptId: string;
  stepId: string;
  attemptNo: number;
  state: WorkflowAttemptState;
  /** Effective maxIterations for this attempt's execution (after the budget clamp). */
  maxIterations: number;
  /** True when the workflow iteration budget lowered it below the step's own value (docs/26 §7). */
  maxIterationsClamped: boolean;
  /** runId, once known (RUN_STARTED / outcome). */
  executionId: string | null;
  plannedAt: string;
  launchedAt: string | null;
  endedAt: string | null;
  /** Times this attempt was launched — >1 only after BLOCKED restarts (NOT_STARTED relaunch). */
  launches: number;
  /** Highest iteration the execution reported (drives the pending-pause rule, docs/22 §7.1). */
  observedIteration: number;
  /** Sum over this attempt's execution segments (start + resumes). */
  iterationsUsed: number;
  reportedTokens: number;
  /** Some segment reported no usable token usage. */
  tokensIncomplete: boolean;
  lastOutcome: AttemptOutcomeRecord | null;
  verification: { verdict: VerificationVerdict; evidenceLevel: EvidenceLevel; failureSummary: string | null } | null;
  stopCause: StopCause | null;
  /** M5.6: pid of the Execution Host last spawned for this attempt (for reconciliation after
   * a Workflow Host crash); absent until a host was spawned. */
  hostPid?: number | null;
  /** M5.10.1: execution-level permission override. Absent = inherit the project setting;
   * `bypass` only on an attempt a human approved with `approve-bypass`. */
  permissionPolicy?: 'bypass';
}

/** M5.6: what the reconciler established about a live attempt after a restart / host failure
 * (docs/26 §6). Consumed by the decider as a RECONCILED input, so it is logged and replayable. */
export type ReconcileFinding =
  /** LAUNCHING, and it is proven that no execution exists for the attempt → launch it again
   * (same attempt; not a retry — nothing ran). */
  | { kind: 'NOT_STARTED' }
  /** The attempt's execution is still running in a host we are not attached to → watch it. */
  | { kind: 'WATCH'; executionId: string }
  /** The attempt's execution was interrupted and BridgeEngine says it is RECOVERABLE → resume it. */
  | { kind: 'RESUME'; executionId: string }
  /** The facts are ambiguous or unsafe → a human decides. */
  | { kind: 'UNRESOLVABLE'; reason: string };

export interface WorkflowStepRuntime {
  stepId: string;
  state: WorkflowStepState;
  /** Evidence level of the attempt that made the step SUCCEEDED. */
  evidenceLevel: EvidenceLevel | null;
  attempts: WorkflowAttempt[];
}

export interface WorkflowWaitingFor {
  kind: 'HUMAN' | 'ENVIRONMENT';
  /** Machine-readable reason (an OutcomeClass or a NOT_STARTED reason). */
  reason: string;
  attemptId: string | null;
  /** Answers/actions currently possible (docs/22 §9). */
  options: string[];
}

export interface WorkflowInstance {
  schema: typeof WORKFLOW_INSTANCE_SCHEMA;
  workflowId: string;
  definitionId: string;
  definitionVersion: number;
  /** Pinned at creation (ADR-018). */
  definitionHash: string;
  state: WorkflowInstanceState;
  /** Input values supplied at creation, validated against the definition's inputs. */
  inputs: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  steps: WorkflowStepRuntime[];
  pauseRequested: boolean;
  /** PAUSE_EXECUTION was already issued for the live execution. */
  pauseForwarded: boolean;
  stopRequested: StopCause | null;
  waitingFor: WorkflowWaitingFor | null;
  terminalReason: WorkflowTerminalReason | null;
  evidenceLevel: EvidenceLevel | null;
}

// ---------------------------------------------------------------------------
// decider inputs and commands
// ---------------------------------------------------------------------------

/** Every input carries its time — the decider never reads a clock. */
export type WorkflowInput =
  | { type: 'START'; at: string }
  | { type: 'EXECUTION_LINKED'; at: string; attemptId: string; executionId: string }
  | { type: 'EXECUTION_PROGRESS'; at: string; attemptId: string; iteration: number }
  | { type: 'EXECUTION_ENDED'; at: string; attemptId: string; result: ExecutionResultSummary }
  | { type: 'VERIFICATION_COMPLETED'; at: string; attemptId: string; verdict: VerificationVerdict; evidenceLevel: EvidenceLevel; failureSummary: string | null }
  | { type: 'PAUSE_REQUESTED'; at: string }
  | { type: 'RESUME_REQUESTED'; at: string }
  | { type: 'STOP_REQUESTED'; at: string; cause: StopCause }
  /** `approve-bypass` (M5.10.1, docs/61 §13): the human approves privileged actions for the
   * step that asked for a human — one new attempt of that step with permission policy bypass. */
  | { type: 'HUMAN_ANSWER'; at: string; answer: 'fail' | 'stop' | 'retry' | 'resume-execution' | 'approve-bypass' }
  /** M5.6: the Execution Host for the attempt's (re)launch was spawned with this pid. */
  | { type: 'EXECUTION_HOST_SPAWNED'; at: string; attemptId: string; hostPid: number }
  /** M5.6: the reconciler's finding for a live attempt. */
  | { type: 'RECONCILED'; at: string; attemptId: string; finding: ReconcileFinding };

/** Side effects for the engine shell to carry out AFTER the decision is persisted. */
export type WorkflowCommand =
  | { type: 'START_EXECUTION'; attemptId: string; stepId: string; maxIterations: number; permissionPolicy?: 'bypass' }
  | { type: 'RESUME_EXECUTION'; attemptId: string; executionId: string }
  | { type: 'PAUSE_EXECUTION'; attemptId: string }
  | { type: 'STOP_EXECUTION'; attemptId: string }
  | { type: 'VERIFY'; attemptId: string }
  /** The execution host vanished without an outcome — the reconciler (M5.6) decides. */
  | { type: 'RECONCILE'; attemptId: string }
  /** M5.6: follow an execution running in a host this engine is not attached to, until it ends. */
  | { type: 'WATCH_EXECUTION'; attemptId: string; executionId: string };

// ---------------------------------------------------------------------------
// events (docs/27 §3.2)
// ---------------------------------------------------------------------------

export const WORKFLOW_EVENT_TYPES = [
  'WORKFLOW_CREATED',
  /** M5.3: the accepted decider input that caused the events after it — makes the log
   * replayable, so a snapshot missed by a crash is re-derived from the log (docs/27 §7). */
  'INPUT_RECEIVED',
  'WORKFLOW_STATE_CHANGED',
  'STEP_STATE_CHANGED',
  'ATTEMPT_PLANNED',
  'ATTEMPT_LAUNCHING',
  'EXECUTION_LINKED',
  'EXECUTION_ENDED',
  'ATTEMPT_STATE_CHANGED',
  'VERIFICATION_STARTED',
  'CHECK_COMPLETED',
  'REVIEW_COMPLETED',
  'VERIFICATION_COMPLETED',
  'RETRY_DECIDED',
  'BUDGET_CHECKED',
  'BUDGET_EXHAUSTED',
  'HUMAN_INPUT_REQUESTED',
  'HUMAN_INPUT_RECEIVED',
  'PAUSE_REQUESTED',
  'STOP_REQUESTED',
  'RECONCILED',
  'WORKFLOW_COMPLETED',
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export type WorkflowActor = 'workflow-engine' | 'verification' | 'reviewer' | 'human' | 'host';

/** Small, non-secret scalars (docs/27 §5); structured data travels as canonical-JSON strings. */
export type WorkflowEventPayload = Record<string, string | number | boolean | null | string[]>;

/** What the decider produces; the event log (M5.3) adds seq/ids/hash chain. */
export interface WorkflowEventDraft {
  type: WorkflowEventType;
  timestamp: string;
  stepId: string | null;
  attemptId: string | null;
  executionId: string | null;
  actor: WorkflowActor;
  provider: 'claude-code' | 'codex' | null;
  payload: WorkflowEventPayload;
  artifacts: { path: string; sha256: string }[];
}

/** The persisted envelope (docs/27 §3.2). */
export interface WorkflowEvent extends WorkflowEventDraft {
  schema: 1;
  eventId: string;
  seq: number;
  workflowId: string;
  correlationId: string;
  causationId: string | null;
  prevHash: string | null;
  hash: string;
}
