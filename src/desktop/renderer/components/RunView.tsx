import { useEffect, useMemo, useState } from 'react';
import type { JournalRound } from '../../../core/journal/journal.ts';
import type { BridgeSnapshot } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { useNav } from '../state/Navigation.tsx';
import { useJournalIndex } from '../state/useSessionData.ts';
import { isTechnicalEvent } from '../lib/events-store.ts';
import { formatElapsed } from '../lib/format.ts';
import { describeAgent, describeHeadline, roundSteps, roundTone, ROUND_STATE_LABEL, ROUND_STATE_MARK, statusLabel, VERDICT_LABEL } from '../lib/run-summary.ts';
import { ActivityLog } from './ActivityLog.tsx';
import { Card, Disclosure, EmptyState, ErrorPanel, Pill } from './common.tsx';
import { RecoveryBanner } from './RecoveryBanner.tsx';
import { RunControls } from './RunControls.tsx';
import { StartRunDialog } from './StartRunDialog.tsx';
import { RunTechnicalDetails, RunTechnicalOutput } from './TechnicalDetails.tsx';

const TERMINAL = new Set(['DONE', 'NEED_HUMAN', 'ERROR', 'STOPPED', 'STOPPED_MAX_ITERATIONS', 'PAUSED', 'INTERRUPTED']);

function useElapsed(snapshot: BridgeSnapshot | null): string {
  const status = snapshot?.status;
  const [now, setNow] = useState(() => Date.now());
  const live = status?.status === 'RUNNING';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (!status?.startedAt) return '—';
  const end = TERMINAL.has(status.status) && status.updatedAt ? Date.parse(status.updatedAt) : now;
  return formatElapsed(end - Date.parse(status.startedAt));
}

function AgentTile({ agent, name, role }: { agent: 'claude' | 'codex'; name: string; role: string }) {
  const { snapshot } = useBridge();
  const line = describeAgent(agent, snapshot);
  const active = line.raw === 'EXECUTING' || line.raw === 'REVIEWING';
  return (
    <div className={`agent ${active ? 'agent-active' : ''}`} data-testid={`agent-${agent}`}>
      <div className="agent-head">
        <span className="agent-name">{name}</span>
        <Pill value={line.raw} label={line.label} title={`Core activity: ${line.raw}`} />
      </div>
      <p className="agent-detail">{line.detail}</p>
      <p className="agent-role">{role}</p>
    </div>
  );
}

/** Status, round, one plain sentence, the two agents and the controls — the part of the
 * screen that answers "what is happening right now?" at a glance. */
function RunHero({ onStart, endDetail }: { onStart: () => void; endDetail: string | null }) {
  const { snapshot } = useBridge();
  const status = snapshot?.status ?? null;
  const elapsed = useElapsed(snapshot);
  const headline = describeHeadline(snapshot, endDetail);
  const coreStatus = status?.status ?? 'NOT_STARTED';

  return (
    <section className="hero" data-testid="run-hero" aria-label="Current run">
      <div className="hero-top">
        <div className="hero-status" data-testid="run-status">
          <Pill value={coreStatus} label={statusLabel(coreStatus)} title={`Core status: ${coreStatus}`} />
        </div>
        <div className="hero-round" data-testid="iteration" aria-label="Review round">
          <span className="hero-label">Round</span>
          <span className="hero-round-now">{status && status.iteration > 0 ? status.iteration : '—'}</span>
          <span className="hero-round-sep">/</span>
          <span className="hero-round-max">{status?.maxIterations ?? '—'}</span>
        </div>
        <div className="hero-elapsed">
          <span className="hero-label">Elapsed</span>
          <span className="mono" data-testid="elapsed">
            {elapsed}
          </span>
        </div>
      </div>
      <p className={`hero-headline text-${headline.tone}`} data-testid="run-activity" aria-live="polite">
        {headline.text}
      </p>
      {headline.note && (
        <p className="hero-note" data-testid="run-activity-note">
          {headline.note}
        </p>
      )}
      <div className="agents">
        <AgentTile agent="claude" name="Claude" role="Developer · Claude Code CLI" />
        <AgentTile agent="codex" name="ChatGPT / Codex" role="Reviewer · Codex CLI" />
      </div>
      <RunControls onStart={onStart} />
    </section>
  );
}

function RoundBadge({ state }: { state: string }) {
  return (
    <span className={`pill tone-${roundTone(state)}`}>
      <span aria-hidden="true">{ROUND_STATE_MARK[state] ?? '·'}</span>
      {ROUND_STATE_LABEL[state] ?? state}
    </span>
  );
}

function RoundChip({ round, current, onOpen }: { round: JournalRound; current: boolean; onOpen: () => void }) {
  const verdict = round.verdict ? (VERDICT_LABEL[round.verdict] ?? round.verdict) : null;
  return (
    <button
      type="button"
      className={`round-chip tone-${roundTone(round.state)} ${current ? 'current' : ''}`}
      onClick={onOpen}
      title={`Round ${round.iteration} — ${ROUND_STATE_LABEL[round.state] ?? round.state}${verdict ? ` — ${verdict}` : ''}. Open in Journal.`}
      aria-label={`Round ${round.iteration}, ${ROUND_STATE_LABEL[round.state] ?? round.state}${verdict ? `, ${verdict}` : ''}`}
      data-testid="round-chip"
    >
      <span aria-hidden="true">{ROUND_STATE_MARK[round.state] ?? '·'}</span> {round.iteration}
    </button>
  );
}

