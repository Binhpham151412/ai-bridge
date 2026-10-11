import { useCallback, useEffect, useState } from 'react';
import type { ActionResponse, ProjectHistoryView } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { formatDateTime } from '../lib/format.ts';

/**
 * docs/63 — "Dự án gần đây": the app's recent-project history, kept by Electron Main in the
 * app's own settings (never in a project). Rows are addressed by an opaque id; Main resolves
 * the path, validates it, and owns the folder picker ("Tìm lại…"). Removing an entry only
 * removes it from this list — the project folder is never touched.
 */
export function RecentProjects({ title = 'Dự án gần đây' }: { title?: string }) {
  const { api, snapshot, runAction } = useBridge();
  const [view, setView] = useState<ProjectHistoryView | null>(null);
  const [reload, setReload] = useState(0);
  const activePath = snapshot?.project?.path ?? null;
  const busy = Boolean(snapshot?.runAttached || snapshot?.status?.status === 'RUNNING' || snapshot?.pendingAction);

  useEffect(() => {
    let active = true;
    void api.getProjectHistory().then((res) => {
      if (active && res.ok) setView(res.data);
    });
    return () => {
      active = false;
    };
  }, [api, activePath, reload]);

  const act = useCallback(
    (action: () => Promise<ActionResponse>) => {
      void runAction(action).then(() => setReload((n) => n + 1));
    },
    [runAction],
  );

  if (!view) return null;
  const missingRestore = view.restore.outcome === 'MISSING' && activePath === null;

  return (
    <section className="recent-projects" aria-label={title} data-testid="recent-projects">
      <h3 className="form-section">{title}</h3>
      {missingRestore && (
        <p className="warn" role="status" data-testid="recent-restore-missing">
          Không mở lại được project gần nhất{view.restore.name ? ` "${view.restore.name}"` : ''}: {view.restore.reason ?? 'thư mục không còn'} — chọn một project khác hoặc "Tìm lại…".
        </p>
      )}
      {view.entries.length === 0 ? (
        <p className="hint" data-testid="recent-empty">
          Chưa có project nào trong lịch sử. Chọn một thư mục project — lần sau AI Bridge sẽ tự mở lại.
        </p>
      ) : (
        <ul className="recent-list">
          {view.entries.map((e) => (
            <li key={e.id} className={`recent-item${e.status === 'MISSING' ? ' recent-missing' : ''}${e.active ? ' recent-active' : ''}`} data-testid="recent-item">
              <div className="recent-main">
                <strong>{e.name}</strong>
                {e.pinned && <span className="badge">Đã ghim</span>}
                {e.active && <span className="badge badge-ok">Đang mở</span>}
                {e.status === 'MISSING' && (
                  <span className="badge badge-warn" data-testid="recent-status-missing">
                    Status: Missing
                  </span>
                )}
                <div className="mono small recent-path">{e.path}</div>
                <div className="hint small">Mở lần cuối: {formatDateTime(e.lastOpenedAt)}</div>
              </div>
              <div className="row-actions">
                {e.status === 'MISSING' ? (
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(() => api.locateProject({ id: e.id }))} data-testid="recent-locate">
                    Tìm lại…
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    disabled={busy || e.active}
                    title={busy ? 'Không đổi project khi run đang chạy' : undefined}
                    onClick={() => act(() => api.openRecentProject({ id: e.id }))}
                    data-testid="recent-open"
                  >
                    Mở
                  </button>
                )}
                <button type="button" className="btn btn-small" onClick={() => act(() => api.setProjectPinned({ id: e.id, pinned: !e.pinned }))} data-testid="recent-pin">
                  {e.pinned ? 'Bỏ ghim' : 'Ghim'}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    if (window.confirm(`Xoá "${e.name}" khỏi lịch sử AI Bridge?\n\nChỉ xoá khỏi danh sách này — thư mục project KHÔNG bị xoá.`)) act(() => api.removeRecentProject({ id: e.id }));
                  }}
                  data-testid="recent-remove"
                >
                  Xoá khỏi lịch sử
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
