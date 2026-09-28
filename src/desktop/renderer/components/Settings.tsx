import { useEffect, useState, type FormEvent } from 'react';
import type { SettingsView } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { Card, EmptyState } from './common.tsx';

type NumberField = 'maxIterations' | 'claudeTimeoutMs' | 'codexTimeoutMs' | 'reportMaxBytes';
const NUMBER_FIELDS: { key: NumberField; label: string; hint: string; minutes?: boolean }[] = [
  { key: 'maxIterations', label: 'Default maximum review rounds', hint: '1 – 1000 · có thể đổi cho từng run khi START' },
  { key: 'claudeTimeoutMs', label: 'Claude timeout (ms)', hint: 'mặc định 1 800 000 = 30 phút', minutes: true },
  { key: 'codexTimeoutMs', label: 'Codex timeout (ms)', hint: 'mặc định 600 000 = 10 phút', minutes: true },
  { key: 'reportMaxBytes', label: 'Report tối đa (bytes)', hint: 'mặc định 1 048 576' },
];
const BOOLEAN_FIELDS = [
  { key: 'stopOnUncommittedChanges', label: 'Chặn run khi có thay đổi chưa commit' },
  { key: 'requireGitRepository', label: 'Bắt buộc project là git repository' },
] as const;

/** "= 30 phút" next to a millisecond field, computed from what is typed (display only). */
function minutesOf(value: string | boolean | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `= ${Math.round((n / 60000) * 10) / 10} phút` : null;
}

/**
 * Settings (M4 §15): only what Core already supports — the project's
 * `.ai-bridge/config.json` fields (validated and written by Core), plus the app's
 * default project. No API keys, credentials or passwords are ever asked for or stored.
 * Diagnostics, logs and the security model live under SYSTEM.
 */
export function Settings() {
  const { api, snapshot, runAction } = useBridge();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [reload, setReload] = useState(0);
  const projectPath = snapshot?.project?.path ?? null;

  useEffect(() => {
    let active = true;
    void api.getSettings().then((res) => {
      if (!active || !res.ok) return;
      setView(res.data);
      const cfg = res.data.project?.config;
      if (cfg) setDraft(Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v)])));
    });
    return () => {
      active = false;
    };
  }, [api, projectPath, reload]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    // Numbers are sent as typed; Core's validateConfig decides what is valid.
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) config[k] = typeof v === 'boolean' ? v : v.trim() === '' ? v : Number(v);
    const res = await runAction(() => api.saveProjectConfig({ config }));
    if (res.ok) setReload((n) => n + 1);
  };

  const setDefault = (clear: boolean) => {
    void runAction(() => api.setDefaultProject({ clear })).then(() => setReload((n) => n + 1));
  };

  const project = view?.project ?? null;
  const running = snapshot?.status?.status === 'RUNNING';

  return (
    <div className="page settings">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="page-sub">Project, review rounds and run configuration.</p>
        </div>
      </header>

      <Card title="Project">
        <dl className="kv">
          <dt>Open project</dt>
          <dd className="mono small">{projectPath ?? 'Chưa chọn'}</dd>
          <dt>Default project</dt>
          <dd className="mono small">{view?.app.defaultProjectPath ?? 'Chưa đặt'}</dd>
        </dl>
        <div className="row-actions">
          <button type="button" className="btn" disabled={!projectPath} onClick={() => setDefault(false)}>
            Đặt project hiện tại làm mặc định
          </button>
          <button type="button" className="btn" disabled={!view?.app.defaultProjectPath} onClick={() => setDefault(true)}>
            Bỏ mặc định
          </button>
        </div>
        <p className="hint">Khi mở app, project mặc định được mở và Core kiểm tra session dở dang (recovery).</p>
      </Card>

      <Card title="Run configuration (.ai-bridge/config.json)">
        {!project && <EmptyState title="Chưa chọn project" />}
        {project && (
          <form onSubmit={(e) => void save(e)} className="config-form">
            <p className="mono small">
              {project.path}
              {project.exists ? '' : ' (chưa có file — đang dùng mặc định của Core)'}
            </p>
            {project.errors.length > 0 && <p className="warn">File hiện tại không hợp lệ: {project.errors.join('; ')}</p>}
            <h3 className="form-section">Review rounds &amp; timeouts</h3>
            <div className="field-grid">
              {NUMBER_FIELDS.map((f) => (
                <label key={f.key} className="field">
                  <span>{f.label}</span>
                  <input type="number" value={String(draft[f.key] ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
                  <small className="hint">
                    {f.hint}
                    {f.minutes && minutesOf(draft[f.key]) ? ` · hiện tại ${minutesOf(draft[f.key])}` : ''}
                  </small>
                </label>
              ))}
            </div>
            <h3 className="form-section">Safety checks before each run</h3>
            {BOOLEAN_FIELDS.map((f) => (
              <label key={f.key} className="check">
                <input type="checkbox" checked={draft[f.key] === true} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked }))} />
                {f.label}
              </label>
            ))}
            <div className="row-actions">
              <button type="submit" className="btn btn-primary" disabled={running}>
                Lưu cấu hình
              </button>
              {running && <span className="hint">Không thể lưu khi run đang chạy.</span>}
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