/** The round Core is on: a live 4-stage stepper while running, otherwise the round's
 * recorded outcome (journal). Below it, every round so far — each opens in JOURNAL. */
function RoundCard({ runId, refreshKey }: { runId: string; refreshKey: string }) {
  const { snapshot } = useBridge();
  const { go } = useNav();
  const { data: journal } = useJournalIndex(runId, refreshKey);
  const status = snapshot?.status ?? null;
  const steps = roundSteps(snapshot);
  const iteration = status?.iteration ?? 0;
  const rounds = journal?.rounds ?? [];
  const latest = rounds.find((r) => r.iteration === iteration) ?? rounds[rounds.length - 1] ?? null;

  return (
    <Card title={iteration > 0 ? `Current round · Round ${iteration}` : 'Current round'} className="round-card">
      {steps ? (
        <ol className="stepper" aria-label={`Round ${iteration} progress`} data-testid="round-steps">
          {steps.map((s) => (
            <li key={s.label} className={`stepper-step step-${s.state}`} aria-current={s.state === 'active' ? 'step' : undefined}>
              <span className="stepper-dot" aria-hidden="true" />
              <span className="stepper-label">{s.label}</span>
            </li>
          ))}
        </ol>
      ) : latest ? (
        <p className="round-outcome" data-testid="round-outcome">
          <RoundBadge state={latest.state} />
          <span>
            Round {latest.iteration}
            {latest.verdict ? ` · ${VERDICT_LABEL[latest.verdict] ?? latest.verdict}` : ''}
          </span>
        </p>
      ) : (
        <p className="hint">{status?.status === 'RUNNING' ? 'Round chưa bắt đầu.' : 'Chưa có round nào.'}</p>
      )}
      {rounds.length > 0 && (
        <div className="round-history">
          <span className="round-history-label">Rounds</span>
          <div className="round-chips">
            {rounds.map((r) => (
              <RoundChip key={r.iteration} round={r} current={r.iteration === iteration} onOpen={() => go('journal', { runId, iteration: r.iteration })} />
            ))}
          </div>
          <button type="button" className="btn btn-link" onClick={() => go('journal', { runId })} data-testid="open-journal">
            Open journal →
          </button>
        </div>
      )}
    </Card>
  );
}

/** RUN — the primary screen: what AI Bridge, Claude and ChatGPT are doing right now.
 * Technical detail and raw CLI output live in collapsed sections at the bottom. */
export function RunView() {
  const { api, snapshot, events, runAction } = useBridge();
  const [starting, setStarting] = useState(false);
  const status = snapshot?.status ?? null;
  const runId = status?.runId ?? null;
  // Re-read artifacts/journal whenever Core's progress moves (iteration, phase, or final status).
  const refreshKey = `${status?.iteration ?? 0}|${status?.currentPhase ?? ''}|${status?.status ?? ''}`;
  const runEvents = useMemo(() => (runId ? events.filter((e) => e.runId === runId) : events), [events, runId]);
  const feed = useMemo(() => runEvents.filter((e) => !isTechnicalEvent(e)), [runEvents]);
  // The detail Core recorded on this session's final event (errorCode / stop reason).
  const endDetail = useMemo(() => {
    if (!runId) return null;
    const end = [...runEvents].reverse().find((e) => e.event === 'RUN_COMPLETED' || e.event === 'RUN_STOPPED');
    return end?.detail ?? null;
  }, [runEvents, runId]);

  if (snapshot && !snapshot.project) {
    return (
      <EmptyState title="Chưa chọn project">
        <p>Chọn thư mục project để AI Bridge làm việc. Core sẽ kiểm tra project, lock và System Check trước mỗi run.</p>
        <button type="button" className="btn btn-primary" onClick={() => void runAction(() => api.selectProject())}>
          Chọn project…
        </button>
      </EmptyState>
    );
  }

  return (
    <div className="run-view">
      <RecoveryBanner />
      {snapshot?.lastError && <ErrorPanel error={snapshot.lastError} />}
      <RunHero onStart={() => setStarting(true)} endDetail={endDetail} />
      <div className={`run-columns ${runId ? '' : 'single'}`}>
        {runId && <RoundCard runId={runId} refreshKey={refreshKey} />}
        <Card title="Recent activity" className="feed-card">
          <ActivityLog events={feed} variant="feed" emptyText={runId ? 'Chưa có hoạt động cho session này.' : 'Chưa có hoạt động.'} />
        </Card>
      </div>
      <Disclosure title="Technical details" summary="Core state · session ids · PIDs · execution records" testId="tech-details">
        <RunTechnicalDetails refreshKey={refreshKey} />
      </Disclosure>
      <Disclosure title="Technical output" summary="raw stdout / stderr · full event log" testId="tech-output">
        <RunTechnicalOutput refreshKey={refreshKey} events={runEvents} />
      </Disclosure>
      {starting && <StartRunDialog onClose={() => setStarting(false)} />}
    </div>
  );
}
