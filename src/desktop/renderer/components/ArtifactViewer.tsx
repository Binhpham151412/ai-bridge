import { useState } from 'react';
import type { JournalIndex } from '../../../core/journal/journal.ts';
import type { ArtifactText, ExecutionView, IterationArtifacts, SessionArtifacts, SessionSummary } from '../../../core/session-history/session-history.ts';
import { useJournalIndex, useSessionArtifacts } from '../state/useSessionData.ts';
import { Markdown } from '../lib/Markdown.tsx';
import { basename, formatDateTime } from '../lib/format.ts';
import { ActivityLog } from './ActivityLog.tsx';
import { ArtifactMeta, EmptyState, ErrorPanel, Raw } from './common.tsx';
import { ExecutionPanel } from './ExecutionPanel.tsx';
import { LazyJournalEntry } from './JournalPanel.tsx';

const nnn = (n: number) => String(n).padStart(3, '0');

function execStatus(v: ExecutionView | null): string {
  return v ? v.effectiveStatus : '—';
}

function reportStatus(it: IterationArtifacts): string {
  const r = it.report;
  if (r.availability === 'AVAILABLE') return r.verification === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
  return r.availability;
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
      <div className="table-scroll">
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
    </div>
  );
}

interface Item {
  key: string;
  label: string;
  /** The label is a real file name (shown in the monospace file font). */
  file?: boolean;
  badge?: { text: string; tone: 'ok' | 'warn' | 'plain' };
}

interface Group {
  title: string;
  items: Item[];
}

function fileLabel(a: ArtifactText, fallback: string): string {
  return basename(a.path) || fallback;
}

function execBadge(v: ExecutionView): Item['badge'] {
  return { text: v.effectiveStatus.toLowerCase(), tone: v.effectiveStatus === 'COMPLETED' ? 'ok' : 'warn' };
}

/** The session's files as a browsable tree — built only from what Core returned
 * (`getSessionArtifacts` + the journal index); an entry exists here only if it exists
 * on disk (reports are always listed, with their real availability). */
function buildGroups(data: SessionArtifacts, journal: JournalIndex | null, withTrace: boolean): Group[] {
  const final: Item[] = [];
  if (journal?.hasSessionIndex) final.push({ key: 'journal:SESSION_INDEX', label: 'Session index' });
  if (journal?.hasFinalReport) final.push({ key: 'journal:FINAL_REPORT', label: 'Final report' });

  const reports: Item[] = [];
  const reviews: Item[] = [];
  const prompts: Item[] = [];
  const technical: Item[] = [];
  if (withTrace) technical.push({ key: 'trace', label: 'Execution trace (all rounds)' });

  for (const it of data.iterations) {
    const n = it.iteration;
    const r = it.report;
    const reportName = basename(r.path);
    reports.push({
      key: `report:${n}`,
      label: reportName || `${nnn(n)} · report`,
      file: reportName !== '',
      badge: r.availability === 'AVAILABLE' ? (r.verification === 'VERIFIED' ? { text: 'verified', tone: 'ok' } : { text: 'unverified', tone: 'warn' }) : { text: r.availability.toLowerCase(), tone: 'warn' },
    });

    const round = journal?.rounds.find((x) => x.iteration === n);
    if (round?.available.includes('CHATGPT_REVIEW')) reviews.push({ key: `review:${n}`, label: `${nnn(n)} · ChatGPT review` });
    if (it.codexResponse) reviews.push({ key: `response:${n}`, label: fileLabel(it.codexResponse, `${nnn(n)} · raw response`), file: true, badge: { text: 'raw', tone: 'plain' } });

    if (it.claudePrompt) prompts.push({ key: `prompt:${n}`, label: fileLabel(it.claudePrompt, `${nnn(n)} · Claude prompt`), file: true });
    if (it.codexInput) prompts.push({ key: `input:${n}`, label: fileLabel(it.codexInput, `${nnn(n)} · Codex input`), file: true, badge: { text: 'to Codex', tone: 'plain' } });
    if (it.extractedPrompt) prompts.push({ key: `next:${n}`, label: fileLabel(it.extractedPrompt, `${nnn(n)} · next prompt`), file: true, badge: { text: 'next', tone: 'plain' } });

    if (it.claudeExecution) technical.push({ key: `exec-claude:${n}`, label: `${nnn(n)} · Claude execution`, badge: execBadge(it.claudeExecution) });
    if (it.codexExecution) technical.push({ key: `exec-codex:${n}`, label: `${nnn(n)} · Codex execution`, badge: execBadge(it.codexExecution) });
  }
  technical.push({ key: 'events', label: 'Events' });
  technical.push({ key: 'state', label: 'State (current-session.json)' });

  return [
    { title: 'Final', items: final },
    { title: 'Reports', items: reports },
    { title: 'Reviews', items: reviews },
    { title: 'Prompts', items: prompts },
    { title: 'Technical', items: technical },
  ].filter((g) => g.items.length > 0);
}

