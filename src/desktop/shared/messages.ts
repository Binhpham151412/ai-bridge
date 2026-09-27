import type { BridgeRunOutcome } from '../../core/bridge-engine.ts';
import type { DoctorReport } from '../../core/preflight/doctor.ts';
import type { ExecutionDiagnostics } from '../../core/execution/execution-record.ts';
import type { UiError } from './ipc-contract.ts';

/**
 * Core outcome → a short, human error for the UI (M4 §16). Pure mapping of what Core
 * already decided; no new policy. Technical detail goes to `details` (behind
 * "View details"), never a stack trace. Callers redact free text before display.
 */

const CHECK_TITLES: Record<string, string> = {
  'claude-cli': 'Claude CLI không khả dụng',
  'codex-cli': 'Codex CLI không khả dụng',
  'claude-auth': 'Authentication unavailable (Claude)',
  'codex-auth': 'Authentication unavailable (Codex/ChatGPT)',
  'api-key-env': 'Phát hiện API key trong môi trường — AI Bridge từ chối chạy',
  'project-directory': 'Thư mục project không hợp lệ',
  config: 'Cấu hình .ai-bridge/config.json không hợp lệ',
  'git-repository': 'Project không thỏa điều kiện git',
  git: 'Git không khả dụng',
  node: 'Node không khả dụng',
};

export function describeDoctorFailure(report: DoctorReport): UiError {
  const failing = report.checks.filter((c) => c.status === 'BLOCKED' || c.status === 'FAIL' || c.status === 'UNKNOWN');
  const first = failing.find((c) => c.status === 'BLOCKED') ?? failing[0];
  const title = first ? (CHECK_TITLES[first.name] ?? `Kiểm tra "${first.name}" thất bại`) : 'System check không đạt';
  return {
    code: `PREFLIGHT_${report.overall}`,
    title,
    message: 'Core từ chối bắt đầu vì System Check chưa PASS. Mở System Check để xem chi tiết.',
    details: failing.map((c) => `[${c.status}] ${c.name} — ${c.detail}`).join('\n'),
  };
}

const EVIDENCE_TEXT: Record<ExecutionDiagnostics['cliSessionIdEvidence'], string> = {
  CONFIRMED_BY_CLI: 'confirmed by the CLI',
  REQUESTED_NOT_CONFIRMED: 'requested by AI Bridge, NOT confirmed by the CLI',
  UNKNOWN: 'UNKNOWN — the CLI reported none',
};

/** The "View details" block for a CLI-related failure: every identifier and number the
 * user needs to trace it, with the evidence level stated — all fields already redacted
 * and capped by Core (ExecutionDiagnostics). */
export function formatDiagnostics(d: ExecutionDiagnostics): string {
  const agent = d.agent === 'claude' ? 'Claude' : 'Codex';
  const lines = [
    `Bridge session: ${d.bridgeSessionId}`,
    `Iteration: ${String(d.iteration).padStart(3, '0')}`,
    d.continuity === 'MISMATCH'
      ? `${agent} CLI ${d.agent === 'claude' ? 'session' : 'thread'}: resume of ${d.requestedSessionId ?? 'UNKNOWN'} requested — the CLI reported ${d.cliSessionId ?? 'UNKNOWN'} instead (continuity MISMATCH: the requested session was not continued)`
      : `${agent} CLI ${d.agent === 'claude' ? 'session' : 'thread'}: ${d.cliSessionId ?? 'UNKNOWN'} (${EVIDENCE_TEXT[d.cliSessionIdEvidence]}${d.continuity === 'VERIFIED' ? ', resume continuity VERIFIED' : d.continuity === 'UNKNOWN' ? ', resume continuity UNKNOWN' : ''})`,
    `Status: ${d.status}${d.errorCode ? ` (${d.errorCode})` : ''}`,
    `Exit code: ${d.exitCode ?? 'none'}`,
    `Duration: ${d.durationMs === null ? 'unknown' : `${d.durationMs}ms`}`,
    `${d.agent === 'claude' ? 'Prompt' : 'Input'} SHA-256: ${d.inputSha256}`,
    `${d.agent === 'claude' ? 'Prompt' : 'Input'} bytes: ${d.inputBytes}`,
    `Stdin delivery: ${d.inputDelivery}`,
    `Execution record: ${d.executionFile}`,
  ];
  if (d.finalMessage) lines.push('', `${agent} final message (tail):`, d.finalMessage);
  lines.push('', 'stderr (tail):', d.stderrTail.trim() === '' ? '(empty)' : d.stderrTail);
  if (d.stdoutTail.trim() !== '') lines.push('', 'stdout (tail):', d.stdoutTail);
  return lines.join('\n');
}

