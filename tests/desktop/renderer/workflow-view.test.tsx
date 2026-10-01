import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import { evidenceText, summarizeEvent } from '../../../src/desktop/renderer/lib/workflow-summary.ts';
import type { WorkflowEvent, WorkflowListItem, WorkflowPanelSnapshot, WorkflowSnapshot } from '../../../src/desktop/shared/ipc-contract.ts';
import { FakeMain, click, flush, makeSnapshot, q, qa, render } from './harness.tsx';
import { change } from './input.ts';

// M5.9: the Workflows view is a pure consumer of Main's workflow snapshots/events. These tests
// pin that: every state, control, evidence label and recovery entry shown is the one Main sent;
// every action is one typed IPC call; nothing is derived, polled or read from the journal.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WF = 'wf_2026-10-01_001';
const WF2 = 'wf_2026-10-01_002';

function snap(over: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    workflowId: WF,
    definitionId: 'host-flow',
    version: 1,
    title: 'Host flow',
    definitionHash: 'a'.repeat(64),
    state: 'RUNNING',
    displayState: 'RUNNING',
    terminalReason: null,
    evidenceLevel: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    startedAt: '2026-10-01T09:00:01.000Z',
    endedAt: null,
    updatedAt: '2026-10-01T09:05:00.000Z',
    pauseRequested: false,
    stopRequested: null,
    integrity: 'OK',
    host: { alive: true, pid: 4242 },
    inputNames: [],
    steps: [
      {
        stepId: 'build',
        title: 'Step build',
        state: 'SUCCEEDED',
        evidenceLevel: 'AI_ATTESTED',
        attempts: 1,
        maxAttempts: 1,
        current: { attemptId: `${WF}/build/1`, state: 'PASSED', executionId: '2026-10-01_001', iterationsUsed: 2, maxIterations: 3, outcome: { kind: 'ENDED', finalStatus: 'DONE', errorCode: null, class: 'SUCCESS' } },
        lastVerification: { verdict: 'PASS', evidenceLevel: 'AI_ATTESTED' },
      },
      {
        stepId: 'docs',
        title: 'Step docs',
        state: 'ACTIVE',
        evidenceLevel: null,
        attempts: 1,
        maxAttempts: 1,
        current: { attemptId: `${WF}/docs/1`, state: 'EXECUTING', executionId: '2026-10-01_002', iterationsUsed: 0, maxIterations: 3, outcome: null },
        lastVerification: null,
      },
    ],
    currentStepId: 'docs',
    verification: { mode: 'OUTCOME_ONLY', deterministicChecks: 0 },
    recovery: [],
    budgets: [
      { name: 'executions', used: 2, limit: 2, incomplete: false },
      { name: 'iterations', used: 2, limit: 200, incomplete: false },
      { name: 'reportedTokens', used: 10, limit: null, incomplete: false },
    ],
    deadlineAt: '2026-10-01T17:00:01.000Z',
    waitingFor: null,
    controls: { canStart: false, canPause: true, canResume: false, canStop: true, canAnswer: [] },
    lastEventSeq: 3,
    execution: null,
    ...over,
  };
}

function panel(over: Partial<WorkflowPanelSnapshot> = {}): WorkflowPanelSnapshot {
  return { project: { path: 'D:\\work\\demo', name: 'demo' }, workflow: snap(), activity: { hostPid: 4242, hostedWorkflowId: WF, running: [WF] }, canStartNew: false, startBlockedBy: null, attached: true, pendingAction: null, lastError: null, ...over };
}

function item(over: Partial<WorkflowListItem> = {}): WorkflowListItem {
  return {
    workflowId: WF,
    integrity: 'OK',
    definitionId: 'host-flow',
    version: 1,
    state: 'RUNNING',
    displayState: 'RUNNING',
    terminalReason: null,
    evidenceLevel: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:05:00.000Z',
    currentStep: { stepId: 'docs', state: 'ACTIVE' },
    currentAttempt: { attemptId: `${WF}/docs/1`, state: 'EXECUTING', executionId: '2026-10-01_002' },
    ...over,
  };
}

function ev(seq: number, type: WorkflowEvent['type'], over: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return { schema: 1, eventId: `${WF}#${seq}`, seq, workflowId: WF, correlationId: WF, causationId: null, type, timestamp: `2026-10-01T09:00:${String(seq % 60).padStart(2, '0')}.000Z`, stepId: null, attemptId: null, executionId: null, actor: 'workflow-engine', provider: null, payload: {}, artifacts: [], prevHash: null, hash: `h${seq}`, ...over };
}

