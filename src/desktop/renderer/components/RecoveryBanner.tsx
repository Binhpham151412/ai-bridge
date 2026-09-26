import { useBridge } from '../state/BridgeProvider.tsx';

/**
 * Shown after a crash/restart or a pause (M4 §17): exactly Core's `checkRecovery()`
 * answer. RESUME is only offered when Core said RECOVERABLE; a BLOCKED session shows
 * Core's reason and can only be discarded. Nothing ever resumes automatically.
 */
export function RecoveryBanner() {
  const { api, snapshot, runAction } = useBridge();
  const recovery = snapshot?.recovery;
  if (!recovery || (recovery.kind !== 'RECOVERABLE' && recovery.kind !== 'BLOCKED')) return null;
  const busy = snapshot?.pendingAction !== null;

  const discard = () => {
    if (window.confirm('Bỏ session này? Nó sẽ không thể RESUME nữa (artifact vẫn được giữ).')) void runAction(() => api.discard());
  };

  if (recovery.kind === 'RECOVERABLE') {
    return (
      <div className="banner banner-recover" data-testid="recovery-banner">
        <div>
          <strong>Có session chưa hoàn tất.</strong>
          <dl className="kv kv-inline">
            <dt>Session</dt>
            <dd className="mono">{recovery.runId}</dd>
            <dt>Iteration</dt>
            <dd>{recovery.iteration}</dd>
            <dt>Status</dt>
            <dd>RECOVERABLE ({recovery.status})</dd>
          </dl>
        </div>
        <div className="banner-actions">
          <button type="button" className="btn btn-primary" disabled={busy || !snapshot?.controls.canResume} onClick={() => void runAction(() => api.resume())} data-testid="banner-resume">
            RESUME
          </button>
          <button type="button" className="btn" disabled={busy} onClick={discard} data-testid="banner-discard">
            DISCARD
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="banner banner-blocked" data-testid="recovery-banner">
      <div>
        <strong>RECOVERY BLOCKED</strong>
        <dl className="kv kv-inline">
          <dt>Session</dt>
          <dd className="mono">{recovery.runId}</dd>
          <dt>Iteration</dt>
          <dd>{recovery.iteration}</dd>
          <dt>Status</dt>
          <dd>{recovery.status}</dd>
        </dl>
        <p className="banner-reason">{recovery.reason}</p>
      </div>
      <div className="banner-actions">
        <button type="button" className="btn" disabled={busy} onClick={discard} data-testid="banner-discard">
          DISCARD
        </button>
      </div>
    </div>
  );
}
