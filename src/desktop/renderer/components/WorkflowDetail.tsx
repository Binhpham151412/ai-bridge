import { useEffect, useState } from 'react';
import type { UiError, WorkflowAttemptView, WorkflowEvent, WorkflowPendingAction, WorkflowSnapshot } from '../../shared/ipc-contract.ts';
import { useBridge } from '../state/BridgeProvider.tsx';
import { useNav } from '../state/Navigation.tsx';
import { formatDateTime } from '../lib/format.ts';
import {
  ADOPT_NOTE,
  BUDGET_LABEL,
  UNKNOWN,
  answerLabel,
  evidenceText,
  orUnknown,
  recoveryKey,
  recoveryLabel,
  stateLabel,
  stateTone,
  terminalReasonLabel,
  verificationModeText,
  waitingReasonText,
  workflowHeadline,
} from '../lib/workflow-summary.ts';
import { Card, Disclosure, ErrorPanel } from './common.tsx';
import { WorkflowDefinitionInfo, WorkflowJournal, WorkflowTimeline } from './WorkflowHistory.tsx';
import type { WorkflowAct } from './WorkflowView.tsx';

/** A Core state as a badge: tone for scanning, the label for meaning (never colour alone). */
export function StatePill({ state, testId }: { state: string | null | undefined; testId?: string }) {
  return (
    <span className={`pill tone-${stateTone(state)}`} data-testid={testId ?? 'wf-state'} title={`Core state: ${orUnknown(state)}`}>
      <span className="pill-dot" aria-hidden="true" />
      {stateLabel(state)}
    </span>
  );
}

/** PAUSE / RESUME / STOP (and START for a CREATED instance), enabled exactly by the controls Core
 * derived (deriveWorkflowControls, via Main). While Main is carrying out an action nothing is
 * re-sent; Main re-checks every request against Core anyway. */
function WorkflowControls({ snapshot, pendingAction, act }: { snapshot: WorkflowSnapshot; pendingAction: WorkflowPendingAction | null; act: WorkflowAct }) {
  const { api } = useBridge();
  const c = snapshot.controls;
  const busy = pendingAction !== null;
  const id = { workflowId: snapshot.workflowId };
  const onStop = () => {
    if (window.confirm('STOP workflow? Execution đang chạy (nếu có) sẽ được dừng qua Core và workflow kết thúc STOPPED. Muốn tiếp tục sau, hãy dùng PAUSE.')) void act(() => api.workflowStop(id));
  };
  return (
    <div className="controls" role="toolbar" aria-label="Workflow controls" data-testid="wf-controls">
      {c.canStart && (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.workflowResume(id))} data-testid="wf-btn-start">
          {pendingAction === 'resume' ? 'STARTING…' : 'START'}
        </button>
      )}
      <button type="button" className="btn" disabled={!c.canPause || busy} onClick={() => void act(() => api.workflowPause(id))} data-testid="wf-btn-pause">
        {pendingAction === 'pause' || snapshot.pauseRequested ? 'PAUSING…' : 'PAUSE'}
      </button>
      <button type="button" className="btn" disabled={!c.canResume || busy} onClick={() => void act(() => api.workflowResume(id))} data-testid="wf-btn-resume">
        {pendingAction === 'resume' ? 'RESUMING…' : 'RESUME'}
      </button>
      <button type="button" className="btn btn-danger" disabled={!c.canStop || busy} onClick={onStop} data-testid="wf-btn-stop" title="Dừng workflow qua WorkflowEngine">
        {pendingAction === 'stop' || snapshot.stopRequested ? 'STOPPING…' : 'STOP'}
      </button>
    </div>
  );
}

