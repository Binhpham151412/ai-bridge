import { useEffect, useState } from 'react';
import type { SessionSummary } from '../../../core/session-history/session-history.ts';
import type { UiError } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { formatDateTime } from '../lib/format.ts';
import { ArtifactViewer } from './ArtifactViewer.tsx';
import { Card, EmptyState, ErrorPanel, Pill } from './common.tsx';

/** Session History (M4 §11): straight from the project's existing `.ai-bridge/sessions`
 * + event log via Core — no database. Selecting a row opens its artifacts. */
export function SessionHistory() {
  const { api, snapshot } = useBridge();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const projectPath = snapshot?.project?.path ?? null;
  const projectName = snapshot?.project?.name ?? '—';
  const statusKey = `${snapshot?.status?.runId ?? ''}|${snapshot?.status?.status ?? ''}`;

  useEffect(() => {
    let active = true;
    if (!projectPath) return;
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

  if (!projectPath) return <EmptyState title="Chưa chọn project" />;

  return (
    <div className="history">
      <Card title="Session history" className="history-list">
        {error && <ErrorPanel error={error} />}
        {sessions && sessions.length === 0 && <EmptyState title="Project chưa có session nào" />}
        {sessions && sessions.length > 0 && (
          <table className="table" data-testid="session-table">
            <thead>
              <tr>
                <th>AI Bridge session</th>
                <th>Claude CLI session</th>
                <th>Project</th>
                <th>Start</th>
                <th>End</th>
                <th>Status</th>
                <th>Iteration</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.runId}
                  className={selected === s.runId ? 'selected' : ''}
                  onClick={() => setSelected(s.runId)}
                  onKeyDown={(e) => e.key === 'Enter' && setSelected(s.runId)}
                  tabIndex={0}
                  data-testid="session-row"
                >
                  <td className="mono">
                    {s.runId}
                    {s.isCurrent && <span className="badge">current</span>}
                  </td>
                  <td className="mono small" title={s.claudeSessionId ?? 'UNKNOWN'}>
                    {s.claudeSessionId ? `${s.claudeSessionId.slice(0, 8)}…` : 'UNKNOWN'}
                  </td>
                  <td>{projectName}</td>
                  <td>{formatDateTime(s.startedAt)}</td>
                  <td>{formatDateTime(s.endedAt)}</td>
                  <td>
                    <Pill value={s.status} />
                  </td>
                  <td>{s.iterations}</td>
                  <td className="mono small">{s.errorCode ?? (s.recovered ? 'recovered' : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {selected && (
        <Card title={`Artifacts — ${selected}`} className="history-artifacts">
          <ArtifactViewer runId={selected} refreshKey={statusKey} summary={sessions?.find((s) => s.runId === selected)} />
        </Card>
      )}
    </div>
  );
}
