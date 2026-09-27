import { useEffect, useState } from 'react';
import type { ExecutionView, IterationArtifacts, SessionArtifacts, SessionSummary } from '../../../core/session-history/session-history.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { Markdown } from '../lib/Markdown.tsx';
import { formatDateTime } from '../lib/format.ts';
import { ActivityLog } from './ActivityLog.tsx';
import { ArtifactMeta, EmptyState, ErrorPanel, Raw } from './common.tsx';
import { ExecutionPanel } from './ExecutionPanel.tsx';
import { JournalPanel, LazyJournalEntry } from './JournalPanel.tsx';

type Tab = 'REPORT' | 'CHATGPT RESPONSE' | 'PROMPT' | 'CLAUDE EXECUTION' | 'CODEX EXECUTION' | 'JOURNAL' | 'EVENTS' | 'STATE';
const TABS: Tab[] = ['REPORT', 'CHATGPT RESPONSE', 'PROMPT', 'CLAUDE EXECUTION', 'CODEX EXECUTION', 'JOURNAL', 'EVENTS', 'STATE'];
const PER_ITERATION: readonly Tab[] = ['REPORT', 'CHATGPT RESPONSE', 'PROMPT', 'CLAUDE EXECUTION', 'CODEX EXECUTION'];
type ResponseView = 'RAW' | 'REVIEW' | 'NEXT_PROMPT';

function reportStatus(it: IterationArtifacts): string {
  const r = it.report;
  if (r.availability === 'AVAILABLE') return r.verification === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
  return r.availability;
}

function execStatus(v: ExecutionView | null): string {
  return v ? v.effectiveStatus : '—';
}

/** Session header + one row per iteration: prompt → Claude session/execution → report →
 * Codex review/verdict (M4.1 §9). Clicking a row opens that iteration's Claude execution. */
