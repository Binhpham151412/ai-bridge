import type { BridgePauseOutcome, BridgeRecoveryCheck, BridgeRunOutcome, BridgeStatus, BridgeStopOutcome } from '../bridge-engine.ts';
import type { BridgeEvent } from '../observability/events.ts';
import type { SessionArtifacts, SessionSummary } from '../session-history/session-history.ts';
import type { ExecutionResultSummary } from './types.ts';
import type { PermissionPolicyRequest } from '../permissions/permission-policy.ts';

/**
 * M5.4 — the ExecutionPort contract (docs/23 §3): the ONLY boundary between the workflow
 * layer and the execution engine. Type-only imports: the workflow layer knows the request,
 * the ids, the typed result, the forwarded run events and the lifecycle controls — never
 * Claude/Codex CLI details, process trees or BridgeEngine internals.
 *
 * Implementations: `ForkedExecutionPort` (src/hosts) runs every execution in its own
 * Execution Host process (ADR-011 option A). The port is thin — no retry loop, no output
 * parsing, no CLI knowledge, and it never starts a second execution on its own.
 */

export interface ExecutionRequest {
  /** `<workflowId>/<stepId>/<n>`. */
  attemptId: string;
  /** Composed by the workflow (M5.5 step-planner); the execution's only work input. */
  task: string;
  /** 1..100 — validated again by BridgeEngine (INVALID_OPTIONS). */
  maxIterations: number;
  /** ADR-017: persisted with the run and echoed on RUN_STARTED. Defaults to `attemptId`. */
  correlation?: string;
  /** M5.10.1 (docs/61): provider-neutral permission override. Omitted = `inherit` (the
   * project's per-provider setting). The resolved policy is recorded per execution. */
  permissionPolicy?: PermissionPolicyRequest;
}

export interface ExecutionHostExit {
  code: number | null;
  signal: string | null;
  /** Last few KB of the host's stderr. */
  stderrTail: string;
}

/**
 * Why a host produced no trustworthy outcome — facts for the reconciler (M5.6), which
 * decides; the port itself never retries or relaunches.
 */
export type ExecutionHostFailureKind =
  /** The process could not be created. */
  | 'SPAWN_FAILED'
  /** The host exited (crash, kill) without delivering an outcome. */
  | 'EXITED_WITHOUT_OUTCOME'
  /** The host caught an exception and reported `failed`. */
  | 'HOST_REPORTED_FAILURE'
  /** RUN_STARTED carried a different correlation than the one sent. */
  | 'CORRELATION_MISMATCH';

export interface ExecutionPortResult {
  /** What the decider consumes (EXECUTION_ENDED.result, docs/26 §3). */
  summary: ExecutionResultSummary;
  /** The host's typed BridgeEngine outcome, unchanged; null when none arrived. */
  outcome: BridgeRunOutcome | null;
  /** runId, from RUN_STARTED or the outcome; null if the execution never started (or it is unknown). */
  executionId: string | null;
  /** The correlation sent with `start` (or, for a resume, the one persisted with the run). */
  correlation: string | null;
  /** The correlation RUN_STARTED actually carried; null when no RUN_STARTED was seen. */
  observedCorrelation: string | null;
  /** Set when the host did not end normally; null otherwise. */
  hostFailure: { kind: ExecutionHostFailureKind; message: string } | null;
  /** How the host process ended (always present once a process existed). */
  hostExit: ExecutionHostExit | null;
  hostPid: number | null;
  /** Malformed host messages that were ignored. */
  invalidMessages: number;
  /** A stop was requested through this port during the execution. */
  stopRequested: boolean;
}

export interface ExecutionPort {
  /** Starts one execution in a new Execution Host; resolves when that host has exited.
   * `onHostSpawned` (M5.6, additive) reports the host pid as soon as the process exists, so
   * the workflow can persist it before the execution can create any session. */
  start(request: ExecutionRequest, onEvent?: (event: BridgeEvent) => void, onHostSpawned?: (pid: number) => void): Promise<ExecutionPortResult>;
  /** Resumes `executionId` iff it is the project's current session (else RESUME_REFUSED: NOT_CURRENT_SESSION). */
  resume(ref: { executionId: string }, onEvent?: (event: BridgeEvent) => void, onHostSpawned?: (pid: number) => void): Promise<ExecutionPortResult>;
  /** Pass-through: BridgeEngine.pause() (cooperative, at an iteration boundary). */
  pause(): Promise<BridgePauseOutcome>;
  /** Pass-through: BridgeEngine.stop() — kills only the lock holder, i.e. the Execution Host. */
  stop(): Promise<BridgeStopOutcome>;
  status(): Promise<BridgeStatus>;
  checkRecovery(): Promise<BridgeRecoveryCheck>;
  artifacts(executionId: string): Promise<SessionArtifacts | null>;
  /** Sessions whose start is at/after `startedAfter` (for reconciliation, M5.6). */
  findExecutions(filter: { startedAfter: string }): Promise<SessionSummary[]>;
}
