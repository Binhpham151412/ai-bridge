import { useState } from 'react';
import type { BridgeEvent } from '../../../core/observability/events.ts';
import type { ExecutionView, IterationArtifacts } from '../../../core/session-history/session-history.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { useSessionArtifacts } from '../state/useSessionData.ts';
import { formatBytes, formatDateTime, formatElapsed } from '../lib/format.ts';
import { ActivityLog } from './ActivityLog.tsx';
import { CliOutput } from './CliOutput.tsx';
import { EmptyState, ErrorPanel, Pill, Raw } from './common.tsx';
import { ExecutionPanel } from './ExecutionPanel.tsx';

/** The live session's artifacts for the round Core is on (or its latest recorded one). */
function useCurrentIteration(refreshKey: string): { runId: string | null; it: IterationArtifacts | null; loading: boolean; error: UiError | null } {
  const { snapshot } = useBridge();
  const runId = snapshot?.status?.runId ?? null;
  const iteration = snapshot?.status?.iteration ?? 0;
  const { data, error } = useSessionArtifacts(runId, refreshKey);
  const it = data?.iterations.find((i) => i.iteration === iteration) ?? data?.iterations[data.iterations.length - 1] ?? null;
  return { runId, it, loading: runId !== null && !data && !error, error };
}

/**
 * RUN → Technical details: Core's raw state (phase, ids, PIDs) and the current round's
 * M4.1 execution records. Mounted only when the user expands the section.
 */
export function RunTechnicalDetails({ refreshKey }: { refreshKey: string }) {
  const { snapshot } = useBridge();
  const status = snapshot?.status ?? null;
  const { runId, it, loading, error } = useCurrentIteration(refreshKey);
  const [showPrompt, setShowPrompt] = useState(false);
  const claudeLive = status?.activity.claude === 'EXECUTING';
  const codexLive = status?.activity.codex === 'REVIEWING';

  return (
    <div className="tech">
      <div className="tech-grid">
        <div>
          <h3 className="tech-title">Core state</h3>
          <dl className="kv">
            <dt>Status</dt>
            <dd className="mono">{status?.status ?? '—'}</dd>
            <dt>Phase (Core)</dt>
            <dd className="mono" data-testid="run-phase">
              {status?.currentPhase ?? '—'}
            </dd>
            <dt>AI Bridge session</dt>
            <dd className="mono">{status?.runId ?? '—'}</dd>
            <dt>Iteration</dt>
            <dd className="mono">
              {status?.iteration ?? 0} / {status?.maxIterations ?? '—'}
            </dd>
            <dt>Started</dt>
            <dd className="mono">{formatDateTime(status?.startedAt ?? null)}</dd>
            <dt>Last update</dt>
            <dd className="mono">{formatDateTime(status?.updatedAt ?? null)}</dd>
            <dt>Live events</dt>
            <dd>{snapshot?.runAttached ? 'yes — run host of this app' : 'no'}</dd>
            <dt>Last report</dt>
            <dd className="mono small">{status?.lastReportPath ?? '—'}</dd>
          </dl>
        </div>
        <div>
          <h3 className="tech-title">CLI processes</h3>
          {/* A PID is only shown while Core reports that agent as active: after a crash the
              state file still holds the last (now dead) PIDs. */}
          <dl className="kv">
            <dt>Claude PID</dt>
            <dd className="mono" data-testid="claude-pid">
              {claudeLive && status?.claude.pid ? status.claude.pid : '—'}
            </dd>
            <dt>Claude CLI session</dt>
            <dd className="mono small" data-testid="claude-session-id">
              {status?.claude.sessionId ?? '—'}
            </dd>
            <dt>Codex PID</dt>
            <dd className="mono" data-testid="codex-pid">
              {codexLive && status?.codex.pid ? status.codex.pid : '—'}
            </dd>
            <dt>Codex thread</dt>
            <dd className="mono small" data-testid="codex-thread-id">
              {status?.codex.threadId ?? '—'}
            </dd>
          </dl>
          <p className="hint">Session id do CLI xác nhận (Claude Code CLI / Codex CLI), không phải danh sách hội thoại của Claude Desktop.</p>
        </div>
      </div>

      {runId && (
        <>
          <h3 className="tech-title">Execution records — round {it?.iteration ?? '—'}</h3>
          {error && <ErrorPanel error={error} />}
          {loading && <p className="hint">Đang tải…</p>}
          {!loading && !error && !it && <EmptyState title="Chưa có round nào" />}
          {it && (
            <div className="tech-execs">
              <ExecutionPanel
                key={`claude-${it.iteration}`}
                runId={runId}
                agent="claude"
                iteration={it.iteration}
                execution={it.claudeExecution}
                inputArtifact={it.claudePrompt}
                isLiveStep={status?.status === 'RUNNING'}
                onViewInput={it.claudePrompt ? () => setShowPrompt((v) => !v) : undefined}
              />
              {showPrompt && it.claudePrompt && <Raw artifact={it.claudePrompt} testId="artifact-prompt" />}
              <ExecutionPanel key={`codex-${it.iteration}`} runId={runId} agent="codex" iteration={it.iteration} execution={it.codexExecution} inputArtifact={it.codexInput} isLiveStep={status?.status === 'RUNNING'} />
            </div>
          )}
          <p className="hint">Các round trước: ARTIFACTS → Technical.</p>
        </>
      )}
    </div>
  );
}

