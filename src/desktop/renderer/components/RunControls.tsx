import { useBridge } from '../state/BridgeProvider.tsx';

/**
 * START / PAUSE / RESUME / STOP. Enabled state comes verbatim from `snapshot.controls`
 * (derived in Main from Core's status + recovery check); the renderer adds nothing.
 */
export function RunControls({ onStart }: { onStart: () => void }) {
  const { api, snapshot, runAction } = useBridge();
  const controls = snapshot?.controls ?? { canStart: false, canPause: false, canResume: false, stopMode: null };
  const pending = snapshot?.pendingAction ?? null;

  const onStop = () => {
    if (controls.stopMode === 'DISCARD') {
      if (window.confirm('Kết thúc session đang tạm dừng/gián đoạn? Session sẽ không thể RESUME nữa (artifact vẫn được giữ).')) void runAction(() => api.discard());
      return;
    }
    if (window.confirm('STOP run? Core sẽ dừng Claude/Codex và toàn bộ process tree. Muốn tiếp tục sau, hãy dùng PAUSE.')) void runAction(() => api.stop());
  };

  return (
    <div className="controls" role="toolbar" aria-label="Run controls">
      <button type="button" className="btn btn-primary" disabled={!controls.canStart} onClick={onStart} data-testid="btn-start">
        {pending === 'start' ? 'STARTING…' : 'START'}
      </button>
      <button type="button" className="btn" disabled={!controls.canPause} onClick={() => void runAction(() => api.pause())} data-testid="btn-pause">
        {pending === 'pause' || snapshot?.pauseRequested ? 'PAUSING…' : 'PAUSE'}
      </button>
      <button type="button" className="btn" disabled={!controls.canResume} onClick={() => void runAction(() => api.resume())} data-testid="btn-resume">
        {pending === 'resume' ? 'RESUMING…' : 'RESUME'}
      </button>
      <button
        type="button"
        className="btn btn-danger"
        disabled={controls.stopMode === null}
        onClick={onStop}
        data-testid="btn-stop"
        title={controls.stopMode === 'DISCARD' ? 'Kết thúc session (không resume)' : 'Dừng run qua Core'}
      >
        {pending === 'stop' ? 'STOPPING…' : 'STOP'}
      </button>
    </div>
  );
}
