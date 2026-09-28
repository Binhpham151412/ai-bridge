import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExecutionOutput } from '../../../core/session-history/session-history.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { formatBytes } from '../lib/format.ts';
import { ErrorPanel } from './common.tsx';

type Stream = 'stdout' | 'stderr';

/** Lines of `text` containing `query` (case-insensitive), with their 1-based numbers. */
function filterLines(text: string, query: string): { n: number; line: string }[] {
  const q = query.toLowerCase();
  const out: { n: number; line: string }[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.toLowerCase().includes(q)) out.push({ n: i + 1, line });
  });
  return out;
}

/**
 * Raw CLI output of one execution (M4.1 `getExecutionOutput`): the redacted *tail* Core
 * returns (at most 256 KB — the full file stays on disk), fetched only when asked for.
 * Search filters lines client-side; Copy copies the loaded text. Nothing is streamed.
 */
export function CliOutput({
  runId,
  iteration,
  agent,
  initialStream = null,
  disabled = false,
  disabledReason,
}: {
  runId: string;
  iteration: number;
  agent: 'claude' | 'codex';
  /** Load this stream on mount (the caller already has the user's click). */
  initialStream?: Stream | null;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const { api } = useBridge();
  const [stream, setStream] = useState<Stream | null>(null);
  const [data, setData] = useState<ExecutionOutput | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(true);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const loadSeq = useRef(0);

  const load = async (s: Stream) => {
    const seq = ++loadSeq.current;
    setStream(s);
    setCopyNote(null);
    const res = await api.getExecutionOutput({ runId, iteration, agent, stream: s });
    if (seq !== loadSeq.current) return; // a newer request superseded this one
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else {
      setData(null);
      setError(res.error);
    }
  };

  useEffect(() => {
    if (initialStream && !disabled) void load(initialStream);
    // Mount-only: later loads are explicit clicks.
  }, []);

  const matches = useMemo(() => (data && query.trim() !== '' ? filterLines(data.text, query.trim()) : null), [data, query]);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.text);
      setCopyNote('Copied.');
      return;
    } catch {
      // Main denies every permission request (the clipboard API included) — fall back to
      // selecting the text and the gesture-based copy command.
    }
    const pre = preRef.current;
    const sel = window.getSelection();
    if (!pre || !sel) {
      setCopyNote('Clear the search to copy the full output.');
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(pre);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    setCopyNote(ok ? 'Copied.' : 'Text selected — press Ctrl+C to copy.');
  };

  const name = agent === 'claude' ? 'Claude' : 'Codex';
  return (
    <div className="cli-output" data-testid={`cli-output-${agent}`}>
      <div className="cli-toolbar">
        <div className="toggle" role="group" aria-label={`${name} output stream`}>
          <button type="button" className={`btn btn-small ${stream === 'stdout' ? 'active' : ''}`} onClick={() => void load('stdout')} disabled={disabled} aria-pressed={stream === 'stdout'} data-testid={`cli-${agent}-stdout`}>
            stdout
          </button>
          <button type="button" className={`btn btn-small ${stream === 'stderr' ? 'active' : ''}`} onClick={() => void load('stderr')} disabled={disabled} aria-pressed={stream === 'stderr'} data-testid={`cli-${agent}-stderr`}>
            stderr
          </button>
        </div>
        {data && (
          <>
            <input type="search" className="cli-search" placeholder="Search output…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search output" data-testid={`cli-${agent}-search`} />
            <label className="check cli-wrap">
              <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
            </label>
            <button type="button" className="btn btn-small" onClick={() => void copy()} data-testid={`cli-${agent}-copy`}>
              Copy
            </button>
          </>
        )}
      </div>
      {disabled && disabledReason && <p className="hint">{disabledReason}</p>}
      {!disabled && !stream && <p className="hint">Chọn stdout hoặc stderr để tải output của CLI (phần cuối, tối đa 256 KB, đã che thông tin nhạy cảm).</p>}
      {error && <ErrorPanel error={error} />}
      {data && stream && (
        <>
          <p className="artifact-meta mono">
            {stream === 'stdout' ? 'CLI output (stdout — luồng event của CLI, không phải transcript hội thoại)' : 'stderr'} · {formatBytes(data.bytes)}
            {data.truncated ? ' · chỉ hiển thị phần cuối (256 KB)' : ''} · đã che thông tin nhạy cảm
            {matches ? ` · ${matches.length} dòng khớp` : ''}
            {copyNote ? ` · ${copyNote}` : ''}
          </p>
          {matches ? (
            <pre className={`raw exec-output ${wrap ? '' : 'nowrap'}`} data-testid="exec-output-filtered" tabIndex={0}>
              {matches.length === 0 ? '(không có dòng nào khớp)' : matches.map((m) => `${String(m.n).padStart(5, ' ')}  ${m.line}`).join('\n')}
            </pre>
          ) : (
            <pre ref={preRef} className={`raw exec-output ${wrap ? '' : 'nowrap'}`} data-testid="exec-output" tabIndex={0}>
              {data.text === '' ? '(trống)' : data.text}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
