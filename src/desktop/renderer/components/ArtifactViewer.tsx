import { useEffect, useState } from 'react';
import type { ArtifactText, SessionArtifacts } from '../../../core/session-history/session-history.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { Markdown } from '../lib/Markdown.tsx';
import { formatBytes } from '../lib/format.ts';
import { ActivityLog } from './ActivityLog.tsx';
import { EmptyState, ErrorPanel } from './common.tsx';

type Tab = 'REPORT' | 'CHATGPT RESPONSE' | 'PROMPT' | 'EVENTS' | 'STATE';
const TABS: Tab[] = ['REPORT', 'CHATGPT RESPONSE', 'PROMPT', 'EVENTS', 'STATE'];

function ArtifactMeta({ artifact, extra }: { artifact: ArtifactText; extra?: string }) {
  return (
    <p className="artifact-meta mono">
      {artifact.path} · {formatBytes(artifact.bytes)} · sha256 {artifact.sha256.slice(0, 16)}…{extra ? ` · ${extra}` : ''}
      {artifact.truncated && <span className="warn"> · hiển thị đã cắt bớt (file lớn)</span>}
    </p>
  );
}

function Raw({ artifact, testId }: { artifact: ArtifactText; testId?: string }) {
  return (
    <>
      <ArtifactMeta artifact={artifact} />
      <pre className="raw" data-testid={testId ?? 'artifact-raw'}>
        {artifact.text}
      </pre>
    </>
  );
}

/**
 * Read-only viewer for one session's artifacts (M4 §10) — REPORT (rendered/raw),
 * CHATGPT RESPONSE, PROMPT (exactly what was sent to Claude), EVENTS, STATE. Content is
 * shown byte-for-byte as Core read it from disk; nothing here can edit it.
 */
export function ArtifactViewer({ runId, refreshKey, liveIteration = null }: { runId: string; refreshKey?: string; liveIteration?: number | null }) {
  const { api } = useBridge();
  const [data, setData] = useState<SessionArtifacts | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [tab, setTab] = useState<Tab>('REPORT');
  const [iteration, setIteration] = useState<number | null>(null);
  const [rendered, setRendered] = useState(true);

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
  } else if (tab === 'CHATGPT RESPONSE') {
    body = selected.codexResponse ? <Raw artifact={selected.codexResponse} testId="artifact-response" /> : <EmptyState title="Chưa có response cho iteration này" />;
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
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab !== 'EVENTS' && tab !== 'STATE' && iterations.length > 1 && (
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