function ProcessFacts({ view }: { view: ExecutionView | null }) {
  if (!view) return <p className="hint">Không có execution record cho bước này.</p>;
  const { record, effectiveStatus } = view;
  return (
    <dl className="kv kv-compact">
      <dt>Status</dt>
      <dd>
        <Pill value={effectiveStatus === 'COMPLETED' ? 'DONE' : effectiveStatus === 'RUNNING' ? 'RUNNING' : 'ERROR'} label={effectiveStatus} />
      </dd>
      <dt>Command</dt>
      <dd className="mono small">{[record.command.executable, ...record.command.args].join(' ')}</dd>
      <dt>Exit code</dt>
      <dd className="mono">
        {record.process.exitCode ?? '—'}
        {record.process.signal ? ` (signal ${record.process.signal})` : ''}
        {record.process.timedOut ? ' (timed out)' : ''}
      </dd>
      <dt>Duration</dt>
      <dd className="mono">{record.process.durationMs !== null ? formatElapsed(record.process.durationMs) : '—'}</dd>
      <dt>stdout / stderr</dt>
      <dd className="mono">
        {formatBytes(record.output.stdoutBytes)}
        {record.output.stdoutTruncated ? ' (truncated)' : ''} / {formatBytes(record.output.stderrBytes)}
        {record.output.stderrTruncated ? ' (truncated)' : ''}
      </dd>
    </dl>
  );
}

/**
 * RUN → Technical output: the raw CLI streams of the current round (redacted tails,
 * loaded on demand) and the full technical event log. Mounted only when expanded.
 */
export function RunTechnicalOutput({ refreshKey, events }: { refreshKey: string; events: readonly BridgeEvent[] }) {
  const { runId, it, loading, error } = useCurrentIteration(refreshKey);
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude');
  const view = it ? (agent === 'claude' ? it.claudeExecution : it.codexExecution) : null;
  const live = view?.effectiveStatus === 'RUNNING';

  return (
    <div className="tech">
      {runId && (
        <>
          <div className="tabs" role="tablist" aria-label="Agent">
            <button type="button" role="tab" aria-selected={agent === 'claude'} className={`tab ${agent === 'claude' ? 'active' : ''}`} onClick={() => setAgent('claude')} data-testid="tech-output-claude">
              Claude
            </button>
            <button type="button" role="tab" aria-selected={agent === 'codex'} className={`tab ${agent === 'codex' ? 'active' : ''}`} onClick={() => setAgent('codex')} data-testid="tech-output-codex">
              ChatGPT / Codex
            </button>
          </div>
          {error && <ErrorPanel error={error} />}
          {loading && <p className="hint">Đang tải…</p>}
          {it && (
            <>
              <p className="tech-caption">Round {it.iteration}</p>
              <ProcessFacts view={view} />
              {view && (
                <CliOutput
                  key={`${agent}-${it.iteration}`}
                  runId={runId}
                  iteration={it.iteration}
                  agent={agent}
                  disabled={live}
                  disabledReason={live ? 'CLI output được lưu khi process kết thúc.' : undefined}
                />
              )}
            </>
          )}
        </>
      )}
      <h3 className="tech-title">Event log (technical)</h3>
      <ActivityLog events={events} emptyText="Không có event." />
    </div>
  );
}