interface Setup {
  panel?: WorkflowPanelSnapshot | null;
  list?: WorkflowListItem[];
  get?: Record<string, WorkflowSnapshot>;
  events?: WorkflowEvent[];
}

async function openWorkflows(setup: Setup = {}, extra?: (main: FakeMain) => void) {
  const main = new FakeMain(makeSnapshot());
  const p = setup.panel === undefined ? panel() : setup.panel;
  main.handlers.set('workflow:getSnapshot', () => (p ? { ok: true, data: p } : new Promise(() => {})));
  main.handlers.set('workflow:list', () => ({ ok: true, data: setup.list ?? [item()] }));
  main.handlers.set('workflow:get', (req) => {
    const id = (req as { workflowId: string }).workflowId;
    const s = setup.get?.[id];
    return s ? { ok: true, data: s } : { ok: false, error: { code: 'WORKFLOW_NOT_FOUND', title: 'Không tìm thấy workflow', message: `no workflow ${id}` } };
  });
  main.handlers.set('workflow:getEvents', (req) => {
    const { afterSeq, limit } = req as { afterSeq: number; limit: number };
    return { ok: true, data: (setup.events ?? [ev(1, 'WORKFLOW_CREATED'), ev(2, 'INPUT_RECEIVED', { payload: { inputType: 'START', input: '{"type":"START","secret":"x"}' } }), ev(3, 'WORKFLOW_STATE_CHANGED', { payload: { from: 'CREATED', to: 'RUNNING' } })]).filter((e) => e.seq > afterSeq).slice(0, limit) };
  });
  extra?.(main);
  const view = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  await click(q(view.container, 'nav-workflows'));
  return { main, ...view };
}

const text = (el: Element | null) => el?.textContent ?? '';
const invoked = (main: FakeMain, channel: string) => main.invoked.filter((c) => c.channel === channel);
const pushPanel = async (main: FakeMain, next: WorkflowPanelSnapshot) => {
  main.emit('workflow:snapshot', {}, next);
  await flush();
};

// ---------------------------------------------------------------------------
// A. navigation
// ---------------------------------------------------------------------------

test('navigation: a Workflows entry right after Run; the other entries and the default view are unchanged', async () => {
  const main = new FakeMain(makeSnapshot());
  main.handlers.set('workflow:getSnapshot', () => ({ ok: true, data: panel({ workflow: null }) }));
  main.handlers.set('workflow:list', () => ({ ok: true, data: [] }));
  const { container, unmount } = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  assert.deepEqual(
    [...container.querySelectorAll('[data-testid^="nav-"]')].map((b) => b.getAttribute('data-testid')),
    ['nav-run', 'nav-workflows', 'nav-journal', 'nav-artifacts', 'nav-settings', 'nav-system'],
  );
  assert.ok(q(container, 'run-hero'), 'RUN is still the default view');
  assert.equal(invoked(main, 'workflow:getSnapshot').length, 0, 'nothing workflow-related is loaded until the view opens');
  await click(q(container, 'nav-workflows'));
  assert.equal(q(container, 'nav-workflows')?.getAttribute('aria-current'), 'page');
  assert.ok(q(container, 'workflow-view'));
  await click(q(container, 'nav-run'));
  assert.ok(q(container, 'run-hero'));
  assert.equal(q(container, 'workflow-view'), null);
  await unmount();
});

// ---------------------------------------------------------------------------
// B. list
// ---------------------------------------------------------------------------

test('list: loading, empty and populated (newest first); missing values are UNKNOWN; an untrusted instance is flagged', async () => {
  const loading = await openWorkflows({ panel: null });
  assert.match(text(loading.container.querySelector('.content')), /Đang tải…/);
  await loading.unmount();

  const empty = await openWorkflows({ panel: panel({ workflow: null, activity: { hostPid: null, hostedWorkflowId: null, running: [] }, canStartNew: true }), list: [] });
  assert.match(text(empty.container), /Project chưa có workflow nào/);
  assert.equal((q(empty.container, 'wf-start') as HTMLButtonElement).disabled, false);
  await empty.unmount();

  const broken = item({ workflowId: WF2, integrity: 'BROKEN', definitionId: null, version: null, state: null, displayState: null, createdAt: null, updatedAt: null, currentStep: null, currentAttempt: null });
  const full = await openWorkflows({ list: [item(), broken] });
  const items = qa(full.container, 'wf-item');
  assert.deepEqual(items.map((i) => i.getAttribute('data-workflow-id')), [WF2, WF], 'newest first');
  assert.match(text(items[0]), /UNKNOWN/);
  assert.equal(text(q(items[0], 'wf-item-integrity')), 'BROKEN');
  assert.equal(text(q(items[1], 'wf-item-state')), 'Running');
  assert.match(text(q(items[1], 'wf-item-step')), /Step: docs · Active · Attempt: Executing/);
  assert.equal(items[1].getAttribute('aria-current'), 'true', 'the followed workflow is selected by default');
  await full.unmount();
});

