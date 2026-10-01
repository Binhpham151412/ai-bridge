import { useCallback, useEffect, useState } from 'react';
import type { AiBridgeApi } from '../../preload/bridge-api.ts';
import type { ActionResponse, DataResponse, UiError, WorkflowEvent, WorkflowListItem, WorkflowPanelSnapshot, WorkflowSnapshot } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { formatDateTime } from '../lib/format.ts';
import { UNKNOWN, orUnknown, stateLabel, terminalReasonLabel } from '../lib/workflow-summary.ts';
import { EmptyState, ErrorPanel } from './common.tsx';
import { StartWorkflowDialog } from './StartWorkflowDialog.tsx';
import { StatePill, WorkflowDetail } from './WorkflowDetail.tsx';

/** A rejected IPC promise (Main unreachable): a stable category, never a stack trace. */
export const IPC_FAILED: UiError = {
  code: 'IPC_FAILED',
  title: 'Không liên lạc được với Electron Main',
  message: 'Yêu cầu IPC không nhận được phản hồi. Thử lại; nếu vẫn lỗi, khởi động lại ứng dụng.',
};

/** Live events kept in memory for the timeline of an attached workflow (older ones are read by seq). */
const MAX_PUSHED_EVENTS = 200;

/**
 * The workflow push channels (workflow:snapshot / workflow:event), subscribed while this view is
 * mounted — the BridgeProvider pattern: subscribe on mount, unsubscribe on unmount, so a remount
 * never leaves a second listener. The snapshot is Main's; nothing here polls files or Core.
 */
function useWorkflowPanel(api: AiBridgeApi) {
  const [panel, setPanel] = useState<WorkflowPanelSnapshot | null>(null);
  const [loadError, setLoadError] = useState<UiError | null>(null);
  const [pushed, setPushed] = useState<WorkflowEvent[]>([]);
  useEffect(() => {
    let active = true;
    const offSnapshot = api.onWorkflowSnapshot((next) => {
      if (active) setPanel(next);
    });
    const offEvent = api.onWorkflowEvent((event) => {
      if (active) setPushed((prev) => [...prev, event].slice(-MAX_PUSHED_EVENTS));
    });
    api.workflowGetSnapshot().then(
      (res) => {
        if (!active) return;
        if (res.ok && res.data) setPanel(res.data);
        else if (!res.ok) setLoadError(res.error);
      },
      () => active && setLoadError(IPC_FAILED),
    );
    return () => {
      active = false;
      offSnapshot();
      offEvent();
    };
  }, [api]);
  return { panel, loadError, pushed };
}

/** Reloads `load()` whenever `key` changes; stale results for an older key are dropped. */
function useReload<T>(key: string | null, load: () => Promise<DataResponse<T>>): { data: T | null; error: UiError | null; loadedFor: string | null } {
  const [state, setState] = useState<{ data: T | null; error: UiError | null; loadedFor: string | null }>({ data: null, error: null, loadedFor: null });
  useEffect(() => {
    if (key === null) return;
    let active = true;
    load().then(
      (res) => active && setState(res.ok ? { data: res.data, error: null, loadedFor: key } : { data: null, error: res.error, loadedFor: key }),
      () => active && setState({ data: null, error: IPC_FAILED, loadedFor: key }),
    );
    return () => {
      active = false;
    };
    // `load` wraps a stable api method; `key` drives reloads.
  }, [key]);
  return state;
}

export type WorkflowAct = (action: () => Promise<ActionResponse | DataResponse<unknown>>) => Promise<boolean>;

