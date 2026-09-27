import { useEffect, useState } from 'react';
import type { JournalEntry, JournalEntryKind, JournalIndex, RoundState } from '../../../core/journal/journal.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { Markdown } from '../lib/Markdown.tsx';
import { ArtifactMeta, EmptyState, ErrorPanel, Raw } from './common.tsx';

/**
 * M4.2 Development Journal — a session-scoped view over the Markdown journal Core
 * generates from the session's already-verified artifacts (execution records, the
 * hash-checked report, Codex's raw response). Nothing here is fetched or rendered until
 * the user picks it: the rounds list comes from one `getJournal` call, and each entry's
 * text is fetched only when selected (`getJournalEntry`) — lazy load, one artifact at a
 * time, never the whole session's Markdown up front.
 */

type Selection = { kind: JournalEntryKind; iteration: number | null };

const ROUND_ITEM_KINDS: readonly JournalEntryKind[] = ['CLAUDE_REPORT', 'CHATGPT_REVIEW', 'CLAUDE_PROMPT', 'NEXT_PROMPT'];

const KIND_LABEL: Record<JournalEntryKind, string> = {
  SESSION_INDEX: 'Session Index',
  FINAL_REPORT: 'Final Report',
  CLAUDE_REPORT: 'Claude Report',
  CHATGPT_REVIEW: 'ChatGPT Review',
  CLAUDE_PROMPT: 'Claude Prompt',
  NEXT_PROMPT: 'Next Prompt',
  RAW_CODEX_RESPONSE: 'Raw Codex Response',
};

const STATE_MARK: Record<RoundState, string> = {
  COMPLETED: '✓',
  RUNNING: '→',
  FAILED: '✗',
  INTERRUPTED: '✗',
  STOPPED: '✗',
  INCOMPLETE: '…',
};

function sameSelection(a: Selection | null, b: Selection): boolean {
  return a !== null && a.kind === b.kind && a.iteration === b.iteration;
}

/** Fetches and shows exactly one journal entry, with the same Rendered/Raw toggle used
 * for reports elsewhere in the app. Reused by JournalPanel and the CHATGPT RESPONSE
 * "Review" sub-view (ArtifactViewer) so both share one fetch/render path. */
export function LazyJournalEntry({ runId, kind, iteration }: { runId: string; kind: JournalEntryKind; iteration: number | null }) {
  const { api } = useBridge();
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [rendered, setRendered] = useState(true);

  useEffect(() => {
    let active = true;
    setEntry(null);
    setError(null);
    const request = iteration === null ? { runId, kind } : { runId, kind, iteration };
    void api.getJournalEntry(request).then((res) => {
      if (!active) return;
      if (res.ok) setEntry(res.data);
      else setError(res.error);
    });
    return () => {
      active = false;
    };
  }, [api, runId, kind, iteration]);

  if (error) return <ErrorPanel error={error} />;
  if (!entry) return <p className="hint">Đang tải…</p>;
  return (
    <>
      <div className="toggle">
        <button type="button" className={`btn btn-small ${rendered ? 'active' : ''}`} onClick={() => setRendered(true)}>
          Rendered
        </button>
        <button type="button" className={`btn btn-small ${!rendered ? 'active' : ''}`} onClick={() => setRendered(false)}>
          Raw
        </button>
      </div>
      {rendered ? (
        <>
          <ArtifactMeta artifact={entry} />
          <Markdown source={entry.text} />
        </>
      ) : (
        <Raw artifact={entry} testId="journal-entry-raw" />
      )}
    </>
  );
}

export function JournalPanel({ runId, refreshKey }: { runId: string; refreshKey?: string }) {
  const { api } = useBridge();
  const [index, setIndex] = useState<JournalIndex | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);

  useEffect(() => {
    let active = true;
    setIndex(null);
    setError(null);
    setSelected(null);
    void api.getJournal({ runId }).then((res) => {
      if (!active) return;
      if (res.ok) setIndex(res.data);
      else setError(res.error);
    });
    return () => {
      active = false;
    };
  }, [api, runId, refreshKey]);

  if (error) return <ErrorPanel error={error} />;
  if (!index) return <p className="hint">Đang tải…</p>;

  return (
    <div className="journal">
      <div className="journal-list" data-testid="journal-list">
        {index.hasSessionIndex && (
          <button
            type="button"
            className={`btn btn-small journal-item ${sameSelection(selected, { kind: 'SESSION_INDEX', iteration: null }) ? 'active' : ''}`}
            onClick={() => setSelected({ kind: 'SESSION_INDEX', iteration: null })}
            data-testid="journal-session-index"
          >
            Session Index
          </button>
        )}
        {index.rounds.length === 0 && <EmptyState title="Chưa có round nào" />}
        {index.rounds.map((round) => (
          <div key={round.iteration} className="journal-round" data-testid="journal-round">
            <div className="journal-round-head">
              <span className="mono">#{round.iteration}</span>
              <span aria-label={round.state}>{STATE_MARK[round.state]}</span>
              <span>{round.verdict ?? '—'}</span>
            </div>
            <div className="journal-round-items">
              {ROUND_ITEM_KINDS.filter((kind) => round.available.includes(kind)).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`btn btn-small ${sameSelection(selected, { kind, iteration: round.iteration }) ? 'active' : ''}`}
                  onClick={() => setSelected({ kind, iteration: round.iteration })}
                  data-testid={`journal-item-${kind}`}
                >
                  {KIND_LABEL[kind]}
                </button>
              ))}
            </div>
          </div>
        ))}
        {index.hasFinalReport && (
          <button
            type="button"
            className={`btn btn-small journal-item ${sameSelection(selected, { kind: 'FINAL_REPORT', iteration: null }) ? 'active' : ''}`}
            onClick={() => setSelected({ kind: 'FINAL_REPORT', iteration: null })}
            data-testid="journal-final-report"
          >
            FINAL REPORT
          </button>
        )}
      </div>
      <div className="journal-body" data-testid="journal-body">
        {selected ? (
          <LazyJournalEntry runId={runId} kind={selected.kind} iteration={selected.iteration} />
        ) : (
          <EmptyState title="Chọn một mục">Chọn Session Index, một round, hoặc FINAL REPORT ở bên trái để xem nhật ký.</EmptyState>
        )}
      </div>
    </div>
  );
}
