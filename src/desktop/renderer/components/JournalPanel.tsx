import { useEffect, useState } from 'react';
import type { JournalEntry, JournalEntryKind, JournalRound } from '../../../core/journal/journal.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { useNav } from '../state/Navigation.tsx';
import { useJournalIndex } from '../state/useSessionData.ts';
import { Markdown } from '../lib/Markdown.tsx';
import { roundTone, ROUND_STATE_LABEL, ROUND_STATE_MARK, statusLabel, VERDICT_LABEL } from '../lib/run-summary.ts';
import { ArtifactMeta, EmptyState, ErrorPanel, Pill, Raw } from './common.tsx';

/**
 * M4.2 Development Journal — a session-scoped view over the Markdown journal Core
 * generates from the session's already-verified artifacts (execution records, the
 * hash-checked report, Codex's raw response). Nothing here is fetched or rendered until
 * the user picks it: the rounds list comes from one `getJournal` call, and each entry's
 * text is fetched only when selected (`getJournalEntry`) — lazy load, one artifact at a
 * time, never the whole session's Markdown up front.
 */

type Selection = { kind: JournalEntryKind; iteration: number | null };

/** A round's entries in the order they happen: prompt → report → review → next prompt. */
const ROUND_ITEM_KINDS: readonly JournalEntryKind[] = ['CLAUDE_PROMPT', 'CLAUDE_REPORT', 'CHATGPT_REVIEW', 'NEXT_PROMPT'];

const KIND_LABEL: Record<JournalEntryKind, string> = {
  SESSION_INDEX: 'Session Index',
  FINAL_REPORT: 'Final Report',
  CLAUDE_REPORT: 'Claude Report',
  CHATGPT_REVIEW: 'ChatGPT Review',
  CLAUDE_PROMPT: 'Claude Prompt',
  NEXT_PROMPT: 'Next Prompt',
  RAW_CODEX_RESPONSE: 'Raw ChatGPT Response',
};

const KIND_HINT: Partial<Record<JournalEntryKind, string>> = {
  CLAUDE_PROMPT: 'Exactly what AI Bridge sent to Claude in this round.',
  CLAUDE_REPORT: "Claude's development report (the hash-checked report file).",
  CHATGPT_REVIEW: "ChatGPT's review of the report, in readable form.",
  NEXT_PROMPT: 'The prompt ChatGPT wrote for the next round.',
  RAW_CODEX_RESPONSE: "ChatGPT's response exactly as Codex returned it.",
};

/** Upcoming rounds are listed only while the session can still continue. */
const OPEN_STATUSES = new Set(['RUNNING', 'PAUSED', 'INTERRUPTED']);
const MAX_PENDING_SHOWN = 3;

function sameSelection(a: Selection | null, b: Selection): boolean {
  return a !== null && a.kind === b.kind && a.iteration === b.iteration;
}

function verdictText(verdict: string | null): string | null {
  return verdict ? (VERDICT_LABEL[verdict] ?? verdict) : null;
}

/** Fetches and shows exactly one journal entry, with the same Rendered/Raw toggle used
 * for reports elsewhere in the app. Reused by JournalPanel and the ARTIFACTS browser so
 * both share one fetch/render path. */
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
      <div className="toggle" role="group" aria-label="View mode">
        <button type="button" className={`btn btn-small ${rendered ? 'active' : ''}`} aria-pressed={rendered} onClick={() => setRendered(true)}>
          Rendered
        </button>
        <button type="button" className={`btn btn-small ${!rendered ? 'active' : ''}`} aria-pressed={!rendered} onClick={() => setRendered(false)}>
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

function RoundStateBadge({ state }: { state: string }) {
  return (
    <span className={`pill tone-${roundTone(state)}`}>
      <span aria-hidden="true">{ROUND_STATE_MARK[state] ?? '·'}</span>
      {ROUND_STATE_LABEL[state] ?? state}
    </span>
  );
}

