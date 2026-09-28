import { useCallback, useMemo, useState } from 'react';
import { useBridge } from '../state/BridgeProvider.tsx';
import { NavProvider, type NavTarget, type View } from '../state/Navigation.tsx';
import { statusLabel } from '../lib/run-summary.ts';
import { ArtifactsView } from './ArtifactsView.tsx';
import { ErrorPanel, Pill } from './common.tsx';
import { JournalView } from './JournalView.tsx';
import { RunView } from './RunView.tsx';
import { Settings } from './Settings.tsx';
import { SystemView } from './SystemView.tsx';

const NAV: { id: View; label: string; hint: string }[] = [
  { id: 'run', label: 'Run', hint: 'What is happening now' },
  { id: 'journal', label: 'Journal', hint: 'Round-by-round history' },
  { id: 'artifacts', label: 'Artifacts', hint: 'Reports, reviews, prompts' },
  { id: 'settings', label: 'Settings', hint: 'Project & run configuration' },
  { id: 'system', label: 'System', hint: 'CLIs, sign-in, runtime' },
];

export function App() {
  const { api, snapshot, notice, dismissNotice, runAction } = useBridge();
  const [nav, setNav] = useState<{ view: View; target: NavTarget | null; seq: number }>({ view: 'run', target: null, seq: 0 });
  const status = snapshot?.status;
  const canSwitchProject = !(snapshot?.runAttached || status?.status === 'RUNNING' || snapshot?.pendingAction);

  const go = useCallback((view: View, target?: NavTarget) => setNav((n) => ({ view, target: target ?? null, seq: n.seq + 1 })), []);
  const navValue = useMemo(() => ({ view: nav.view, target: nav.target, go }), [nav.view, nav.target, go]);
  const coreStatus = status?.status ?? (snapshot ? 'NO_PROJECT' : 'CONNECTING');

  return (
    <NavProvider value={navValue}>
      <div className="shell">
        <nav className="sidebar" aria-label="Điều hướng">
          <div className="brand">AI Bridge</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`nav-item ${nav.view === n.id ? 'active' : ''}`}
              onClick={() => go(n.id)}
              aria-current={nav.view === n.id ? 'page' : undefined}
              title={n.hint}
              data-testid={`nav-${n.id}`}
            >
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
              <span className="topbar-label">AI Bridge session</span>
              <span className="topbar-value mono">{status?.runId ?? '—'}</span>
            </div>
            <div className="topbar-item">
              <span className="topbar-label">Status</span>
              <Pill value={coreStatus} label={status ? statusLabel(coreStatus) : undefined} title={`Core status: ${coreStatus}`} />
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

          {/* Keyed by navigation: following a link (e.g. a round chip) remounts the target
              view so it opens on that session/round instead of its last local pick. */}
          <main className="content" key={`${nav.view}|${nav.seq}`}>
            {nav.view === 'run' && <RunView />}
            {nav.view === 'journal' && <JournalView />}
            {nav.view === 'artifacts' && <ArtifactsView />}
            {nav.view === 'settings' && <Settings />}
            {nav.view === 'system' && <SystemView />}
          </main>
        </div>
      </div>
    </NavProvider>
  );
}
