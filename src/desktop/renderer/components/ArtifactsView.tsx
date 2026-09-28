import { useState } from 'react';
import { useBridge } from '../state/BridgeProvider.tsx';
import { useNav } from '../state/Navigation.tsx';
import { statusLabel } from '../lib/run-summary.ts';
import { ArtifactViewer } from './ArtifactViewer.tsx';
import { Card, EmptyState, ErrorPanel, Pill } from './common.tsx';
import { pickSession, SessionPicker, useSessions } from './SessionPicker.tsx';

/** ARTIFACTS — every file a session produced, from the project's `.ai-bridge/sessions`
 * via Core (no copies, no database). The session header carries the CLI identifiers. */
export function ArtifactsView() {
  const { snapshot } = useBridge();
  const { target } = useNav();
  const { sessions, error } = useSessions();
  const [picked, setPicked] = useState<string | null>(null);

  if (!snapshot?.project) return <EmptyState title="Chưa chọn project" />;
  if (error) return <ErrorPanel error={error} />;
  if (!sessions) return <p className="hint">Đang tải…</p>;
  if (sessions.length === 0) return <EmptyState title="Project chưa có session nào" />;

  const session = pickSession(sessions, picked, target?.runId ?? null)!;
  const status = snapshot.status;
  const live = status !== null && status.runId === session.runId ? status : null;
  // The live session's files are re-read as Core moves; finished sessions don't change.
  const refreshKey = live ? `${live.iteration}|${live.currentPhase ?? ''}|${live.status}` : undefined;
  const initialIteration = !picked && target?.runId === session.runId ? (target.iteration ?? null) : null;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Artifacts</h1>
          <p className="page-sub">Reports, reviews and prompts exactly as stored — read-only.</p>
        </div>
        <SessionPicker sessions={sessions} value={session} onChange={setPicked} />
      </header>
      <dl className="session-facts" data-testid="session-facts">
        <div>
          <dt>Status</dt>
          <dd>
            <Pill value={session.status} label={statusLabel(session.status)} title={`Core status: ${session.status}`} />
          </dd>
        </div>
        <div>
          <dt>Rounds</dt>
          <dd>{session.iterations}</dd>
        </div>
        <div>
          <dt>Claude CLI session</dt>
          <dd className="mono small" title={session.claudeSessionId ?? 'UNKNOWN'} data-testid="facts-claude-session">
            {session.claudeSessionId ?? 'UNKNOWN'}
          </dd>
        </div>
        <div>
          <dt>Codex thread</dt>
          <dd className="mono small" title={session.codexThreadId ?? 'UNKNOWN'}>
            {session.codexThreadId ?? 'UNKNOWN'}
          </dd>
        </div>
        {(session.errorCode || session.recovered) && (
          <div>
            <dt>Result</dt>
            <dd className="mono small" title={session.errorCode ?? 'recovered'}>
              {session.errorCode ?? 'recovered'}
            </dd>
          </div>
        )}
      </dl>
      <Card className="artifacts-card">
        <ArtifactViewer
          key={`${session.runId}|${initialIteration ?? ''}`}
          runId={session.runId}
          refreshKey={refreshKey}
          liveIteration={live?.status === 'RUNNING' ? live.iteration : null}
          summary={session}
          initialIteration={initialIteration}
        />
      </Card>
    </div>
  );
}