test('selection: picking another workflow loads it by id from Main (workflow:get); its detail is shown', async () => {
  const done = snap({ workflowId: WF2, state: 'COMPLETED', displayState: 'COMPLETED', terminalReason: 'ALL_STEPS_PASSED', evidenceLevel: 'AI_ATTESTED', controls: { canStart: false, canPause: false, canResume: false, canStop: false, canAnswer: [] } });
  const { main, container, unmount } = await openWorkflows({ list: [item(), item({ workflowId: WF2, state: 'COMPLETED', displayState: 'COMPLETED' })], get: { [WF2]: done } });
  await click(qa(container, 'wf-item').find((i) => i.getAttribute('data-workflow-id') === WF2));
  assert.deepEqual(invoked(main, 'workflow:get').at(-1)?.args, [{ workflowId: WF2 }]);
  assert.equal(q(container, 'wf-detail')?.getAttribute('data-workflow-id'), WF2);
  assert.equal(text(q(container, 'wf-display-state')), 'Completed');
  assert.match(text(q(container, 'wf-terminal-reason')), /ALL_STEPS_PASSED/);
  await unmount();
});

// ---------------------------------------------------------------------------
// C. detail + verification
// ---------------------------------------------------------------------------

test('detail: header, steps, attempts, executions and verification exactly as Main sent them; the current step is highlighted', async () => {
  const s = snap({ execution: { runId: '2026-10-01_002', status: 'RUNNING', iteration: 1, currentPhase: 'CLAUDE_EXECUTING', claude: { pid: 1, sessionId: null }, codex: { pid: null, threadId: null }, startedAt: null, updatedAt: null, lastReportPath: null, maxIterations: 3, activity: { claude: 'EXECUTING', codex: 'IDLE' } } });
  const { container, unmount } = await openWorkflows({ panel: panel({ workflow: s }) });
  assert.equal(text(q(container, 'wf-display-state')), 'Running');
  assert.equal(text(q(container, 'wf-definition')), 'host-flow v1');
  assert.equal(text(q(container, 'wf-evidence')), 'UNKNOWN', 'no evidence yet: shown as UNKNOWN, not guessed');
  assert.match(text(q(container, 'wf-verification-mode')), /^OutcomeOnly \(M5\)/);
  assert.match(text(q(container, 'wf-execution')), /2026-10-01_002 · RUNNING · CLAUDE_EXECUTING · round 1\/3/);
  const steps = qa(container, 'wf-step');
  assert.deepEqual(steps.map((x) => x.getAttribute('data-step-id')), ['build', 'docs']);
  assert.equal(text(q(steps[0], 'wf-step-state')), 'Succeeded');
  assert.equal(text(q(steps[0], 'wf-step-execution')), '2026-10-01_001');
  assert.equal(text(q(steps[0], 'wf-step-outcome')), 'ENDED DONE');
  assert.equal(text(q(steps[0], 'wf-step-verification')), 'PASS — AI_ATTESTED — chưa kiểm chứng bằng deterministic checks');
  assert.equal(text(q(steps[0], 'wf-step-attempt')), '1/1 · Passed');
  assert.equal(steps[0].getAttribute('aria-current'), null);
  assert.equal(steps[1].getAttribute('aria-current'), 'step');
  assert.ok(q(steps[1], 'wf-step-current'));
  assert.equal(text(q(steps[1], 'wf-step-outcome')), 'UNKNOWN');
  await unmount();
});

