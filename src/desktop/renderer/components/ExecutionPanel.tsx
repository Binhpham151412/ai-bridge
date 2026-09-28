import { useState } from 'react';
import type { ArtifactText, ExecutionView } from '../../../core/session-history/session-history.ts';
import { formatElapsed, formatTime } from '../lib/format.ts';
import { CliOutput } from './CliOutput.tsx';
import { EmptyState, Pill } from './common.tsx';

type Check = 'ok' | 'fail' | 'unknown' | 'pending';

const MARK: Record<Check, string> = { ok: '✓', fail: '✗', unknown: '?', pending: '…' };

function Step({ state, label, note }: { state: Check; label: string; note?: string }) {
  return (
    <li className={`step step-${state}`} data-testid="exec-step">
      <span className="step-mark" aria-hidden="true">
        {MARK[state]}
      </span>
      <span className="step-label">{label}</span>
      {note && <span className="step-note">{note}</span>}
    </li>
  );
}

const EVIDENCE: Record<ExecutionView['record']['cliSessionId']['evidence'], string> = {
  CONFIRMED_BY_CLI: 'CLI xác nhận (có trong output của CLI)',
  REQUESTED_NOT_CONFIRMED: 'AI Bridge yêu cầu — CLI CHƯA xác nhận',
  UNKNOWN: 'UNKNOWN — CLI không báo id',
};

const PILL_TONE: Record<ExecutionView['effectiveStatus'], string> = {
  COMPLETED: 'DONE',
  RUNNING: 'RUNNING',
  FAILED: 'ERROR',
  TIMEOUT: 'ERROR',
  STOPPED: 'STOPPED',
  INTERRUPTED: 'INTERRUPTED',
};

/**
 * One CLI call, as recorded by Core (M4.1). Every line states only what the execution
 * record proves: "prompt written to stdin" is a pipe-level fact, not proof the CLI read
 * it; a session id is "confirmed" only when the CLI itself reported it.
 */
