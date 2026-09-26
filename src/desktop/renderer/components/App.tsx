import { useState } from 'react';
import { useBridge } from '../state/BridgeProvider.tsx';
import { Dashboard } from './Dashboard.tsx';
import { ErrorPanel, Pill } from './common.tsx';
import { SessionHistory } from './SessionHistory.tsx';
import { Settings } from './Settings.tsx';
import { SystemCheck } from './SystemCheck.tsx';

type View = 'dashboard' | 'sessions' | 'system' | 'settings';
const NAV: { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'system', label: 'System check' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const { api, snapshot, notice, dismissNotice, runAction } = useBridge();
  const [view, setView] = useState<View>('dashboard');
  const status = snapshot?.status;
  const canSwitchProject = !(snapshot?.runAttached || status?.status === 'RUNNING' || snapshot?.pendingAction);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Điều hướng">
        <div className="brand">AI Bridge</div>
        {NAV.map((n) => (
          <button key={n.id} type="button" className={`nav-item ${view === n.id ? 'active' : ''}`} onClick={() => setView(n.id)} aria-current={view === n.id ? 'page' : undefined} data-testid={`nav-${n.id}`}>
            {n.label}
          </button>
        ))}
        <div className="sidebar-foot">Claude CLI ⇄ Codex CLI · $0</div>
      </nav>

      <div className="main">
        <header className="topbar" data-testid="header">
          <div className="topbar-item">
            <span className="topbar-label">Project</span>
            <span className="topbar-value" title={snapshot?.project?.path}>
              {snapshot?.project?.name ?? 'Chưa chọn'}
            </span>
          </div>
          <div className="topbar-item">
            <span className="topbar-label">Session</span>
            <span className="topbar-value mono">{status?.runId ?? '—'}</span>
          </div>
          <div className="topbar-item">
            <span className="topbar-label">Engine</span>
            <Pill value={status?.status ?? (snapshot ? 'NO_PROJECT' : 'CONNECTING')} />
          </div>
          <div className="topbar-spacer" />
          <button
            type="button"
            className="btn"
            disabled={!canSwitchProject}
            onClick={() => void runAction(() => api.selectProject())}
            title={canSwitchProject ? undefined : 'Không đổi project khi run đang chạy'}
          >
            {snapshot?.project ? 'Đổi project…' : 'Chọn project…'}
          </button>
        </header>

        {notice &&
          (notice.kind === 'error' && notice.error ? (
            <ErrorPanel error={notice.error} onDismiss={dismissNotice} />
          ) : (
            <div className="notice" role="status">
              {notice.text}
              <button type="button" className="btn btn-link" onClick={dismissNotice}>
                Đóng
              </button>
            </div>
          ))}

        <main className="content">
          {view === 'dashboard' && <Dashboard />}
          {view === 'sessions' && <SessionHistory />}
          {view === 'system' && <SystemCheck />}
          {view === 'settings' && <Settings />}
        </main>
      </div>
    </div>
  );
}