test('AI_ATTESTED is never shown as VERIFIED — on a COMPLETED workflow the word VERIFIED does not appear', async () => {
  assert.equal(evidenceText('AI_ATTESTED'), 'AI_ATTESTED — chưa kiểm chứng bằng deterministic checks');
  const done = snap({ state: 'COMPLETED', displayState: 'COMPLETED', terminalReason: 'ALL_STEPS_PASSED', evidenceLevel: 'AI_ATTESTED', controls: { canStart: false, canPause: false, canResume: false, canStop: false, canAnswer: [] } });
  const { container, unmount } = await openWorkflows({ panel: panel({ workflow: done, attached: false }) });
  assert.equal(text(q(container, 'wf-evidence')), 'AI_ATTESTED — chưa kiểm chứng bằng deterministic checks');
  await click(q(container, 'wf-tab-definition'));
  assert.doesNotMatch(text(container.querySelector('.content')), /\bVERIFIED\b/);
  await unmount();
});

// ---------------------------------------------------------------------------
// D. controls
// ---------------------------------------------------------------------------

test('controls are Core’s, verbatim: enabled exactly by snapshot.controls — even when they look inconsistent with the state', async () => {
  const running = await openWorkflows({ panel: panel({ workflow: snap({ controls: { canStart: false, canPause: false, canResume: false, canStop: false, canAnswer: [] } }) }) });
  for (const id of ['wf-btn-pause', 'wf-btn-resume', 'wf-btn-stop']) assert.equal((q(running.container, id) as HTMLButtonElement).disabled, true, `${id}: RUNNING but Core allows nothing`);
  await click(q(running.container, 'wf-btn-pause'));
  assert.equal(invoked(running.main, 'workflow:pause').length, 0, 'a disabled control sends nothing');
  await running.unmount();

  const odd = await openWorkflows({ panel: panel({ workflow: snap({ state: 'COMPLETED', displayState: 'COMPLETED', controls: { canStart: false, canPause: false, canResume: true, canStop: false, canAnswer: [] } }) }) });
  assert.equal((q(odd.container, 'wf-btn-resume') as HTMLButtonElement).disabled, false, 'the renderer does not second-guess Core');
  await odd.unmount();

  const busy = await openWorkflows({ panel: panel({ pendingAction: 'stop' }) });
  assert.equal((q(busy.container, 'wf-btn-pause') as HTMLButtonElement).disabled, true, 'nothing is re-sent while Main is busy');
  assert.equal(text(q(busy.container, 'wf-btn-stop')), 'STOPPING…');
  await busy.unmount();
});

test('pause / resume / stop send exactly one typed request each; STOP asks for confirmation first', async () => {
  const { main, container, unmount } = await openWorkflows({}, (m) => {
    m.handlers.set('workflow:pause', () => ({ ok: true, message: 'Đã yêu cầu PAUSE.' }));
    m.handlers.set('workflow:stop', () => ({ ok: true }));
  });
  await click(q(container, 'wf-btn-pause'));
  assert.deepEqual(invoked(main, 'workflow:pause').map((c) => c.args), [[{ workflowId: WF }]]);
  assert.match(text(container.querySelector('.notice')), /Đã yêu cầu PAUSE/);

  const w = window as unknown as { confirm: (m: string) => boolean };
  const original = w.confirm;
  const asked: string[] = [];
  w.confirm = (m) => (asked.push(m), false);
  await click(q(container, 'wf-btn-stop'));
  assert.equal(invoked(main, 'workflow:stop').length, 0, 'declined: nothing sent');
  w.confirm = () => true;
  await click(q(container, 'wf-btn-stop'));
  w.confirm = original;
  assert.match(asked[0], /^STOP workflow\?/);
  assert.deepEqual(invoked(main, 'workflow:stop').map((c) => c.args), [[{ workflowId: WF }]]);

  await pushPanel(main, panel({ workflow: snap({ state: 'PAUSED', displayState: 'PAUSED', controls: { canStart: false, canPause: false, canResume: true, canStop: true, canAnswer: [] } }) }));
  await click(q(container, 'wf-btn-resume'));
  assert.deepEqual(invoked(main, 'workflow:resume').map((c) => c.args), [[{ workflowId: WF }]]);
  await unmount();
});

// ---------------------------------------------------------------------------
// E. WAITING_HUMAN
// ---------------------------------------------------------------------------