function defaultKey(data: SessionArtifacts, iteration: number | null, withTrace: boolean): string {
  const its = data.iterations;
  const n = iteration !== null && its.some((it) => it.iteration === iteration) ? iteration : (its[its.length - 1]?.iteration ?? null);
  if (n !== null) return `report:${n}`;
  return withTrace ? 'trace' : 'events';
}

function ReportView({ it, live }: { it: IterationArtifacts; live: boolean }) {
  const [rendered, setRendered] = useState(true);
  const report = it.report;
  if (report.availability !== 'AVAILABLE') {
    if (report.availability === 'MISSING' && live) return <EmptyState title="Đang chờ report">Claude đang thực hiện iteration này — report sẽ xuất hiện khi Core phát hiện và kiểm tra xong.</EmptyState>;
    return (
      <EmptyState title={report.availability === 'MISSING' ? 'Không có report' : 'Report không còn khả dụng'}>
        {report.availability === 'MISSING' ? 'Iteration này không tạo ra report.' : 'File report đã bị một session sau ghi đè và không khôi phục được từ nội dung đã gửi Codex.'}
      </EmptyState>
    );
  }
  return (
    <>
      <div className="toggle" role="group" aria-label="View mode">
        <button type="button" className={`btn btn-small ${rendered ? 'active' : ''}`} aria-pressed={rendered} onClick={() => setRendered(true)}>
          Rendered
        </button>
        <button type="button" className={`btn btn-small ${!rendered ? 'active' : ''}`} aria-pressed={!rendered} onClick={() => setRendered(false)}>
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
  );
}

/**
 * ARTIFACTS — read-only browser over one session's files: reports, reviews, prompts,
 * the journal's session index / final report, and the technical record (execution
 * records, trace, events, state). Content is shown byte-for-byte as Core read it from
 * disk; nothing here can edit it, and nothing is copied.
 */