export function describeRunErrorCode(errorCode: string, errorMessage: string | null, diagnostics: ExecutionDiagnostics | null = null): UiError {
  const details = diagnostics
    ? `${errorCode}\n${errorMessage ?? ''}\n\n${formatDiagnostics(diagnostics)}`.replace(/\n{3,}/g, '\n\n')
    : errorMessage
      ? `${errorCode}\n${errorMessage}`
      : errorCode;
  const [head, sub] = errorCode.split(':');
  let title = 'Unknown error';
  let message = 'Run kết thúc với lỗi không xác định. Xem chi tiết kỹ thuật.';
  if (errorCode === 'REPORT_INVALID') {
    title = 'Report không hợp lệ';
    message =
      diagnostics?.agent === 'claude' && diagnostics.status === 'COMPLETED' && /REPORT_MISSING/.test(errorMessage ?? '')
        ? `Claude CLI kết thúc bình thường (exit code ${diagnostics.exitCode ?? '?'}) nhưng không ghi file report — Core dừng run. Xem "final message" của Claude trong chi tiết.`
        : 'Report của Claude không đúng hợp đồng report nên Core dừng run (không tự sửa).';
  } else if (errorCode === 'RESPONSE_INVALID') {
    title = 'ChatGPT response không hợp lệ';
    message = 'Phản hồi của Codex/ChatGPT không đúng định dạng AI_BRIDGE_RESPONSE nên Core dừng run.';
  } else if (sub === 'TIMEOUT') {
    title = 'Process timeout';
    message = `${head === 'CLAUDE_RUN_FAILED' ? 'Claude CLI' : 'Codex CLI'} chạy quá thời gian cho phép và đã bị Core dừng.`;
  } else if (head === 'CLAUDE_RUN_FAILED') {
    title = sub === 'SPAWN_FAILED' ? 'Claude CLI không khả dụng' : 'Claude CLI lỗi';
    message =
      sub === 'NON_ZERO_EXIT' && diagnostics?.exitCode !== undefined && diagnostics?.exitCode !== null
        ? `Claude CLI kết thúc với exit code ${diagnostics.exitCode}.`
        : `Claude CLI kết thúc bất thường (${sub ?? 'unknown'}).`;
  } else if (head === 'CODEX_RUN_FAILED') {
    title = sub === 'SPAWN_FAILED' ? 'Codex CLI không khả dụng' : 'Codex CLI lỗi';
    message =
      sub === 'NON_ZERO_EXIT' && diagnostics?.exitCode !== undefined && diagnostics?.exitCode !== null
        ? `Codex CLI kết thúc với exit code ${diagnostics.exitCode}.`
        : `Codex CLI kết thúc bất thường (${sub ?? 'unknown'}).`;
  } else if (errorCode === 'BLOCKED_API_AUTH') {
    title = 'Phát hiện API key trong môi trường';
    message = 'Core từ chối gọi CLI khi có biến môi trường API key (chi phí $0 là bắt buộc).';
  } else if (errorCode === 'PROMPT_INTEGRITY_FAILURE' || errorCode === 'REPORT_TRANSPORT_INTEGRITY_FAILURE') {
    title = 'Lỗi toàn vẹn dữ liệu';
    message = 'Core phát hiện dữ liệu chuyển giữa Claude và Codex không khớp hash, nên dừng run.';
  } else if (head === 'CRASH_INJECTED') {
    title = 'Crash injection (test)';
    message = 'Run bị dừng bởi điểm crash injection dùng cho kiểm thử.';
  }
  return { code: errorCode, title, message, details };
}

/** Null when the outcome is not an error (e.g. COMPLETED with DONE/PAUSED/STOPPED). */
export function describeRunOutcome(outcome: BridgeRunOutcome): UiError | null {
  switch (outcome.kind) {
    case 'BLOCKED_PREFLIGHT':
      return describeDoctorFailure(outcome.doctorReport);
    case 'ALREADY_RUNNING':
      return { code: 'ALREADY_RUNNING', title: 'Project đang được session khác sử dụng', message: `Một session AI Bridge khác (pid ${outcome.pid}) đang giữ lock của project này.` };
    case 'INVALID_OPTIONS':
      return { code: 'INVALID_OPTIONS', title: 'Cấu hình run không hợp lệ', message: outcome.reason };
    case 'NO_STATE':
      return { code: 'NO_STATE', title: 'Không có session để resume', message: 'Không tìm thấy trạng thái session đã lưu.' };
    case 'RECOVERY_BLOCKED':
      return { code: 'RECOVERY_BLOCKED', title: 'Session recovery bị chặn', message: 'Core xác định session này không thể resume an toàn.', details: outcome.reason };
    case 'COMPLETED':
      if (outcome.finalStatus === 'ERROR') return describeRunErrorCode(outcome.errorCode ?? 'UNKNOWN', outcome.errorMessage, outcome.diagnostics ?? null);
      return null;
  }
}

export function unexpectedError(err: unknown): UiError {
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'UNEXPECTED', title: 'Unknown error', message: 'Đã xảy ra lỗi không mong đợi.', details: message };
}

export function notAllowed(action: string, status: string | null): UiError {
  return { code: 'NOT_ALLOWED', title: `Không thể ${action} lúc này`, message: `Hành động không hợp lệ ở trạng thái hiện tại (${status ?? 'chưa chọn project'}).` };
}

export const NO_PROJECT_ERROR: UiError = { code: 'NO_PROJECT', title: 'Chưa chọn project', message: 'Chọn thư mục project trước.' };