test('WAITING_HUMAN: reason, Core’s recorded options, and answer buttons only for the answers Core accepts; the answer goes to Main', async () => {
  const waiting = snap({
    state: 'WAITING_HUMAN',
    displayState: 'WAITING_HUMAN',
    host: { alive: false, pid: null },
    steps: [snap().steps[0], { ...snap().steps[1], state: 'ACTIVE', current: { ...snap().steps[1].current!, state: 'NEEDS_HUMAN' } }],
    waitingFor: { kind: 'HUMAN', reason: 'EXECUTION_NOT_RECOVERABLE', attemptId: `${WF}/docs/1`, options: ['fail', 'stop', 'retry'] },
    controls: { canStart: false, canPause: false, canResume: false, canStop: true, canAnswer: ['fail', 'stop'] },
  });
  const { main, container, unmount } = await openWorkflows({ panel: panel({ workflow: waiting, attached: false }) }, (m) => m.handlers.set('workflow:answer', () => ({ ok: true })));
  const box = q(container, 'wf-waiting')!;
  assert.match(text(q(box, 'wf-waiting-reason')), /^Lý do: .*\(EXECUTION_NOT_RECOVERABLE\)$/);
  assert.equal(text(q(box, 'wf-waiting-options')), 'fail, stop, retry');
  assert.match(text(box), /wf_2026-10-01_001\/docs\/1/);
  assert.match(text(box), /2026-10-01_002/);
  assert.ok(q(box, 'wf-answer-fail'));
  assert.ok(q(box, 'wf-answer-stop'));
  assert.equal(q(box, 'wf-answer-retry'), null, 'retry is recorded by Core but not accepted in M5 — no button');
  await click(q(box, 'wf-answer-fail'));
  assert.deepEqual(invoked(main, 'workflow:answer').map((c) => c.args), [[{ workflowId: WF, answer: 'fail' }]]);
  await unmount();
});

// ---------------------------------------------------------------------------
// F. recovery
// ---------------------------------------------------------------------------

test('recovery: every persisted finding/repair in seq order, distinct from progress; ADOPT is never invented', async () => {
  const r = (seq: number, kind: WorkflowSnapshot['recovery'][number]['kind'], finding: string | null, o: Partial<WorkflowSnapshot['recovery'][number]> = {}) => ({ seq, timestamp: '2026-10-01T09:10:00.000Z', type: kind === 'FINDING' || kind === 'STORE_REPAIR' ? ('RECONCILED' as const) : ('INPUT_RECEIVED' as const), kind, finding, attemptId: `${WF}/docs/1`, executionId: null, reason: null, ...o });
  const recovery = [
    r(4, 'STORE_REPAIR', null, { reason: 'truncated a torn final line (12 bytes)' }),
    r(5, 'FINDING', 'NOT_STARTED'),
    r(8, 'HOST_FAILED', null, { executionId: '2026-10-01_002' }),
    r(9, 'FINDING', 'WATCH', { executionId: '2026-10-01_002' }),
    r(12, 'FINDING', 'RESUME', { executionId: '2026-10-01_002' }),
    r(15, 'FINDING', 'UNRESOLVABLE', { reason: 'EXECUTION_NOT_RECOVERABLE' }),
  ];
  const { container, unmount } = await openWorkflows({ panel: panel({ workflow: snap({ recovery }) }) });
  const entries = qa(container, 'wf-recovery-item');
  assert.deepEqual(entries.map((e) => e.getAttribute('data-kind')), ['STORE_REPAIR', 'NOT_STARTED', 'HOST_FAILED', 'WATCH', 'RESUME', 'UNRESOLVABLE']);
  assert.match(text(entries[3]), /^WATCH.*execution 2026-10-01_002/);
  assert.match(text(entries[5]), /EXECUTION_NOT_RECOVERABLE/);
  assert.doesNotMatch(entries.map(text).join('\n'), /\bADOPT\b/, 'no ADOPT entry: the log records none');
  assert.match(text(q(container, 'wf-adopt-note')), /ADOPT/, 'the reason is stated instead');
  await unmount();
});

test('interrupted: persisted RUNNING with no Workflow Host is shown as INTERRUPTED with the M5.6 explanation', async () => {
  const s = snap({ displayState: 'INTERRUPTED', host: { alive: false, pid: null }, controls: { canStart: false, canPause: false, canResume: true, canStop: true, canAnswer: [] } });
  const { container, unmount } = await openWorkflows({ panel: panel({ workflow: s, attached: false, activity: { hostPid: null, hostedWorkflowId: null, running: [WF] } }) });
  assert.equal(text(q(container, 'wf-display-state')), 'Interrupted');
  assert.equal(text(q(container, 'wf-persisted-state')), 'persisted: RUNNING');
  assert.match(text(q(container, 'wf-interrupted')), /M5\.6/);
  assert.equal((q(container, 'wf-btn-resume') as HTMLButtonElement).disabled, false);
  await unmount();
});