export function ExecutionPanel({
  runId,
  agent,
  iteration,
  execution,
  inputArtifact,
  isLiveStep,
  onViewInput,
}: {
  runId: string;
  agent: 'claude' | 'codex';
  iteration: number;
  execution: ExecutionView | null;
  inputArtifact: ArtifactText | null;
  isLiveStep: boolean;
  /** Opens the exact prompt/input this call received (omitted where it is shown alongside). */
  onViewInput?: () => void;
}) {
  const [outputStream, setOutputStream] = useState<'stdout' | 'stderr' | null>(null);
  const name = agent === 'claude' ? 'Claude' : 'Codex';

  if (!execution) {
    return (
      <EmptyState title={isLiveStep ? `${name} CLI chưa bắt đầu` : `Không có execution record của ${name}`}>
        {isLiveStep
          ? `Bước ${name} của iteration này chưa được khởi chạy.`
          : 'Bước này chưa chạy, hoặc session được ghi trước M4.1 (khi đó chỉ có prompt/report/response).'}
      </EmptyState>
    );
  }

  const { record, effectiveStatus } = execution;
  const running = effectiveStatus === 'RUNNING';

  const inputMatches = inputArtifact !== null && inputArtifact.sha256 === record.input.sha256;
  let deliveryState: Check = 'unknown';
  if (record.input.delivery === 'STDIN_FLUSHED_AND_CLOSED') deliveryState = 'ok';
  else if (record.input.delivery === 'STDIN_ERROR') deliveryState = 'fail';
  else if (record.input.delivery === 'PENDING' && running) deliveryState = 'pending';
  const mismatch = record.continuity.verdict === 'MISMATCH';
  let sessionState: Check = record.cliSessionId.evidence === 'CONFIRMED_BY_CLI' ? 'ok' : running ? 'pending' : 'unknown';
  if (mismatch) sessionState = 'fail';
  const evidenceText = mismatch ? `CLI báo id KHÁC với id được yêu cầu resume (${record.cliSessionId.requested ?? 'UNKNOWN'}) — MISMATCH` : EVIDENCE[record.cliSessionId.evidence];
  const finishedState: Check = effectiveStatus === 'COMPLETED' ? 'ok' : running ? 'pending' : 'fail';
  const idLabel = agent === 'claude' ? 'Claude CLI session' : 'Codex thread';
  const shownId = record.cliSessionId.reported ?? record.cliSessionId.requested;
  let duration = '—';
  if (record.process.durationMs !== null) duration = formatElapsed(record.process.durationMs);
  else if (running && record.process.startedAt) duration = `${formatElapsed(Date.now() - Date.parse(record.process.startedAt))} (đang chạy)`;
  let pidText = '—';
  if (record.process.pid !== null) pidText = running ? String(record.process.pid) : `— (đã kết thúc; pid ${record.process.pid})`;
  let deliveryNote = 'không có bằng chứng';
  if (deliveryState === 'ok') deliveryNote = `đủ ${record.input.bytes} bytes đã vào pipe stdin và stdin đã đóng — không chứng minh CLI đã đọc/xử lý`;
  else if (record.input.deliveryError) deliveryNote = `lỗi stdin: ${record.input.deliveryError}`;
  else if (deliveryState === 'pending') deliveryNote = 'đang chờ';
  const noun = agent === 'claude' ? 'PROMPT' : 'INPUT';
  const upper = name.toUpperCase();

  return (
    <div className="exec" data-testid={`exec-${agent}`}>
      <div className="exec-head">
        <h3>{upper} EXECUTION</h3>
        <Pill value={PILL_TONE[effectiveStatus]} label={effectiveStatus} />
      </div>

      <dl className="kv exec-kv">
        <dt>AI Bridge session</dt>
        <dd className="mono">{record.bridgeSessionId}</dd>
        <dt>Iteration</dt>
        <dd className="mono">{String(record.iteration).padStart(3, '0')}</dd>
        <dt>{idLabel}</dt>
        <dd>
          <span className="mono" data-testid="exec-cli-session">
            {shownId ?? 'UNKNOWN'}
          </span>
          <span className="exec-evidence">{evidenceText}</span>
        </dd>
        <dt>Mode</dt>
        <dd>{record.mode === 'RESUME' ? 'RESUME (tiếp tục session/thread cũ)' : 'NEW (session/thread mới)'}</dd>
        <dt>PID</dt>
        <dd className="mono">{pidText}</dd>
        <dt>Started</dt>
        <dd className="mono">{formatTime(record.process.startedAt)}</dd>
        <dt>Completed</dt>
        <dd className="mono">{formatTime(record.process.endedAt)}</dd>
        <dt>Duration</dt>
        <dd className="mono">{duration}</dd>
        <dt>Exit code</dt>
        <dd className="mono" data-testid="exec-exit-code">
          {record.process.exitCode ?? '—'}
          {record.errorCode ? ` (${record.errorCode})` : ''}
        </dd>
        <dt>{agent === 'claude' ? 'Prompt' : 'Input'}</dt>
        <dd className="mono">{record.input.file}</dd>
        <dt>SHA-256</dt>
        <dd className="mono small" data-testid="exec-sha">
          {record.input.sha256}
        </dd>
        <dt>Bytes</dt>
        <dd className="mono">{record.input.bytes}</dd>
      </dl>

      <ol className="steps" aria-label="Lifecycle">
        <Step
          state={inputArtifact === null ? 'unknown' : inputMatches ? 'ok' : 'fail'}
          label={`${noun} PERSISTED`}
          note={inputArtifact === null ? 'không đọc được file' : inputMatches ? 'file trên đĩa khớp SHA-256 đã ghi' : 'file trên đĩa KHÔNG khớp SHA-256 đã ghi'}
        />
        <Step state={record.process.pid !== null ? 'ok' : running ? 'pending' : 'unknown'} label={`${upper} PROCESS STARTED`} note={record.process.pid !== null ? `pid ${record.process.pid}` : undefined} />
        <Step state={deliveryState} label={`${noun} WRITTEN TO ${upper} STDIN`} note={deliveryNote} />
        <Step state={sessionState} label={`${idLabel.toUpperCase()} CONFIRMED`} note={evidenceText} />
        <Step
          state={finishedState}
          label={effectiveStatus === 'COMPLETED' ? `${upper} COMPLETED` : `${upper} ${effectiveStatus}`}
          note={record.process.exitCode !== null ? `exit code ${record.process.exitCode}` : undefined}
        />
      </ol>

      {record.mode === 'RESUME' && (
        <p className={`exec-continuity continuity-${record.continuity.verdict}`} data-testid="exec-continuity">
          Session continuity: <strong>{record.continuity.verdict}</strong> — {record.continuity.note}
          {record.continuity.reported && record.continuity.reported !== record.continuity.expected
            ? ` (yêu cầu ${record.continuity.expected}, CLI báo ${record.continuity.reported})`
            : ''}
        </p>
      )}

      <div className="row-actions">
        {onViewInput && (
          <button type="button" className="btn btn-small" onClick={onViewInput}>
            {agent === 'claude' ? 'VIEW EXACT PROMPT' : 'VIEW INPUT'}
          </button>
        )}
        <button type="button" className="btn btn-small" onClick={() => setOutputStream('stdout')} disabled={running} data-testid="exec-view-stdout">
          VIEW CLI OUTPUT
        </button>
        <button type="button" className="btn btn-small" onClick={() => setOutputStream('stderr')} disabled={running} data-testid="exec-view-stderr">
          VIEW STDERR
        </button>
      </div>
      {running && <p className="hint">CLI output được lưu khi process kết thúc.</p>}
      {outputStream && <CliOutput key={outputStream} runId={runId} iteration={iteration} agent={agent} initialStream={outputStream} />}
      {agent === 'claude' && <p className="hint">AI Bridge sử dụng Claude Code CLI trực tiếp. Danh sách hội thoại của Claude Desktop không phải là nguồn trạng thái của AI Bridge.</p>}
    </div>
  );
}
