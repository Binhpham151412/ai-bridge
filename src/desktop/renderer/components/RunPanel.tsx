import { useEffect, useState } from 'react';
import type { BridgeSnapshot } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { formatElapsed } from '../lib/format.ts';
import { Card, Pill } from './common.tsx';

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

/** Run Status + Iteration + Claude/Codex activity — every value straight from Core. A PID
 * is only shown while Core reports that agent as active: after a crash the state file
 * still holds the last (now dead) PIDs. */
export function RunPanel() {
  const { snapshot } = useBridge();
  const elapsed = useElapsed(snapshot);
  const status = snapshot?.status ?? null;
  const engineStatus = status?.status ?? 'NO_PROJECT';

  return (
    <div className="run-grid">
      <Card title="Run status" className="run-status">
        <div className="big-status" data-testid="run-status">
          <Pill value={engineStatus} />
        </div>
        <dl className="kv">
          <dt>Phase (Core)</dt>
          <dd data-testid="run-phase">{status?.currentPhase ?? '—'}</dd>
          <dt>Session</dt>
          <dd className="mono">{status?.runId ?? '—'}</dd>
          <dt>Elapsed</dt>
          <dd className="mono" data-testid="elapsed">
            {elapsed}
          </dd>
        </dl>
        {snapshot?.pauseRequested && <p className="hint warn">PAUSE REQUESTED — Core sẽ dừng ở safe boundary kế tiếp.</p>}
        {status?.status === 'RUNNING' && !snapshot?.runAttached && (
          <p className="hint">Run này do tiến trình khác quản lý (CLI hoặc phiên app trước) — trạng thái cập nhật theo chu kỳ, không có live event.</p>
        )}
      </Card>

      <Card title="Iteration" className="run-iteration">
        <div className="iteration" data-testid="iteration">
          <span className="iteration-now">{status?.iteration ?? 0}</span>
          <span className="iteration-sep">/</span>
          <span className="iteration-max">{status?.maxIterations ?? '—'}</span>
        </div>
        <p className="hint">Giới hạn vòng lặp do Core áp dụng cho run này.</p>
      </Card>

      <Card title="Agents" className="run-agents">
        <div className="agent-row" data-testid="agent-claude">
          <span className="agent-name">Claude</span>
          <Pill value={status?.activity.claude ?? 'IDLE'} />
          <span className="agent-meta mono">{status?.activity.claude === 'EXECUTING' && status.claude.pid ? `pid ${status.claude.pid}` : ''}</span>
        </div>
        <div className="agent-row" data-testid="agent-codex">
          <span className="agent-name">ChatGPT (Codex)</span>
          <Pill value={status?.activity.codex ?? 'IDLE'} />
          <span className="agent-meta mono">{status?.activity.codex === 'REVIEWING' && status.codex.pid ? `pid ${status.codex.pid}` : ''}</span>
        </div>
      </Card>
    </div>
  );
}