// ---------------------------------------------------------------------------
// G. timeline
// ---------------------------------------------------------------------------

test('timeline: on demand, in seq order, with sequence/time/type/step/attempt/execution; input JSON never shown; recovery rows marked', async () => {
  const events = [ev(3, 'RECONCILED', { attemptId: `${WF}/build/1`, payload: { finding: 'WATCH', executionId: '2026-10-01_001' } }), ev(1, 'WORKFLOW_CREATED', { payload: { definitionId: 'host-flow' } }), ev(2, 'INPUT_RECEIVED', { payload: { inputType: 'START', input: '{"type":"START","token":"sk-secret"}' } })];
  const { main, container, unmount } = await openWorkflows({ events });
  const rows = qa(container, 'wf-event');
  assert.deepEqual(rows.map((r) => Number(r.getAttribute('data-seq'))), [1, 2, 3]);
  assert.deepEqual(invoked(main, 'workflow:getEvents')[0].args, [{ workflowId: WF, afterSeq: 0, limit: 200 }]);
  assert.equal(text(q(rows[1], 'wf-event-type')), 'INPUT_RECEIVED');
  assert.equal(text(q(rows[1], 'wf-event-summary')), 'input START');
  assert.doesNotMatch(text(q(container, 'wf-timeline')), /sk-secret/);
  assert.equal(text(q(rows[0], 'wf-event-step')), 'UNKNOWN');
  assert.equal(text(q(rows[2], 'wf-event-attempt')), `${WF}/build/1`);
  assert.equal(text(q(rows[2], 'wf-event-execution')), 'UNKNOWN');
  assert.equal(text(q(rows[2], 'wf-event-provider')), 'UNKNOWN', 'no provider recorded → UNKNOWN');
  assert.ok(rows[2].classList.contains('wf-recovery-row'));
  assert.match(text(q(rows[2], 'wf-event-type')), /recovery/);
  assert.match(text(q(rows[0], 'wf-event-time')), /\d/, 'a timestamp is shown');
  assert.equal(summarizeEvent(ev(9, 'WORKFLOW_STATE_CHANGED', { payload: { from: 'RUNNING', to: 'PAUSED' } })), 'from=RUNNING · to=PAUSED');
  await unmount();
});

test('timeline: pages of 200 on request; live events and a grown log are added by seq — no renderer polling', async () => {
  const many = Array.from({ length: 205 }, (_, i) => ev(i + 1, 'EXECUTION_LINKED'));
  const { main, container, unmount } = await openWorkflows({ events: many, panel: panel({ workflow: snap({ lastEventSeq: 205 }) }) });
  assert.equal(qa(container, 'wf-event').length, 200, 'first page only');
  await click(q(container, 'wf-events-more'));
  assert.deepEqual(invoked(main, 'workflow:getEvents').at(-1)?.args, [{ workflowId: WF, afterSeq: 200, limit: 200 }]);
  assert.equal(qa(container, 'wf-event').length, 205);

  main.emit('workflow:event', {}, ev(206, 'EXECUTION_ENDED'));
  main.emit('workflow:event', {}, { ...ev(1, 'WORKFLOW_CREATED'), workflowId: WF2, eventId: `${WF2}#1` });
  await flush();
  assert.equal(qa(container, 'wf-event').length, 206, 'the live event of this workflow is appended; another workflow’s is not');

  const calls = main.invoked.length;
  await new Promise((r) => setTimeout(r, 60));
  await flush();
  assert.equal(main.invoked.length, calls, 'no timer-driven IPC calls');
  await unmount();
});

// ---------------------------------------------------------------------------
// H. journal
// ---------------------------------------------------------------------------

test('journal: loads workflow.md on demand, renders it safely, labels it derived — and never drives the state shown', async () => {
  const md = '# Workflow Journal — wf\n\n| Field | Value |\n|---|---|\n| State | COMPLETED |\n\n<script>window.pwned = true</script>\n';
  const { main, container, unmount } = await openWorkflows({}, (m) => m.handlers.set('workflow:getJournal', () => ({ ok: true, data: { workflowId: WF, markdown: md } })));
  assert.equal(invoked(main, 'workflow:getJournal').length, 0, 'not loaded until the tab is opened');
  await click(q(container, 'wf-tab-journal'));
  assert.deepEqual(invoked(main, 'workflow:getJournal')[0].args, [{ workflowId: WF }]);
  const journal = q(container, 'wf-journal')!;
  assert.match(text(q(journal, 'wf-journal-note')), /Derived view/);
  assert.match(text(journal.querySelector('h2')), /Workflow Journal/, 'rendered as Markdown (the renderer demotes # to h2)');
  assert.equal(journal.querySelector('script'), null);
  assert.match(text(journal), /<script>window\.pwned = true<\/script>/, 'raw HTML is shown as text');
  assert.equal((window as unknown as { pwned?: boolean }).pwned, undefined);
  assert.equal(text(q(container, 'wf-display-state')), 'Running', 'the journal says COMPLETED; the snapshot is what counts');
  await unmount();
});

