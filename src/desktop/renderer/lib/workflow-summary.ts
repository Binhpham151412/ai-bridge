import type { WorkflowEvent, WorkflowSnapshot } from '../../shared/ipc-contract.ts';
import type { Tone } from './format.ts';

/**
 * M5.9 — plain-language presentation of what Core reports about a workflow (the run-summary.ts
 * approach, docs/35 §3.4). Every label and sentence is picked from a fixed table keyed by Core's
 * own values: instance/step/attempt states, evidence levels, reconciliation findings, waiting
 * reasons, answers. Nothing here decides availability (that is `snapshot.controls`, derived by
 * Core's deriveWorkflowControls), derives a state (the shown state is `snapshot.displayState`), or
 * reads the journal. Values not in a table are shown verbatim; missing values as UNKNOWN.
 */

export const UNKNOWN = 'UNKNOWN';

export function orUnknown(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? UNKNOWN : String(value);
}

export type WorkflowRecovery = WorkflowSnapshot['recovery'][number];

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<string, string> = {
  // instance (docs/22 §4) + the derived display state
  CREATED: 'Created',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  WAITING_HUMAN: 'Waiting for you',
  BLOCKED: 'Blocked',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  STOPPED: 'Stopped',
  INTERRUPTED: 'Interrupted',
  // step
  PENDING: 'Pending',
  ACTIVE: 'Active',
  SUCCEEDED: 'Succeeded',
  // attempt
  PLANNED: 'Planned',
  LAUNCHING: 'Launching',
  EXECUTING: 'Executing',
  PAUSED_EXECUTION: 'Execution paused',
  EXECUTION_ENDED: 'Execution ended',
  VERIFYING: 'Verifying',
  PASSED: 'Passed',
  REJECTED: 'Rejected',
  EXECUTION_FAILED: 'Execution failed',
  NEEDS_HUMAN: 'Needs you',
  NOT_STARTED: 'Not started',
  LAUNCH_UNKNOWN: 'Launch unknown',
};

export function stateLabel(state: string | null | undefined): string {
  if (!state) return UNKNOWN;
  return STATE_LABEL[state] ?? state;
}

const STATE_TONE: Record<string, Tone> = {
  RUNNING: 'active',
  ACTIVE: 'active',
  LAUNCHING: 'active',
  EXECUTING: 'active',
  EXECUTION_ENDED: 'active',
  VERIFYING: 'active',
  PAUSED: 'paused',
  PAUSED_EXECUTION: 'paused',
  COMPLETED: 'success',
  SUCCEEDED: 'success',
  PASSED: 'success',
  FAILED: 'danger',
  REJECTED: 'danger',
  EXECUTION_FAILED: 'danger',
  INTERRUPTED: 'danger',
  WAITING_HUMAN: 'warning',
  NEEDS_HUMAN: 'warning',
  BLOCKED: 'warning',
  STOPPED: 'warning',
  LAUNCH_UNKNOWN: 'warning',
};

/** Visual tone only; the text label always carries the state too (never colour alone). */
export function stateTone(state: string | null | undefined): Tone {
  return (state && STATE_TONE[state]) || 'idle';
}

const HEADLINE: Record<string, string> = {
  CREATED: 'Workflow đã được tạo nhưng chưa bắt đầu.',
  RUNNING: 'Workflow đang chạy — mỗi step là một run Claude ⇄ ChatGPT.',
  PAUSED: 'Workflow đã tạm dừng ở một điểm an toàn. Resume để tiếp tục.',
  WAITING_HUMAN: 'Workflow đang chờ bạn quyết định.',
  BLOCKED: 'Workflow bị chặn vì môi trường chưa sẵn sàng. Resume sẽ chạy lại cùng attempt.',
  COMPLETED: 'Workflow đã hoàn thành — mọi step đều PASS (AI_ATTESTED).',
  FAILED: 'Workflow thất bại.',
  STOPPED: 'Workflow đã dừng.',
  INTERRUPTED: 'Workflow Host không còn chạy: workflow bị gián đoạn. Resume để reconcile (M5.6) — execution đang có sẽ được theo dõi hoặc adopt, không chạy lại.',
};

/** One sentence for the display state Core reported. */
export function workflowHeadline(displayState: string | null | undefined): string {
  return (displayState && HEADLINE[displayState]) || `State: ${orUnknown(displayState)}`;
}

const TERMINAL_REASON: Record<string, string> = {
  ALL_STEPS_PASSED: 'All steps passed',
  STEP_FAILED: 'A step failed',
  ATTEMPTS_EXHAUSTED: 'Attempts exhausted',
  BUDGET_EXECUTIONS_EXHAUSTED: 'Execution budget exhausted',
  BUDGET_ITERATIONS_EXHAUSTED: 'Iteration budget exhausted',
  BUDGET_TOKENS_EXHAUSTED: 'Token budget exhausted',
  DEADLINE_EXCEEDED: 'Deadline exceeded',
  DEFINITION_INVALID: 'Definition invalid',
  HUMAN_MARKED_FAILED: 'Marked failed by you',
  STOPPED_BY_USER: 'Stopped by you',
};

export function terminalReasonLabel(reason: string | null | undefined): string {
  if (!reason) return UNKNOWN;
  return TERMINAL_REASON[reason] ? `${TERMINAL_REASON[reason]} (${reason})` : reason;
}