function WorkflowList({ items, selectedId, onSelect }: { items: WorkflowListItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <nav className="workflow-list" aria-label="Danh sách workflow" data-testid="wf-list">
      <ul>
        {[...items].reverse().map((w) => {
          const selected = w.workflowId === selectedId;
          return (
            <li key={w.workflowId}>
              <button
                type="button"
                className={`workflow-item ${selected ? 'active' : ''}`}
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(w.workflowId)}
                data-testid="wf-item"
                data-workflow-id={w.workflowId}
              >
                <span className="workflow-item-head">
                  <span className="mono workflow-item-id">{w.workflowId}</span>
                  <StatePill state={w.displayState} testId="wf-item-state" />
                </span>
                <span className="workflow-item-line">{w.definitionId ? `${w.definitionId} v${w.version}` : UNKNOWN}</span>
                <span className="workflow-item-line small" data-testid="wf-item-step">
                  Step: {w.currentStep ? `${w.currentStep.stepId} · ${stateLabel(w.currentStep.state)}` : UNKNOWN} · Attempt: {w.currentAttempt ? stateLabel(w.currentAttempt.state) : UNKNOWN}
                </span>
                <span className="workflow-item-line small">
                  Tạo {formatDateTime(w.createdAt)} · Cập nhật {formatDateTime(w.updatedAt)}
                </span>
                {w.terminalReason && <span className="workflow-item-line small">{terminalReasonLabel(w.terminalReason)}</span>}
                {w.integrity !== 'OK' && (
                  <span className="badge badge-warn" data-testid="wf-item-integrity">
                    {w.integrity}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * WORKFLOWS (M5.9, docs/35 §3.4): the project's workflow instances and one instance in detail.
 * A pure consumer: every state, control and evidence level shown comes from Main's snapshots
 * (Core-derived); every action is a request to Main, which re-checks it against Core.
 */
export function WorkflowView() {
  const { api } = useBridge();
  const { panel, loadError, pushed } = useWorkflowPanel(api);
  const [picked, setPicked] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info'; text: string } | { kind: 'error'; error: UiError } | null>(null);
  const [nonce, setNonce] = useState(0);

  const projectPath = panel?.project?.path ?? null;
  const w = panel?.workflow ?? null;
  // Main pushes a new snapshot whenever the followed workflow or the project's activity changes;
  // the list and a non-followed detail are re-read on exactly those changes (no renderer polling).
  const changeKey = panel ? `${projectPath}|${w?.workflowId}|${w?.state}|${w?.displayState}|${w?.lastEventSeq}|${panel.activity.hostedWorkflowId}|${panel.activity.running.join(',')}|${panel.pendingAction}|${panel.attached}|${nonce}` : null;
  const list = useReload(projectPath ? changeKey : null, () => api.workflowList());
  const items = list.data ?? null;

  const selectedId = picked ?? w?.workflowId ?? items?.at(-1)?.workflowId ?? null;
  const followed = w && w.workflowId === selectedId ? w : null;
  const other = useReload(selectedId && !followed ? `${selectedId}|${changeKey}` : null, () => api.workflowGet({ workflowId: selectedId! }));
  const detail: WorkflowSnapshot | null = followed ?? (other.loadedFor?.startsWith(`${selectedId}|`) ? other.data : null);
  const detailError = followed ? null : other.loadedFor?.startsWith(`${selectedId}|`) ? other.error : null;

  const act: WorkflowAct = useCallback(async (action) => {
    try {
      const res = await action();
      if (res.ok) setNotice('message' in res && res.message ? { kind: 'info', text: res.message } : null);
      else setNotice({ kind: 'error', error: res.error });
      setNonce((n) => n + 1);
      return res.ok;
    } catch {
      setNotice({ kind: 'error', error: IPC_FAILED });
      return false;
    }
  }, []);

  if (!panel) return loadError ? <ErrorPanel error={loadError} /> : <p className="hint">Đang tải…</p>;
  if (!panel.project) return <EmptyState title="Chưa chọn project" />;

  return (
    <div className="page workflow-page" data-testid="workflow-view">
      <header className="page-head">
        <div>
          <h1>Workflows</h1>
          <p className="page-sub">Các step chạy tuần tự; mỗi step là một run Claude ⇄ ChatGPT. M5: OutcomeOnly — kết quả tốt nhất là AI_ATTESTED.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!panel.canStartNew}
          onClick={() => setStarting(true)}
          title={panel.startBlockedBy ? `${panel.startBlockedBy.title}: ${panel.startBlockedBy.message}` : undefined}
          data-testid="wf-start"
        >
          {panel.pendingAction === 'start' ? 'STARTING…' : 'Start workflow…'}
        </button>
      </header>

      {notice?.kind === 'error' && <ErrorPanel error={notice.error} onDismiss={() => setNotice(null)} />}
      {notice?.kind === 'info' && (
        <div className="notice" role="status">
          {notice.text}
          <button type="button" className="btn btn-link" onClick={() => setNotice(null)}>
            Đóng
          </button>
        </div>
      )}
      {panel.lastError && <ErrorPanel error={panel.lastError} />}
      {panel.startBlockedBy && (
        <p className="hint" data-testid="wf-start-blocked">
          Không thể bắt đầu workflow mới — {panel.startBlockedBy.title}: {panel.startBlockedBy.message}
        </p>
      )}

      {list.error && <ErrorPanel error={list.error} />}
      {!items && !list.error && <p className="hint">Đang tải danh sách workflow…</p>}
      {items && items.length === 0 && (
        <EmptyState title="Project chưa có workflow nào">
          Đặt definition trong <span className="mono">.ai-bridge/workflows/definitions/</span> rồi chọn “Start workflow…”.
        </EmptyState>
      )}
      {items && items.length > 0 && (
        <div className="workflow-layout">
          <WorkflowList items={items} selectedId={selectedId} onSelect={setPicked} />
          <div className="workflow-main">
            {detailError && <ErrorPanel error={detailError} />}
            {!detail && !detailError && <p className="hint">Đang tải workflow {orUnknown(selectedId)}…</p>}
            {detail && <WorkflowDetail key={detail.workflowId} snapshot={detail} pendingAction={panel.pendingAction} attached={followed !== null && panel.attached} pushed={pushed} act={act} />}
          </div>
        </div>
      )}

      {starting && (
        <StartWorkflowDialog
          canStart={panel.canStartNew}
          onClose={() => setStarting(false)}
          onStarted={(id) => {
            setPicked(id);
            setStarting(false);
            setNotice({ kind: 'info', text: `Đã bắt đầu workflow ${id}.` });
            setNonce((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