/** One round in full: its state and verdict, and each of its entries with a View button. */
function RoundDetail({ runId, round, onView }: { runId: string; round: JournalRound; onView: (kind: JournalEntryKind) => void }) {
  const { go } = useNav();
  const ended = round.verdict === 'DONE' || round.verdict === 'NEED_HUMAN';
  const kinds: JournalEntryKind[] = [...ROUND_ITEM_KINDS, 'RAW_CODEX_RESPONSE'];
  return (
    <div className="round-detail" data-testid="round-detail">
      <header className="round-detail-head">
        <h3>Round {round.iteration}</h3>
        <RoundStateBadge state={round.state} />
        {verdictText(round.verdict) && <span className="round-verdict">{verdictText(round.verdict)}</span>}
      </header>
      <ul className="entry-list">
        {kinds.map((kind) => {
          const available = round.available.includes(kind);
          const missing = kind === 'NEXT_PROMPT' && ended ? 'Không có — reviewer đã kết thúc run ở round này.' : 'Chưa có.';
          return (
            <li key={kind} className={`entry-row ${available ? '' : 'entry-missing'}`}>
              <div className="entry-text">
                <span className="entry-name">{KIND_LABEL[kind]}</span>
                <span className="entry-hint">{available ? KIND_HINT[kind] : missing}</span>
              </div>
              <button type="button" className="btn btn-small" disabled={!available} onClick={() => onView(kind)} data-testid={`round-view-${kind}`}>
                View
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-link" onClick={() => go('artifacts', { runId, iteration: round.iteration })} data-testid="round-open-artifacts">
        Execution details for this round → Artifacts
      </button>
    </div>
  );
}

export function JournalPanel({ runId, refreshKey, initialIteration = null }: { runId: string; refreshKey?: string; initialIteration?: number | null }) {
  const { data: index, error } = useJournalIndex(runId, refreshKey);
  const [selectedRound, setSelectedRound] = useState<number | null>(initialIteration);
  const [selected, setSelected] = useState<Selection | null>(null);

  if (error) return <ErrorPanel error={error} />;
  if (!index) return <p className="hint">Đang tải…</p>;

  const lastRound = index.rounds[index.rounds.length - 1] ?? null;
  const roundShown = index.rounds.find((r) => r.iteration === selectedRound) ?? lastRound;
  const pending: number[] = [];
  if (OPEN_STATUSES.has(index.status) && index.maxIterations !== null) {
    for (let n = (lastRound?.iteration ?? 0) + 1; n <= index.maxIterations && pending.length < MAX_PENDING_SHOWN; n++) pending.push(n);
  }
  const morePending = index.maxIterations !== null && pending.length > 0 && pending[pending.length - 1] < index.maxIterations;

  const pickRound = (n: number) => {
    setSelectedRound(n);
    setSelected(null);
  };

  let body;
  if (selected) {
    const where = selected.iteration === null ? 'Session' : `Round ${selected.iteration}`;
    body = (
      <>
        <nav className="crumbs" aria-label="Journal location">
          {selected.iteration !== null ? (
            <button type="button" className="btn btn-link" onClick={() => setSelected(null)}>
              {where}
            </button>
          ) : (
            <span>{where}</span>
          )}
          <span aria-hidden="true">›</span>
          <span className="crumb-current">{KIND_LABEL[selected.kind]}</span>
        </nav>
        <LazyJournalEntry runId={runId} kind={selected.kind} iteration={selected.iteration} />
      </>
    );
  } else if (roundShown) {
    body = <RoundDetail runId={runId} round={roundShown} onView={(kind) => setSelected({ kind, iteration: roundShown.iteration })} />;
  } else {
    body = <EmptyState title="Chưa có round nào">Nhật ký sẽ xuất hiện khi round đầu tiên bắt đầu.</EmptyState>;
  }

  return (
    <div className="journal-wrap">
      <div className="journal-summary">
        <Pill value={index.status} label={statusLabel(index.status)} title={`Core status: ${index.status}`} />
        <span>
          {index.rounds.length} round{index.rounds.length === 1 ? '' : 's'}
          {index.maxIterations !== null ? ` · max ${index.maxIterations}` : ''}
        </span>
      </div>
      <div className="journal">
        <div className="journal-list" data-testid="journal-list">
          {index.hasSessionIndex && (
            <button
              type="button"
              className={`journal-item ${sameSelection(selected, { kind: 'SESSION_INDEX', iteration: null }) ? 'active' : ''}`}
              onClick={() => setSelected({ kind: 'SESSION_INDEX', iteration: null })}
              data-testid="journal-session-index"
            >
              Session Index
            </button>
          )}
          {index.rounds.length === 0 && <p className="hint">Chưa có round nào.</p>}
          {index.rounds.map((round) => (
            <div key={round.iteration} className={`journal-round ${roundShown?.iteration === round.iteration && !selected ? 'active' : ''}`} data-testid="journal-round">
              <button
                type="button"
                className="journal-round-head"
                onClick={() => pickRound(round.iteration)}
                aria-label={`Round ${round.iteration}, ${ROUND_STATE_LABEL[round.state] ?? round.state}`}
                data-testid="journal-round-head"
              >
                <span className={`round-mark tone-${roundTone(round.state)}`} aria-hidden="true">
                  {ROUND_STATE_MARK[round.state] ?? '·'}
                </span>
                <span className="round-title">Round {round.iteration}</span>
                <span className="round-state">{ROUND_STATE_LABEL[round.state] ?? round.state}</span>
              </button>
              {verdictText(round.verdict) && <span className="round-verdict">{verdictText(round.verdict)}</span>}
              <div className="journal-round-items">
                {ROUND_ITEM_KINDS.filter((kind) => round.available.includes(kind)).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`journal-sub ${sameSelection(selected, { kind, iteration: round.iteration }) ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedRound(round.iteration);
                      setSelected({ kind, iteration: round.iteration });
                    }}
                    data-testid={`journal-item-${kind}`}
                  >
                    {KIND_LABEL[kind]}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {pending.map((n) => (
            <div key={n} className="journal-round pending" data-testid="journal-round-pending">
              <span className="journal-round-head static">
                <span className="round-mark" aria-hidden="true">
                  ○
                </span>
                <span className="round-title">Round {n}</span>
                <span className="round-state">Pending</span>
              </span>
            </div>
          ))}
          {morePending && <p className="hint">… tối đa đến round {index.maxIterations} (dừng sớm nếu reviewer trả DONE).</p>}
          {index.hasFinalReport && (
            <button
              type="button"
              className={`journal-item ${sameSelection(selected, { kind: 'FINAL_REPORT', iteration: null }) ? 'active' : ''}`}
              onClick={() => setSelected({ kind: 'FINAL_REPORT', iteration: null })}
              data-testid="journal-final-report"
            >
              Final Report
            </button>
          )}
        </div>
        <div className="journal-body" data-testid="journal-body">
          {body}
        </div>
      </div>
    </div>
  );
}