test('journal unavailable: an explicit UNKNOWN / error — nothing fabricated', async () => {
  const { container, unmount } = await openWorkflows({}, (m) => m.handlers.set('workflow:getJournal', () => ({ ok: false, error: { code: 'WORKFLOW_BROKEN', title: 'Nhật ký workflow không toàn vẹn', message: 'hash chain broken at seq 4' } })));
  await click(q(container, 'wf-tab-journal'));
  assert.match(text(q(container, 'wf-journal-unavailable')), /UNKNOWN — không khả dụng/);
  assert.match(text(q(container, 'wf-journal')), /Nhật ký workflow không toàn vẹn/);
  await unmount();
});

// ---------------------------------------------------------------------------
// I. errors
// ---------------------------------------------------------------------------

test('errors: host unavailable, broken, not found, locked, active and IPC failure surface as the stable categories — no stack traces', async () => {
  const unavailable = await openWorkflows({}, (m) => m.handlers.set('workflow:getSnapshot', () => ({ ok: false, error: { code: 'HOST_UNAVAILABLE', title: 'Workflow Host không phản hồi', message: 'no answer' } })));
  assert.match(text(unavailable.container.querySelector('.error-panel')), /Workflow Host không phản hồi/);
  await unavailable.unmount();

  const broken = await openWorkflows({ list: [item(), item({ workflowId: WF2 })] }, (m) =>
    m.handlers.set('workflow:get', () => ({ ok: false, error: { code: 'WORKFLOW_BROKEN', title: 'Nhật ký workflow không toàn vẹn', message: 'hash chain broken', details: 'at seq 4' } })),
  );
  await click(qa(broken.container, 'wf-item').find((i) => i.getAttribute('data-workflow-id') === WF2));
  assert.match(text(broken.container.querySelector('.workflow-main .error-panel')), /Nhật ký workflow không toàn vẹn/);
  assert.doesNotMatch(text(broken.container), /at seq 4/, 'technical detail only behind "View details"');
  await broken.unmount();

  const locked = await openWorkflows({}, (m) => m.handlers.set('workflow:pause', () => ({ ok: false, error: { code: 'WORKFLOW_LOCKED', title: 'Một Workflow Host khác đang chạy', message: 'pid 99' } })));
  await click(q(locked.container, 'wf-btn-pause'));
  assert.match(text(locked.container.querySelector('.error-panel')), /Một Workflow Host khác đang chạy/);
  await locked.unmount();

  const active = await openWorkflows({ panel: panel({ canStartNew: false, startBlockedBy: { code: 'WORKFLOW_ACTIVE', title: 'Một workflow đang hoạt động', message: 'wf_2026-10-01_001 is RUNNING' } }) });
  assert.equal((q(active.container, 'wf-start') as HTMLButtonElement).disabled, true);
  assert.match(text(q(active.container, 'wf-start-blocked')), /Một workflow đang hoạt động/);
  await active.unmount();

  const ipc = await openWorkflows({}, (m) => m.handlers.set('workflow:pause', () => Promise.reject(new Error('Error invoking remote method\n    at IpcRenderer.invoke (node:electron/renderer)'))));
  await click(q(ipc.container, 'wf-btn-pause'));
  assert.match(text(ipc.container.querySelector('.error-panel')), /Không liên lạc được với Electron Main/);
  assert.doesNotMatch(text(ipc.container), /IpcRenderer\.invoke|node:electron/);
  await ipc.unmount();
});

// ---------------------------------------------------------------------------
// start + live updates
// ---------------------------------------------------------------------------

