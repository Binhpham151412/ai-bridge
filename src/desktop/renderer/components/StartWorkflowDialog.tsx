import { useEffect, useState, type FormEvent } from 'react';
import type { UiError, WorkflowDefinitionSummary } from '../../shared/ipc-contract.ts';
import { MAX_WORKFLOW_INPUT_LENGTH } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { ErrorPanel } from './common.tsx';

/**
 * Start workflow (M5.9): pick one of the project's definitions (read by Main from
 * .ai-bridge/workflows/definitions/), fill its declared inputs, and ask Main to start it. The
 * definition hash shown is the one sent back, so a definition edited meanwhile is refused
 * (DEFINITION_CHANGED). Main validates the inputs against the definition; the renderer only
 * mirrors the declared limits as input hints.
 */
export function StartWorkflowDialog({ canStart, onClose, onStarted }: { canStart: boolean; onClose: () => void; onStarted: (workflowId: string) => void }) {
  const { api } = useBridge();
  const [defs, setDefs] = useState<WorkflowDefinitionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<UiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    api.workflowListDefinitions().then(
      (res) => {
        if (!active) return;
        if (!res.ok) return setLoadError(res.error);
        setDefs(res.data);
        setChosen(res.data.find((d) => d.valid)?.definitionId ?? '');
      },
      () => active && setLoadError({ code: 'IPC_FAILED', title: 'Không liên lạc được với Electron Main', message: 'Không đọc được danh sách definition.' }),
    );
    return () => {
      active = false;
    };
  }, [api]);

  const def = defs?.find((d) => d.definitionId === chosen && d.valid) ?? null;
  const canSubmit = def !== null && def.definitionHash !== null && canStart && !submitting;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !def?.definitionHash) return;
    setSubmitting(true);
    setError(null);
    try {
      const values = Object.fromEntries(def.inputs.filter((i) => inputs[i.name] !== undefined && inputs[i.name] !== '').map((i) => [i.name, inputs[i.name]]));
      const res = await api.workflowStart({ definitionId: def.definitionId, definitionHash: def.definitionHash, inputs: values });
      if (res.ok) onStarted(res.data.workflowId);
      else setError(res.error);
    } catch {
      setError({ code: 'IPC_FAILED', title: 'Không liên lạc được với Electron Main', message: 'Yêu cầu start không nhận được phản hồi.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="wf-start-title">
      <form className="modal" onSubmit={(e) => void submit(e)} data-testid="wf-start-dialog">
        <h2 id="wf-start-title">Start workflow</h2>
        {loadError && <ErrorPanel error={loadError} />}
        {error && <ErrorPanel error={error} />}
        {defs && defs.length === 0 && <p className="hint">Chưa có definition nào trong .ai-bridge/workflows/definitions/.</p>}
        {defs && defs.length > 0 && (
          <label className="field">
            <span>Definition</span>
            <select value={chosen} onChange={(e) => setChosen(e.target.value)} data-testid="wf-start-definition" autoFocus>
              {defs.map((d) => (
                <option key={d.definitionId} value={d.definitionId} disabled={!d.valid}>
                  {d.valid ? `${d.title} — ${d.definitionId} v${d.version} · ${d.steps.length} step` : `${d.definitionId} — không hợp lệ`}
                </option>
              ))}
            </select>
          </label>
        )}
        {defs?.filter((d) => !d.valid).map((d) => (
          <p key={d.definitionId} className="hint small" data-testid="wf-start-invalid">
            {d.definitionId}: {d.errors.join(' · ')}
          </p>
        ))}
        {def && (
          <>
            <p className="hint small mono" data-testid="wf-start-hash">
              hash {def.definitionHash}
            </p>
            <p className="hint small">Steps: {def.steps.map((s) => s.stepId).join(' → ')} · Verification: OutcomeOnly (AI_ATTESTED)</p>
            {def.inputs.map((i) => (
              <label key={i.name} className="field">
                <span>
                  {i.name}
                  {i.required ? ' *' : ''}
                </span>
                <textarea
                  rows={2}
                  maxLength={Math.min(i.maxLength, MAX_WORKFLOW_INPUT_LENGTH)}
                  value={inputs[i.name] ?? ''}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [i.name]: e.target.value }))}
                  data-testid={`wf-start-input-${i.name}`}
                />
              </label>
            ))}
          </>
        )}
        {!canStart && <p className="hint">Không thể bắt đầu workflow mới lúc này (xem thông báo trên màn hình Workflows).</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Hủy
          </button>
          <button type="submit" className="btn btn-primary" disabled={!canSubmit} data-testid="wf-start-submit">
            {submitting ? 'STARTING…' : 'START'}
          </button>
        </div>
      </form>
    </div>
  );
}