function WaitingHuman({ snapshot, pendingAction, act }: { snapshot: WorkflowSnapshot; pendingAction: WorkflowPendingAction | null; act: WorkflowAct }) {
  const { api } = useBridge();
  const waiting = snapshot.waitingFor!;
  const attempt = snapshot.steps.flatMap((s) => (s.current ? [{ step: s, attempt: s.current }] : [])).find((x) => x.attempt.attemptId === waiting.attemptId);
  const answers = snapshot.controls.canAnswer;
  const answer = (a: string) => {
    const question =
      a === 'approve-bypass'
        ? `${answerLabel(a)}?\n\nStep này sẽ chạy lại thành một attempt MỚI (execution và session CLI mới) với permission policy = bypass: Claude/Codex được thực thi lệnh, mở server, truy cập localhost/trình duyệt mà không hỏi lại. Chỉ được duyệt 1 lần cho mỗi step.`
        : `${answerLabel(a)}? Workflow ${snapshot.workflowId} sẽ kết thúc.`;
    if (!window.confirm(question)) return;
    // The IPC contract accepts the M5 answers only; Main validates, Core decides.
    void act(() => api.workflowAnswer({ workflowId: snapshot.workflowId, answer: a as 'fail' | 'stop' | 'approve-bypass' }));
  };
  return (
    <section className="banner banner-human" aria-label="Workflow cần bạn quyết định" data-testid="wf-waiting">
      <div>
        <strong>⚑ Workflow đang chờ bạn quyết định ({waiting.kind})</strong>
        <p className="banner-reason" data-testid="wf-waiting-reason">
          Lý do: {waitingReasonText(waiting.reason)}
        </p>
        <dl className="kv kv-compact">
          <dt>Step</dt>
          <dd>{attempt ? `${attempt.step.title} (${attempt.step.stepId})` : UNKNOWN}</dd>
          <dt>Attempt</dt>
          <dd className="mono">{orUnknown(waiting.attemptId)}</dd>
          <dt>Execution</dt>
          <dd className="mono">{orUnknown(attempt?.attempt.executionId)}</dd>
          <dt>Lựa chọn Core ghi nhận</dt>
          <dd className="mono" data-testid="wf-waiting-options">
            {waiting.options.join(', ') || UNKNOWN}
          </dd>
        </dl>
      </div>
      <div className="banner-actions">
        {answers.map((a) => (
          <button
            key={a}
            type="button"
            className={a === 'stop' ? 'btn btn-danger' : a === 'approve-bypass' ? 'btn btn-primary' : 'btn'}
            disabled={pendingAction !== null}
            onClick={() => answer(a)}
            data-testid={`wf-answer-${a}`}
          >
            {answerLabel(a)}
          </button>
        ))}
        {answers.length === 0 && <span className="hint">Không có câu trả lời nào được chấp nhận lúc này.</span>}
      </div>
    </section>
  );
}

function AttemptDetails({ attemptId }: { attemptId: string }) {
  const { api } = useBridge();
  const [state, setState] = useState<{ data: WorkflowAttemptView | null; error: UiError | null } | null>(null);
  useEffect(() => {
    let active = true;
    api.workflowGetAttempt({ attemptId }).then(
      (res) => active && setState(res.ok ? { data: res.data, error: null } : { data: null, error: res.error }),
      () => active && setState({ data: null, error: { code: 'IPC_FAILED', title: 'Không liên lạc được với Electron Main', message: 'Không đọc được attempt.' } }),
    );
    return () => {
      active = false;
    };
  }, [api, attemptId]);
  if (!state) return <p className="hint">Đang tải attempt…</p>;
  if (state.error || !state.data) return <ErrorPanel error={state.error ?? { code: 'UNKNOWN', title: 'Không có dữ liệu', message: UNKNOWN }} />;
  const a = state.data.attempt;
  return (
    <div data-testid="wf-attempt-details">
      <dl className="kv kv-inline">
        <dt>Planned</dt>
        <dd>{formatDateTime(a.plannedAt)}</dd>
        <dt>Launched</dt>
        <dd>{formatDateTime(a.launchedAt)}</dd>
        <dt>Ended</dt>
        <dd>{formatDateTime(a.endedAt)}</dd>
        <dt>Launches</dt>
        <dd>{a.launches}</dd>
        <dt>Execution Host pid</dt>
        <dd className="mono">{orUnknown(a.hostPid)}</dd>
        <dt>Reported tokens</dt>
        <dd>{a.tokensIncomplete ? `${UNKNOWN} (một segment không báo usage)` : a.reportedTokens}</dd>
        <dt>Stop cause</dt>
        <dd>{orUnknown(a.stopCause)}</dd>
        <dt>Verification note</dt>
        <dd>{orUnknown(a.verification?.failureSummary)}</dd>
      </dl>
      <h3 className="tech-title">Task sent (task.md)</h3>
      {state.data.task === null ? <p className="hint">{UNKNOWN} — không có task.md cho attempt này.</p> : <pre className="raw">{state.data.task}</pre>}
    </div>
  );
}