// ---------------------------------------------------------------------------
// verification — M5: AI_ATTESTED is never VERIFIED (ADR-020)
// ---------------------------------------------------------------------------

export function evidenceText(level: string | null | undefined): string {
  switch (level) {
    case 'AI_ATTESTED':
      return 'AI_ATTESTED — chưa kiểm chứng bằng deterministic checks';
    case 'VERIFIED':
      return 'VERIFIED — deterministic checks passed';
    case 'NONE':
      return 'NONE — chưa có bằng chứng';
    case null:
    case undefined:
    case '':
      return UNKNOWN;
    default:
      return level;
  }
}

export function verificationModeText(mode: string | null | undefined, deterministicChecks: number | null | undefined): string {
  if (mode === 'OUTCOME_ONLY') return `OutcomeOnly (M5) — chỉ dựa trên kết quả DONE execution tự báo; ${deterministicChecks ?? 0} deterministic check`;
  return orUnknown(mode);
}

// ---------------------------------------------------------------------------
// recovery (M5.6) — straight from persisted events; nothing is inferred
// ---------------------------------------------------------------------------

const RECOVERY_LABEL: Record<string, string> = {
  NOT_STARTED: 'NOT_STARTED — đã chứng minh execution chưa từng bắt đầu; cùng attempt được launch lại (không phải retry)',
  WATCH: 'WATCH — execution vẫn đang chạy trong Execution Host của nó; đang theo dõi, không launch lại',
  RESUME: 'RESUME — execution bị gián đoạn nhưng RECOVERABLE; resume đúng execution đó',
  UNRESOLVABLE: 'UNRESOLVABLE — dữ kiện không rõ ràng hoặc không an toàn; cần bạn quyết định',
  STORE_REPAIR: 'Store repair — nhật ký sự kiện được sửa khi mở lại (M5.3)',
  HOST_FAILED: 'HOST_FAILED — Execution Host kết thúc mà không báo kết quả; reconciler quyết định',
  RESUME_REFUSED: 'RESUME_REFUSED — BridgeEngine từ chối resume',
};

export function recoveryKey(entry: WorkflowRecovery): string {
  return entry.kind === 'FINDING' ? orUnknown(entry.finding) : entry.kind;
}

export function recoveryLabel(entry: WorkflowRecovery): string {
  const key = recoveryKey(entry);
  return RECOVERY_LABEL[key] ?? key;
}

/** M5.7 open item, stated rather than papered over: ADOPT/LINK leave no marker in the log. */
export const ADOPT_NOTE =
  'Outcome được ADOPT, hoặc execution được LINK, bởi reconciliation sau khi mở lại được ghi như input EXECUTION_ENDED / EXECUTION_LINKED thông thường — nhật ký không đánh dấu chúng là reconciled (M5.7), nên UI không gắn nhãn ADOPT.';

const WAITING_REASON: Record<string, string> = {
  // outcome classes (docs/26 §3) that hand the decision to a human
  UNKNOWN: 'Execution kết thúc với một kết quả Core chưa phân loại được (ví dụ một mã lỗi mới) — không có quyết định tự động nào an toàn.',
  HUMAN_REQUESTED: 'ChatGPT (reviewer) yêu cầu con người quyết định.',
  AMBIGUOUS_RECOVERY: 'Không xác định được an toàn execution đã làm gì.',
  CONTRACT_ANOMALY: 'Execution trả về một kết quả trái với hợp đồng giữa workflow và execution.',
  INTEGRITY: 'Kiểm tra toàn vẹn (integrity) của execution thất bại.',
  // reconciliation (M5.6)
  EXECUTION_NOT_RECOVERABLE: 'Execution bị gián đoạn ở một điểm không thể resume an toàn.',
  ORPHANED_CLI_PROCESS_ALIVE: 'Một process CLI của execution cũ vẫn còn chạy.',
  EXECUTION_HOST_ALIVE_WITHOUT_SESSION: 'Execution Host vẫn sống nhưng không có session nào.',
  DUPLICATE_EXECUTIONS_FOR_ATTEMPT: 'Có nhiều execution cho cùng một attempt.',
  CORRELATION_MISMATCH: 'Execution không mang correlation của attempt này.',
};

export function waitingReasonText(reason: string | null | undefined): string {
  if (!reason) return UNKNOWN;
  return WAITING_REASON[reason] ? `${WAITING_REASON[reason]} (${reason})` : reason;
}

const ANSWER_LABEL: Record<string, string> = {
  fail: 'Đánh dấu FAILED',
  stop: 'STOP workflow',
};

export function answerLabel(answer: string): string {
  return ANSWER_LABEL[answer] ?? answer;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

const MAX_SUMMARY = 160;

/** A concise, literal summary of an event's (small, non-secret) payload — keys and values as
 * persisted; INPUT_RECEIVED shows only which input it was, never the input JSON. */
export function summarizeEvent(e: WorkflowEvent): string {
  if (e.type === 'INPUT_RECEIVED') return `input ${orUnknown(typeof e.payload.inputType === 'string' ? e.payload.inputType : null)}`;
  const parts = Object.entries(e.payload)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`);
  const text = parts.join(' · ');
  if (text === '') return '—';
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}

export const BUDGET_LABEL: Record<string, string> = {
  executions: 'Executions',
  iterations: 'Iterations',
  reportedTokens: 'Reported tokens',
};
