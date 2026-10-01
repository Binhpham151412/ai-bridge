import { useEffect, useRef, useState } from 'react';
import type { UiError, WorkflowEvent, WorkflowSnapshot } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { Markdown } from '../lib/Markdown.tsx';
import { formatDateTime } from '../lib/format.ts';
import { UNKNOWN, evidenceText, orUnknown, summarizeEvent, verificationModeText } from '../lib/workflow-summary.ts';
import { EmptyState, ErrorPanel } from './common.tsx';

const IPC_FAILED: UiError = { code: 'IPC_FAILED', title: 'Không liên lạc được với Electron Main', message: 'Yêu cầu IPC không nhận được phản hồi.' };

/** Events are read a page at a time (workflow:getEvents caps a read at 1000; the UI asks for less). */
export const TIMELINE_PAGE = 200;

/**
 * The persisted event log of one workflow, read-only, in seq order. Loaded on demand (this tab),
 * one page at a time; newer events arrive through Main's push (workflow:event, for the workflow
 * this app hosts) or are read by seq when Main's snapshot reports a higher lastEventSeq — never by
 * polling. Recovery events stay visibly distinct from ordinary progress.
 */
export function WorkflowTimeline({ workflowId, lastEventSeq, pushed }: { workflowId: string; lastEventSeq: number; pushed: WorkflowEvent[] }) {
  const { api } = useBridge();
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(false);

  const merge = (incoming: readonly WorkflowEvent[]) =>
    setEvents((prev) => {
      const bySeq = new Map(prev.map((e) => [e.seq, e]));
      for (const e of incoming) if (e.workflowId === workflowId) bySeq.set(e.seq, e);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    });

  const load = async (afterSeq: number) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await api.workflowGetEvents({ workflowId, afterSeq, limit: TIMELINE_PAGE });
      if (res.ok) {
        merge(res.data);
        setComplete(res.data.length < TIMELINE_PAGE);
        setError(null);
      } else setError(res.error);
    } catch {
      setError(IPC_FAILED);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const maxSeq = events.at(-1)?.seq ?? 0;

  useEffect(() => {
    void load(0);
    // One timeline per workflow (the parent keys the detail by workflowId).
  }, [workflowId]);

  // Main's snapshot says the log grew: read what is new (only once the loaded pages reached the end).
  useEffect(() => {
    if (complete && lastEventSeq > maxSeq) void load(maxSeq);
  }, [lastEventSeq, complete]);

  // Live events of the workflow this app hosts: appended when they continue what is loaded.
  useEffect(() => {
    if (complete) merge(pushed.filter((e) => e.seq > maxSeq));
  }, [pushed, complete]);

  if (error && events.length === 0) return <ErrorPanel error={error} />;
  if (loading && events.length === 0) return <p className="hint">Đang tải event timeline…</p>;
  if (events.length === 0) return <EmptyState title="Chưa có event nào" />;

  return (
    <div className="wf-timeline" data-testid="wf-timeline">
      {error && <ErrorPanel error={error} />}
      <ol className="wf-events" aria-label="Workflow events, in sequence order">
        {events.map((e) => {
          const recovery = e.type === 'RECONCILED';
          return (
            <li key={e.seq} className={`wf-event ${recovery ? 'wf-recovery-row' : ''}`} data-testid="wf-event" data-seq={e.seq} data-type={e.type}>
              <span className="mono wf-event-seq" aria-label={`seq ${e.seq}`}>
                {e.seq}
              </span>
              <div className="wf-event-body">
                <div className="wf-event-head">
                  <span className="mono wf-event-type" data-testid="wf-event-type">
                    {e.type}
                    {recovery && <span className="badge badge-warn">recovery</span>}
                  </span>
                  <span className="mono small wf-event-time" data-testid="wf-event-time">
                    {formatDateTime(e.timestamp)}
                  </span>
                </div>
                <div className="mono small wf-event-scope">
                  step <span data-testid="wf-event-step">{orUnknown(e.stepId)}</span> · attempt <span data-testid="wf-event-attempt">{orUnknown(e.attemptId)}</span> · execution{' '}
                  <span data-testid="wf-event-execution">{orUnknown(e.executionId)}</span> · provider <span data-testid="wf-event-provider">{orUnknown(e.provider)}</span>
                </div>
                <div className="small wf-event-summary" data-testid="wf-event-summary">
                  {summarizeEvent(e)}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="hint small">
        {events.length} event · seq 1–{maxSeq}
        {!complete && (
          <button type="button" className="btn btn-link" disabled={loading} onClick={() => void load(maxSeq)} data-testid="wf-events-more">
            Tải thêm…
          </button>
        )}
      </p>
    </div>
  );
}

/**
 * The M5.7 workflow.md — a DERIVED, human-readable view rebuilt by Core from the verified log.
 * Rendered with the same safe Markdown renderer as the Development Journal. Nothing on this
 * screen reads state from it: the header, steps and controls come from Core's snapshot.
 */
export function WorkflowJournal({ workflowId, lastEventSeq }: { workflowId: string; lastEventSeq: number }) {
  const { api } = useBridge();
  const [state, setState] = useState<{ markdown: string | null; error: UiError | null; for: number } | null>(null);
  useEffect(() => {
    let active = true;
    api.workflowGetJournal({ workflowId }).then(
      (res) => active && setState(res.ok ? { markdown: res.data.markdown, error: null, for: lastEventSeq } : { markdown: null, error: res.error, for: lastEventSeq }),
      () => active && setState({ markdown: null, error: IPC_FAILED, for: lastEventSeq }),
    );
    return () => {
      active = false;
    };
    // Rebuilt by Core at every persisted checkpoint: re-read when the log grows.
  }, [api, workflowId, lastEventSeq]);

  if (!state) return <p className="hint">Đang tải journal…</p>;
  return (
    <div className="wf-journal" data-testid="wf-journal">
      <p className="hint small" data-testid="wf-journal-note">
        Derived view — workflow.md được Core dựng lại từ event log đã kiểm chứng; đây không phải nguồn sự thật. Trạng thái trên màn hình lấy từ snapshot của Core.
      </p>
      {state.error && (
        <>
          <p className="hint" data-testid="wf-journal-unavailable">
            Journal: {UNKNOWN} — không khả dụng.
          </p>
          <ErrorPanel error={state.error} />
        </>
      )}
      {state.markdown !== null && (
        <div className="markdown-scroll">
          <Markdown source={state.markdown} />
        </div>
      )}
    </div>
  );
}

/** What the instance pinned (ADR-018) and the M5 configuration it runs under — read-only. */
export function WorkflowDefinitionInfo({ snapshot, budgetLabels }: { snapshot: WorkflowSnapshot; budgetLabels: Record<string, string> }) {
  const s = snapshot;
  return (
    <div className="wf-definition" data-testid="wf-definition-info">
      <dl className="kv">
        <dt>Definition</dt>
        <dd>
          {s.title} — <span className="mono">{s.definitionId}</span> v{s.version}
        </dd>
        <dt>Pinned hash</dt>
        <dd className="mono" data-testid="wf-definition-hash">
          {s.definitionHash}
        </dd>
        <dt>Steps</dt>
        <dd data-testid="wf-definition-steps">
          {s.steps.length} — {s.steps.map((st) => st.stepId).join(' → ')}
        </dd>
        <dt>Attempts per step</dt>
        <dd>{[...new Set(s.steps.map((st) => st.maxAttempts))].join(', ') || UNKNOWN} (M5: một attempt mỗi step, không retry)</dd>
        <dt>Verification</dt>
        <dd>{verificationModeText(s.verification.mode, s.verification.deterministicChecks)}</dd>
        <dt>Best evidence in M5</dt>
        <dd>{evidenceText('AI_ATTESTED')}</dd>
        <dt>Inputs</dt>
        <dd className="mono">{s.inputNames.join(', ') || 'none'}</dd>
        {s.budgets.map((b) => (
          <FragmentRow key={b.name} label={`Budget · ${budgetLabels[b.name] ?? b.name}`} value={`${b.used} / ${b.limit ?? 'unbounded'}${b.incomplete ? ' (incomplete — một segment không báo usage)' : ''}`} />
        ))}
        <dt>Deadline</dt>
        <dd>{s.deadlineAt ? formatDateTime(s.deadlineAt) : UNKNOWN}</dd>
      </dl>
      <p className="hint small">Definition chỉ đọc trong M5 — sửa file trong .ai-bridge/workflows/definitions/ và bắt đầu một workflow mới.</p>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
