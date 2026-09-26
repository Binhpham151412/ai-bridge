import { useEffect, useState, type FormEvent } from 'react';
import type { SettingsView } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { formatBytes } from '../lib/format.ts';
import { Card, EmptyState } from './common.tsx';

type NumberField = 'maxIterations' | 'claudeTimeoutMs' | 'codexTimeoutMs' | 'reportMaxBytes';
const NUMBER_FIELDS: { key: NumberField; label: string; hint: string }[] = [
  { key: 'maxIterations', label: 'Max iterations mặc định', hint: '1 – 1000' },
  { key: 'claudeTimeoutMs', label: 'Claude timeout (ms)', hint: 'mặc định 1 800 000 = 30 phút' },
  { key: 'codexTimeoutMs', label: 'Codex timeout (ms)', hint: 'mặc định 600 000 = 10 phút' },
  { key: 'reportMaxBytes', label: 'Report tối đa (bytes)', hint: 'mặc định 1 048 576' },
];
const BOOLEAN_FIELDS = [
  { key: 'stopOnUncommittedChanges', label: 'Chặn run khi có thay đổi chưa commit' },
  { key: 'requireGitRepository', label: 'Bắt buộc project là git repository' },
] as const;

/**
 * Settings (M4 §15): only what Core already supports — the project's
 * `.ai-bridge/config.json` fields (validated and written by Core), plus the app's
 * default project. No API keys, credentials or passwords are ever asked for or stored.
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
    <div className="settings">
      <Card title="Project mặc định">
        <p className="mono small">{view?.app.defaultProjectPath ?? 'Chưa đặt'}</p>
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

      <Card title="Cấu hình project (.ai-bridge/config.json)">
        {!project && <EmptyState title="Chưa chọn project" />}
        {project && (
          <form onSubmit={(e) => void save(e)} className="config-form">
            <p className="mono small">
              {project.path}
              {project.exists ? '' : ' (chưa có file — đang dùng mặc định của Core)'}
            </p>
            {project.errors.length > 0 && <p className="warn">File hiện tại không hợp lệ: {project.errors.join('; ')}</p>}
            <div className="field-grid">
              {NUMBER_FIELDS.map((f) => (
                <label key={f.key} className="field">
                  <span>{f.label}</span>
                  <input type="number" value={String(draft[f.key] ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
                  <small className="hint">{f.hint}</small>
                </label>
              ))}
            </div>
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

      <Card title="Logs">
        <p>
          Core ghi <span className="mono">.ai-bridge/logs/events.jsonl</span> và <span className="mono">ai-bridge.log</span> trong project, tự xoay vòng khi vượt {formatBytes(view?.logs.maxFileBytes ?? 0)}. Không
          cấu hình được (quy tắc của Core).
        </p>
      </Card>

      <Card title="Bảo mật & chi phí">
        <p>
          AI Bridge dùng Claude CLI và Codex CLI với đăng nhập sẵn có của bạn. Ứng dụng không hỏi, không lưu API key, token, mật khẩu hay credential nào, và không gửi dữ liệu ra ngoài (không
          telemetry). Chi phí bổ sung: $0.
        </p>
      </Card>
    </div>
  );
}
