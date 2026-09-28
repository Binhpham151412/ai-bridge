import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../../core/session-history/session-history.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { formatDateTime } from '../lib/format.ts';
import { statusLabel } from '../lib/run-summary.ts';

/**
 * The project's sessions straight from Core (`listSessions`: `.ai-bridge/sessions` +
 * event log, newest first), re-read when the project or the live run's status changes.
 */
export function useSessions(): { sessions: SessionSummary[] | null; error: UiError | null } {
  const { api, snapshot } = useBridge();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const projectPath = snapshot?.project?.path ?? null;
  const statusKey = `${snapshot?.status?.runId ?? ''}|${snapshot?.status?.status ?? ''}|${snapshot?.status?.iteration ?? 0}`;

  useEffect(() => {
    let active = true;
    if (!projectPath) {
      setSessions(null);
      return;
    }
    void api.listSessions().then((res) => {
      if (!active) return;
      if (res.ok) {
        setSessions(res.data);
        setError(null);
      } else setError(res.error);
    });
    return () => {
      active = false;
    };
  }, [api, projectPath, statusKey]);

  return { sessions, error };
}

/** Which session a history view shows: an explicit pick, else the navigation target,
 * else the project's current session, else the newest one. */
export function pickSession(sessions: readonly SessionSummary[], explicit: string | null, target: string | null): SessionSummary | null {
  for (const id of [explicit, target]) {
    const hit = id ? sessions.find((s) => s.runId === id) : undefined;
    if (hit) return hit;
  }
  return sessions.find((s) => s.isCurrent) ?? sessions[0] ?? null;
}

function optionLabel(s: SessionSummary): string {
  const rounds = `${s.iterations} round${s.iterations === 1 ? '' : 's'}`;
  return `${s.runId} · ${statusLabel(s.status)} · ${rounds}${s.isCurrent ? ' · current' : ''}`;
}

/** Session selector shared by JOURNAL and ARTIFACTS, with the chosen session's dates. */
export function SessionPicker({ sessions, value, onChange }: { sessions: readonly SessionSummary[]; value: SessionSummary; onChange: (runId: string) => void }) {
  return (
    <div className="session-picker">
      <label className="session-select">
        <span className="session-select-label">Session</span>
        <select value={value.runId} onChange={(e) => onChange(e.target.value)} data-testid="session-select">
          {sessions.map((s) => (
            <option key={s.runId} value={s.runId}>
              {optionLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <span className="session-dates">
        {formatDateTime(value.startedAt)} → {value.endedAt ? formatDateTime(value.endedAt) : value.status === 'RUNNING' ? 'running' : '—'}
      </span>
    </div>
  );
}