export function ArtifactViewer({
  runId,
  refreshKey,
  liveIteration = null,
  summary,
  initialIteration = null,
}: {
  runId: string;
  refreshKey?: string;
  liveIteration?: number | null;
  /** When given, the per-iteration execution trace (M4.1) is offered under Technical. */
  summary?: SessionSummary;
  initialIteration?: number | null;
}) {
  const { data, error } = useSessionArtifacts(runId, refreshKey);
  const { data: journal } = useJournalIndex(runId, refreshKey);
  const [picked, setPicked] = useState<string | null>(null);

  if (error) return <ErrorPanel error={error} />;
  if (!data) return <p className="hint">Đang tải…</p>;

  const withTrace = summary !== undefined;
  const groups = buildGroups(data, journal, withTrace);
  const items = groups.flatMap((g) => g.items);
  const selected = picked && items.some((i) => i.key === picked) ? picked : defaultKey(data, initialIteration, withTrace);
  const [kind, num] = selected.split(':');
  const iteration = num === undefined || kind === 'journal' ? null : Number(num);
  const it = iteration === null ? null : (data.iterations.find((x) => x.iteration === iteration) ?? null);
  const label = items.find((i) => i.key === selected)?.label ?? '';

  let body;
  if (kind === 'trace' && summary) body = <SessionTrace summary={summary} data={data} onSelect={(n) => setPicked(`exec-claude:${n}`)} />;
  else if (kind === 'events') body = <ActivityLog events={data.events} emptyText="Không có event cho session này." />;
  else if (kind === 'state')
    body = data.state ? (
      <pre className="raw" data-testid="artifact-state">
        {JSON.stringify(data.state, null, 2)}
      </pre>
    ) : (
      <EmptyState title="Không có state">Core chỉ lưu state (current-session.json) cho session hiện tại của project.</EmptyState>
    );
  else if (kind === 'journal') body = <LazyJournalEntry runId={runId} kind={num === 'FINAL_REPORT' ? 'FINAL_REPORT' : 'SESSION_INDEX'} iteration={null} />;
  else if (!it) body = <EmptyState title="Chưa có iteration nào" />;
  else if (kind === 'report') body = <ReportView key={it.iteration} it={it} live={it.iteration === liveIteration} />;
  else if (kind === 'review') body = <LazyJournalEntry runId={runId} kind="CHATGPT_REVIEW" iteration={it.iteration} />;
  else if (kind === 'response') body = it.codexResponse ? <Raw artifact={it.codexResponse} testId="artifact-response" /> : <EmptyState title="Chưa có response cho iteration này" />;
  else if (kind === 'next') body = it.extractedPrompt ? <Raw artifact={it.extractedPrompt} testId="artifact-next-prompt" /> : <EmptyState title="Chưa có next prompt cho iteration này (reviewer đã dừng run)" />;
  else if (kind === 'input') body = it.codexInput ? <Raw artifact={it.codexInput} testId="artifact-codex-input" /> : <EmptyState title="Không có input Codex cho iteration này" />;
  else if (kind === 'exec-claude' || kind === 'exec-codex') {
    const agent = kind === 'exec-claude' ? 'claude' : 'codex';
    const input = agent === 'claude' ? it.claudePrompt : it.codexInput;
    body = (
      <ExecutionPanel
        key={`${agent}-${it.iteration}`}
        runId={runId}
        agent={agent}
        iteration={it.iteration}
        execution={agent === 'claude' ? it.claudeExecution : it.codexExecution}
        inputArtifact={input}
        isLiveStep={it.iteration === liveIteration}
        onViewInput={input ? () => setPicked(agent === 'claude' ? `prompt:${it.iteration}` : `input:${it.iteration}`) : undefined}
      />
    );
  } else {
    const prompt = it.claudePrompt;
    const recorded = typeof it.integrity?.claudeInputHash === 'string' ? it.integrity.claudeInputHash : null;
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
    <div className="browser">
      <nav className="browser-tree" aria-label="Session files" data-testid="artifact-tree">
        {groups.map((g) => (
          <div key={g.title} className="tree-group">
            <h3 className="tree-title">{g.title}</h3>
            {g.items.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`tree-item ${item.key === selected ? 'active' : ''}`}
                aria-current={item.key === selected ? 'true' : undefined}
                onClick={() => setPicked(item.key)}
                data-testid="artifact-item"
                data-key={item.key}
                title={item.label}
              >
                <span className={`tree-label ${item.file ? 'tree-file' : ''}`}>{item.label}</span>
                {item.badge && <span className={`tree-badge tree-badge-${item.badge.tone}`}>{item.badge.text}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="browser-view" data-testid="artifact-view">
        <h2 className={`browser-view-title ${items.find((i) => i.key === selected)?.file ? 'tree-file' : ''}`}>{label}</h2>
        <div className="artifact-body">{body}</div>
      </div>
    </div>
  );
}