test('start: definitions from Main (invalid ones disabled), declared inputs, one typed start request with the listed hash', async () => {
  const defs = [
    { definitionId: 'host-flow', valid: true, definitionHash: 'b'.repeat(64), version: 2, title: 'Host flow', steps: [{ stepId: 'build', title: 'Build' }], inputs: [{ name: 'feature', required: true, maxLength: 50 }], errors: [] },
    { definitionId: 'broken-flow', valid: false, definitionHash: null, version: null, title: null, steps: [], inputs: [], errors: ['$.steps MISSING: required'] },
  ];
  const { main, container, unmount } = await openWorkflows({ panel: panel({ workflow: null, canStartNew: true, attached: false }), list: [] }, (m) => {
    m.handlers.set('workflow:listDefinitions', () => ({ ok: true, data: defs }));
    m.handlers.set('workflow:start', () => ({ ok: true, data: { workflowId: 'wf_2026-10-01_009' } }));
  });
  await click(q(container, 'wf-start'));
  const dialog = q(container, 'wf-start-dialog')!;
  const options = [...dialog.querySelectorAll('option')];
  assert.deepEqual(options.map((o) => [o.value, o.disabled]), [['host-flow', false], ['broken-flow', true]]);
  assert.match(text(q(dialog, 'wf-start-invalid')), /\$\.steps MISSING/);
  assert.match(text(q(dialog, 'wf-start-hash')), /b{64}/);
  await change(q(dialog, 'wf-start-input-feature') as HTMLTextAreaElement, 'dark mode');
  await click(q(dialog, 'wf-start-submit'));
  assert.deepEqual(invoked(main, 'workflow:start').map((c) => c.args), [[{ definitionId: 'host-flow', definitionHash: 'b'.repeat(64), inputs: { feature: 'dark mode' } }]]);
  assert.equal(q(container, 'wf-start-dialog'), null);
  assert.match(text(container.querySelector('.notice')), /wf_2026-10-01_009/);
  await unmount();
});

test('live updates: a pushed workflow:snapshot changes what is shown — no re-fetch of the followed workflow, no polling', async () => {
  const { main, container, unmount } = await openWorkflows();
  assert.equal(text(q(container, 'wf-display-state')), 'Running');
  const gets = invoked(main, 'workflow:get').length;
  await pushPanel(main, panel({ workflow: snap({ state: 'PAUSED', displayState: 'PAUSED', lastEventSeq: 7 }) }));
  assert.equal(text(q(container, 'wf-display-state')), 'Paused');
  assert.equal(invoked(main, 'workflow:get').length, gets, 'the followed workflow comes from the push itself');
  assert.ok(invoked(main, 'workflow:list').length >= 2, 'the list is re-read because the snapshot changed');
  await unmount();
});

// ---------------------------------------------------------------------------
// security / boundaries
// ---------------------------------------------------------------------------

async function rendererFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await rendererFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('boundaries: the workflow UI only talks to window.aiBridge — no Node, filesystem, processes, Core, hosts, control derivation or journal parsing', async () => {
  const files = (await rendererFiles(path.join(ROOT, 'src', 'desktop', 'renderer'))).filter((f) => /workflow|Workflow/.test(path.basename(f)));
  assert.deepEqual(files.map((f) => path.basename(f)).sort(), ['StartWorkflowDialog.tsx', 'WorkflowDetail.tsx', 'WorkflowHistory.tsx', 'WorkflowView.tsx', 'workflow-summary.ts']);
  for (const file of files) {
    const src = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const rel = path.basename(file);
    for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[2];
      assert.ok(spec === 'react' || spec.startsWith('./') || spec.startsWith('../'), `${rel}: ${spec}`);
      assert.doesNotMatch(spec, /hosts\/|core\/|desktop\/main|node:|electron/, `${rel} imports ${spec}`);
      if (/preload\/bridge-api/.test(spec)) assert.ok(m[1], `${rel}: only the AiBridgeApi TYPE may come from the preload module`);
    }
    assert.doesNotMatch(src, /\brequire\s*\(|(?<![.\w])process\.|child_process|ipcRenderer|deriveWorkflowControls|JSON\.parse/, rel);
    // Controls are only ever read (`c.canPause`) or passed on from another control field
    // (`canStart={panel.canStartNew}`) — never computed (`canPause = x && y`) or constructed (`canPause: true`).
    assert.doesNotMatch(src, /\bcan(Start|Pause|Resume|Stop)\s*=(?![=>])(?!\s*\{?\s*[A-Za-z_]+\.can)|\bcan(Start|Pause|Resume|Stop):\s*(true|false|!)/, `${rel} must not compute a control`);
  }
});
