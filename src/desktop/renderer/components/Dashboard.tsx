import { useState } from 'react';
import { useBridge } from '../state/BridgeProvider.tsx';
import { ActivityLog } from './ActivityLog.tsx';
import { ArtifactViewer } from './ArtifactViewer.tsx';
import { Card, EmptyState, ErrorPanel } from './common.tsx';
import { RecoveryBanner } from './RecoveryBanner.tsx';
import { RunControls } from './RunControls.tsx';
import { RunPanel } from './RunPanel.tsx';
import { StartRunDialog } from './StartRunDialog.tsx';

export function Dashboard() {
  const { api, snapshot, events, runAction } = useBridge();
  const [starting, setStarting] = useState(false);

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

  const status = snapshot?.status;
  const runId = status?.runId ?? null;
  // Re-read artifacts whenever Core's progress moves (iteration, phase, or final status).
  const artifactKey = `${status?.iteration ?? 0}|${status?.currentPhase ?? ''}|${status?.status ?? ''}`;

  return (
    <div className="dashboard">
      <RecoveryBanner />
      {snapshot?.lastError && <ErrorPanel error={snapshot.lastError} />}
      <RunPanel />
      <RunControls onStart={() => setStarting(true)} />
      <div className="dash-bottom">
        <Card title="Activity" className="dash-activity">
          <ActivityLog events={events} />
        </Card>
        <Card title="Artifacts — session hiện tại" className="dash-artifacts">
          {runId ? (
            <ArtifactViewer runId={runId} refreshKey={artifactKey} liveIteration={status?.status === 'RUNNING' ? status.iteration : null} />
          ) : (
            <EmptyState title="Chưa có session nào" />
          )}
        </Card>
      </div>
      {starting && <StartRunDialog onClose={() => setStarting(false)} />}
    </div>
  );
}