function SessionTrace({ summary, data, onSelect }: { summary: SessionSummary; data: SessionArtifacts; onSelect: (iteration: number) => void }) {
  return (
    <div className="trace" data-testid="session-trace">
      <dl className="kv kv-inline trace-head">
        <dt>AI Bridge session</dt>
        <dd className="mono">{summary.runId}</dd>
        <dt>Claude CLI session</dt>
        <dd className="mono" data-testid="trace-claude-session">
          {summary.claudeSessionId ?? 'UNKNOWN'}
        </dd>
        <dt>Codex thread</dt>
        <dd className="mono" data-testid="trace-codex-thread">
          {summary.codexThreadId ?? 'UNKNOWN'}
        </dd>
        <dt>Started</dt>
        <dd>{formatDateTime(summary.startedAt)}</dd>
        <dt>Ended</dt>
        <dd>{formatDateTime(summary.endedAt)}</dd>
        <dt>Final status</dt>
        <dd>{summary.status}</dd>
      </dl>
      <table className="table trace-table">
        <thead>
          <tr>
            <th>Iteration</th>
            <th>Claude session</th>
            <th>Claude</th>
            <th>Exit</th>
            <th>Report</th>
            <th>Codex</th>
            <th>Codex result</th>
            <th>Prompt SHA-256</th>
          </tr>
        </thead>
        <tbody>
          {data.iterations.map((it) => {
            const c = it.claudeExecution?.record;
            const sha = c?.input.sha256 ?? it.claudePrompt?.sha256 ?? null;
            return (
              <tr key={it.iteration} onClick={() => onSelect(it.iteration)} data-testid="trace-row" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(it.iteration)}>
                <td className="mono">#{it.iteration}</td>
                <td className="mono small" data-testid="trace-claude-cell">
                  {!c
                    ? '—'
                    : c.continuity.verdict === 'MISMATCH'
                      ? `${c.cliSessionId.reported} (MISMATCH — yêu cầu resume ${c.cliSessionId.requested ?? 'UNKNOWN'})`
                      : (c.cliSessionId.reported ?? `${c.cliSessionId.requested ?? 'UNKNOWN'} (chưa xác nhận)`)}
                </td>
                <td>{execStatus(it.claudeExecution)}</td>
                <td className="mono">{c?.process.exitCode ?? '—'}</td>
                <td>{reportStatus(it)}</td>
                <td>{execStatus(it.codexExecution)}</td>
                <td>{it.codexVerdict ?? '—'}</td>
                <td className="mono small">{sha ? `${sha.slice(0, 16)}…` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Read-only viewer for one session's artifacts (M4 §10) — REPORT (rendered/raw),
 * CHATGPT RESPONSE, PROMPT (exactly what was sent to Claude), EVENTS, STATE. Content is
 * shown byte-for-byte as Core read it from disk; nothing here can edit it.
 */
export function ArtifactViewer({
  runId,
  refreshKey,
  liveIteration = null,
  summary,
}: {
  runId: string;
  refreshKey?: string;
  liveIteration?: number | null;
  /** When given (Session History), a session header + per-iteration trace is shown. */
  summary?: SessionSummary;
}) {
  const [showCodexInput, setShowCodexInput] = useState(false);
  const { api } = useBridge();
  const [data, setData] = useState<SessionArtifacts | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [tab, setTab] = useState<Tab>('REPORT');
  const [iteration, setIteration] = useState<number | null>(null);
  const [rendered, setRendered] = useState(true);
  const [responseView, setResponseView] = useState<ResponseView>('RAW');

  useEffect(() => {
    let active = true;
    void api.getSessionArtifacts({ runId }).then((res) => {
      if (!active) return;
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    });
    return () => {
      active = false;
    };
  }, [api, runId, refreshKey]);

  const iterations = data?.iterations ?? [];
  const selected = iterations.find((it) => it.iteration === iteration) ?? iterations[iterations.length - 1] ?? null;

  let body;
  if (error) body = <ErrorPanel error={error} />;
  else if (!data) body = <p className="hint">Đang tải…</p>;
  else if (tab === 'EVENTS') body = <ActivityLog events={data.events} emptyText="Không có event cho session này." />;
  else if (tab === 'STATE')
    body = data.state ? (
      <pre className="raw" data-testid="artifact-state">
        {JSON.stringify(data.state, null, 2)}
      </pre>
    ) : (
      <EmptyState title="Không có state">Core chỉ lưu state (current-session.json) cho session hiện tại của project.</EmptyState>
    );
  else if (tab === 'JOURNAL') body = <JournalPanel runId={runId} refreshKey={refreshKey} />;
  else if (!selected) body = <EmptyState title="Chưa có iteration nào" />;
  else if (tab === 'REPORT') {
    const report = selected.report;
    body =
      report.availability === 'AVAILABLE' ? (
        <>
          <div className="toggle">
            <button type="button" className={`btn btn-small ${rendered ? 'active' : ''}`} onClick={() => setRendered(true)}>
              Rendered
            </button>
            <button type="button" className={`btn btn-small ${!rendered ? 'active' : ''}`} onClick={() => setRendered(false)}>
              Raw
            </button>
            <span className={`badge ${report.verification === 'VERIFIED' ? 'badge-ok' : 'badge-warn'}`}>{report.verification === 'VERIFIED' ? 'hash verified' : 'unverified'}</span>
            {report.source === 'CODEX_INPUT' && <span className="badge">khôi phục từ nội dung đã gửi Codex (file report đã bị session sau ghi đè)</span>}
          </div>
          {rendered ? (
            <>
              <ArtifactMeta artifact={report} />
              <Markdown source={report.text} />
            </>
          ) : (
            <Raw artifact={report} />
          )}
        </>
      ) : report.availability === 'MISSING' && selected.iteration === liveIteration ? (
        <EmptyState title="Đang chờ report">Claude đang thực hiện iteration này — report sẽ xuất hiện khi Core phát hiện và kiểm tra xong.</EmptyState>
      ) : (
        <EmptyState title={report.availability === 'MISSING' ? 'Không có report' : 'Report không còn khả dụng'}>
          {report.availability === 'MISSING' ? 'Iteration này không tạo ra report.' : 'File report đã bị một session sau ghi đè và không khôi phục được từ nội dung đã gửi Codex.'}
        </EmptyState>
      );
  } else if (tab === 'CLAUDE EXECUTION') {
    body = (
      <ExecutionPanel
        key={`claude-${selected.iteration}`}
        runId={runId}
        agent="claude"
        iteration={selected.iteration}
        execution={selected.claudeExecution}
        inputArtifact={selected.claudePrompt}
        isLiveStep={selected.iteration === liveIteration}
        onViewInput={() => setTab('PROMPT')}
      />
    );
  } else if (tab === 'CODEX EXECUTION') {
    body = (
      <>
        <ExecutionPanel
          key={`codex-${selected.iteration}`}
          runId={runId}
          agent="codex"
          iteration={selected.iteration}
          execution={selected.codexExecution}
          inputArtifact={selected.codexInput}
          isLiveStep={selected.iteration === liveIteration}
          onViewInput={() => setShowCodexInput((v) => !v)}
        />
        {showCodexInput && selected.codexInput && <Raw artifact={selected.codexInput} testId="artifact-codex-input" />}
      </>
    );
  } else if (tab === 'CHATGPT RESPONSE') {
    body = (
      <>
        <div className="toggle" role="tablist" aria-label="ChatGPT response view">
          <button type="button" className={`btn btn-small ${responseView === 'RAW' ? 'active' : ''}`} onClick={() => setResponseView('RAW')} data-testid="response-view-raw">
            Raw
          </button>
          <button type="button" className={`btn btn-small ${responseView === 'REVIEW' ? 'active' : ''}`} onClick={() => setResponseView('REVIEW')} data-testid="response-view-review">
            Review
          </button>
          <button type="button" className={`btn btn-small ${responseView === 'NEXT_PROMPT' ? 'active' : ''}`} onClick={() => setResponseView('NEXT_PROMPT')} data-testid="response-view-next-prompt">
            Next Prompt
          </button>
        </div>
        {responseView === 'RAW' ? (
          selected.codexResponse ? <Raw artifact={selected.codexResponse} testId="artifact-response" /> : <EmptyState title="Chưa có response cho iteration này" />
        ) : responseView === 'NEXT_PROMPT' ? (
          selected.extractedPrompt ? <Raw artifact={selected.extractedPrompt} testId="artifact-next-prompt" /> : <EmptyState title="Chưa có next prompt cho iteration này (reviewer đã dừng run)" />
        ) : (
          <LazyJournalEntry runId={runId} kind="CHATGPT_REVIEW" iteration={selected.iteration} />
        )}
      </>
    );
  } else {
    const prompt = selected.claudePrompt;
    const recorded = typeof selected.integrity?.claudeInputHash === 'string' ? selected.integrity.claudeInputHash : null;
    body = prompt ? (
      <>
        <ArtifactMeta artifact={prompt} extra={recorded === null ? undefined : recorded === prompt.sha256 ? 'khớp claudeInputHash' : 'KHÔNG khớp claudeInputHash'} />
        <pre className="raw" data-testid="artifact-prompt">
          {prompt.text}
        </pre>
      </>
    ) : (
      <EmptyState title="Không có prompt cho iteration này" />
    );
  }

  return (
    <div className="artifacts">
      {summary && data && (
        <SessionTrace
          summary={summary}
          data={data}
          onSelect={(n) => {
            setIteration(n);
            setTab('CLAUDE EXECUTION');
          }}
        />
      )}
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {PER_ITERATION.includes(tab) && iterations.length > 1 && (
        <div className="iter-picker" aria-label="Iteration">
          {iterations.map((it) => (
            <button key={it.iteration} type="button" className={`btn btn-small ${selected?.iteration === it.iteration ? 'active' : ''}`} onClick={() => setIteration(it.iteration)}>
              #{it.iteration}
            </button>
          ))}
        </div>
      )}
      <div className="artifact-body">{body}</div>
    </div>
  );
}
