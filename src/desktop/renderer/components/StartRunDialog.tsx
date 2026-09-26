import { useEffect, useState, type FormEvent } from 'react';
import type { AiBridgeConfig } from '../../../core/config/config.ts';
import { MAX_ITERATIONS_LIMIT, MAX_TASK_LENGTH } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';

/**
 * Start Run (M4 §13): the project (read-only, chosen via the native picker), the task,
 * and max iterations — the only per-run options Core's `start()` accepts. Timeouts are
 * Core config (`.ai-bridge/config.json`), shown read-only here and edited in Settings.
 */
export function StartRunDialog({ onClose }: { onClose: () => void }) {
  const { api, snapshot, runAction } = useBridge();
  const [task, setTask] = useState('');
  const [maxIterations, setMaxIterations] = useState('');
  const [config, setConfig] = useState<AiBridgeConfig | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void api.getSettings().then((res) => {
      if (active && res.ok && res.data.project) {
        setConfig(res.data.project.config);
        setMaxIterations(String(res.data.project.config.maxIterations));
      }
    });
    return () => {
      active = false;
    };
  }, [api]);

  const parsedMax = Number(maxIterations);
  const maxValid = maxIterations === '' || (Number.isInteger(parsedMax) && parsedMax >= 1 && parsedMax <= MAX_ITERATIONS_LIMIT);
  const canSubmit = task.trim() !== '' && maxValid && !submitting && snapshot?.controls.canStart === true;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    const res = await runAction(() => api.start(maxIterations === '' ? { task } : { task, maxIterations: parsedMax }));
    setSubmitting(false);
    if (res.ok) onClose();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="start-title">
      <form className="modal" onSubmit={(e) => void submit(e)}>
        <h2 id="start-title">Start run</h2>
        <label className="field">
          <span>Project directory</span>
          <input type="text" value={snapshot?.project?.path ?? ''} readOnly />
        </label>
        <label className="field">
          <span>Task cho Claude (iteration 1)</span>
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={7} maxLength={MAX_TASK_LENGTH} placeholder="Mô tả việc Claude cần làm…" autoFocus data-testid="start-task" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Max iterations</span>
            <input type="number" min={1} max={MAX_ITERATIONS_LIMIT} value={maxIterations} onChange={(e) => setMaxIterations(e.target.value)} data-testid="start-max" />
            {!maxValid && <small className="warn">1 – {MAX_ITERATIONS_LIMIT}</small>}
          </label>
          <label className="field">
            <span>Claude timeout</span>
            <input type="text" value={config ? `${Math.round(config.claudeTimeoutMs / 60000)} phút` : '—'} readOnly />
          </label>
          <label className="field">
            <span>Codex timeout</span>
            <input type="text" value={config ? `${Math.round(config.codexTimeoutMs / 60000)} phút` : '—'} readOnly />
          </label>
        </div>
        <p className="hint">Timeout là cấu hình Core của project (Settings). Core chạy System Check trước khi bắt đầu và từ chối nếu chưa PASS.</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Hủy
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit} data-testid="start-submit">
            {submitting ? 'Đang kiểm tra & bắt đầu…' : 'START'}
          </button>
        </div>
      </form>
    </div>
  );
}