function Steps({ snapshot }: { snapshot: WorkflowSnapshot }) {
  const { go } = useNav();
  return (
    <Card title="Steps" className="wf-steps-card">
      <ol className="wf-steps" aria-label="Workflow steps">
        {snapshot.steps.map((s, i) => {
          const current = s.stepId === snapshot.currentStepId;
          const a = s.current;
          return (
            <li key={s.stepId} className={`wf-step ${current ? 'current' : ''}`} aria-current={current ? 'step' : undefined} data-testid="wf-step" data-step-id={s.stepId}>
              <div className="wf-step-head">
                <span className="wf-step-index" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="wf-step-title">{s.title}</span>
                <span className="mono small">{s.stepId}</span>
                <StatePill state={s.state} testId="wf-step-state" />
                {current && (
                  <span className="badge" data-testid="wf-step-current">
                    Current step
                  </span>
                )}
              </div>
              <dl className="kv kv-inline">
                <dt>Attempt</dt>
                <dd data-testid="wf-step-attempt">{a ? `${s.attempts}/${s.maxAttempts} · ${stateLabel(a.state)}` : `0/${s.maxAttempts}`}</dd>
                <dt>Execution</dt>
                <dd className="mono" data-testid="wf-step-execution">
                  {orUnknown(a?.executionId)}
                </dd>
                <dt>Iterations</dt>
                <dd>{a ? `${a.iterationsUsed} / ${a.maxIterations}` : UNKNOWN}</dd>
                <dt>Outcome</dt>
                <dd data-testid="wf-step-outcome">{a?.outcome ? `${a.outcome.kind}${a.outcome.finalStatus ? ` ${a.outcome.finalStatus}` : ''}${a.outcome.errorCode ? ` · ${a.outcome.errorCode}` : ''}` : UNKNOWN}</dd>
                <dt>Verification</dt>
                <dd data-testid="wf-step-verification">{s.lastVerification ? `${s.lastVerification.verdict} — ${evidenceText(s.lastVerification.evidenceLevel)}` : UNKNOWN}</dd>
                <dt>Evidence</dt>
                <dd data-testid="wf-step-evidence">{evidenceText(s.evidenceLevel)}</dd>
              </dl>
              {a?.executionId && (
                <div className="row-actions">
                  <button type="button" className="btn btn-link" onClick={() => go('journal', { runId: a.executionId! })} data-testid="wf-open-journal">
                    Journal của run →
                  </button>
                  <button type="button" className="btn btn-link" onClick={() => go('artifacts', { runId: a.executionId! })} data-testid="wf-open-artifacts">
                    Artifacts của run →
                  </button>
                </div>
              )}
              {a && (
                <Disclosure title="Attempt details" summary={a.attemptId} testId={`wf-attempt-${s.stepId}`}>
                  <AttemptDetails attemptId={a.attemptId} />
                </Disclosure>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function Recovery({ snapshot }: { snapshot: WorkflowSnapshot }) {
  if (snapshot.recovery.length === 0) return null;
  return (
    <Card title="Recovery & reconciliation (M5.6)" className="wf-recovery-card">
      <ol className="wf-recovery" data-testid="wf-recovery">
        {snapshot.recovery.map((r) => (
          <li key={r.seq} className="wf-recovery-item" data-testid="wf-recovery-item" data-kind={recoveryKey(r)}>
            <span className="badge badge-warn">{recoveryKey(r)}</span>
            <span className="wf-recovery-text">{recoveryLabel(r)}</span>
            <span className="small mono wf-recovery-meta">
              seq {r.seq} · {formatDateTime(r.timestamp)}
              {r.executionId ? ` · execution ${r.executionId}` : ''}
              {r.reason ? ` · ${r.reason}` : ''}
            </span>
          </li>
        ))}
      </ol>
      <p className="hint small" data-testid="wf-adopt-note">
        {ADOPT_NOTE}
      </p>
    </Card>
  );
}

type Tab = 'timeline' | 'journal' | 'definition';

/** One workflow instance: header, Core's controls, what needs attention, steps, recovery, and
 * (on demand) its event timeline, derived journal and definition. */
export function WorkflowDetail({
  snapshot,
  pendingAction,
  attached,
  pushed,
  act,
}: {
  snapshot: WorkflowSnapshot;
  pendingAction: WorkflowPendingAction | null;
  attached: boolean;
  pushed: WorkflowEvent[];
  act: WorkflowAct;
}) {
  const [tab, setTab] = useState<Tab>('timeline');
  const s = snapshot;
  const exec = s.execution;
  return (
    <div className="wf-detail" data-testid="wf-detail" data-workflow-id={s.workflowId}>
      <section className="card wf-header" aria-label="Workflow">
        <div className="wf-header-top">
          <div>
            <h2 className="wf-title">{s.title}</h2>
            <p className="mono small">{s.workflowId}</p>
          </div>
          <div className="wf-header-state">
            <StatePill state={s.displayState} testId="wf-display-state" />
            {s.displayState !== s.state && (
              <span className="small" data-testid="wf-persisted-state">
                persisted: {s.state}
              </span>
            )}
          </div>
        </div>
        <p className={`wf-headline text-${stateTone(s.displayState)}`} data-testid="wf-headline" aria-live="polite">
          {workflowHeadline(s.displayState)}
        </p>
        <dl className="kv kv-inline">
          <dt>Definition</dt>
          <dd data-testid="wf-definition">
            {s.definitionId} v{s.version}
          </dd>
          <dt>Definition hash</dt>
          <dd className="mono" title={s.definitionHash}>
            {s.definitionHash.slice(0, 16)}…
          </dd>
          <dt>Terminal reason</dt>
          <dd data-testid="wf-terminal-reason">{terminalReasonLabel(s.terminalReason)}</dd>
          <dt>Evidence</dt>
          <dd data-testid="wf-evidence">{evidenceText(s.evidenceLevel)}</dd>
          <dt>Verification</dt>
          <dd data-testid="wf-verification-mode">{verificationModeText(s.verification.mode, s.verification.deterministicChecks)}</dd>
          <dt>Workflow Host</dt>
          <dd data-testid="wf-host">{s.host.alive ? `đang chạy (pid ${orUnknown(s.host.pid)})${attached ? ' · do app này mở' : ''}` : 'không chạy'}</dd>
          <dt>Created</dt>
          <dd>{formatDateTime(s.createdAt)}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(s.startedAt)}</dd>
          <dt>Ended</dt>
          <dd>{formatDateTime(s.endedAt)}</dd>
          <dt>Current execution</dt>
          <dd className="mono" data-testid="wf-execution">
            {exec ? `${orUnknown(exec.runId)} · ${exec.status} · ${orUnknown(exec.currentPhase)} · round ${exec.iteration}/${orUnknown(exec.maxIterations)}` : UNKNOWN}
          </dd>
          <dt>Integrity</dt>
          <dd data-testid="wf-integrity">{s.integrity === 'OK' ? 'OK (hash chain verified)' : 'REPAIR_PENDING — sẽ được sửa khi workflow được mở lại'}</dd>
          <dt>Requests</dt>
          <dd>{[s.pauseRequested && 'pause pending', s.stopRequested && `stop pending (${s.stopRequested})`].filter(Boolean).join(' · ') || 'none'}</dd>
        </dl>
        <WorkflowControls snapshot={s} pendingAction={pendingAction} act={act} />
      </section>

      {s.displayState === 'INTERRUPTED' && (
        <section className="banner banner-blocked" data-testid="wf-interrupted">
          <div>
            <strong>Workflow bị gián đoạn</strong>
            <p className="banner-reason">Trạng thái lưu là RUNNING nhưng không có Workflow Host nào đang chạy. RESUME mở lại workflow; M5.6 reconciliation quyết định: theo dõi, adopt, resume hoặc hỏi bạn — không bao giờ chạy lại một execution có thể đã chạy.</p>
          </div>
        </section>
      )}
      {s.displayState === 'WAITING_HUMAN' && s.waitingFor && <WaitingHuman snapshot={s} pendingAction={pendingAction} act={act} />}

      <Steps snapshot={s} />
      <Recovery snapshot={s} />

      <section className="card wf-history" aria-label="Lịch sử workflow">
        <div className="tabs" role="tablist" aria-label="Workflow history">
          {(
            [
              ['timeline', 'Event timeline'],
              ['journal', 'Journal (workflow.md)'],
              ['definition', 'Definition'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)} data-testid={`wf-tab-${id}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === 'timeline' && <WorkflowTimeline workflowId={s.workflowId} lastEventSeq={s.lastEventSeq} pushed={pushed} />}
        {tab === 'journal' && <WorkflowJournal workflowId={s.workflowId} lastEventSeq={s.lastEventSeq} />}
        {tab === 'definition' && <WorkflowDefinitionInfo snapshot={s} budgetLabels={BUDGET_LABEL} />}
      </section>
    </div>
  );
}
