import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import type { BridgeSnapshot } from '../../../src/desktop/shared/ipc-contract.ts';
import { FakeMain, click, event, flush, makeSnapshot, q, qa, render } from './harness.tsx';

async function renderApp(snapshot: BridgeSnapshot) {
  const main = new FakeMain(snapshot);
  const view = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  return { main, ...view };
}

function buttons(container: HTMLElement) {
  const state = (id: string) => ((q(container, id) as HTMLButtonElement).disabled ? 'off' : 'on');
  return { start: state('btn-start'), pause: state('btn-pause'), resume: state('btn-resume'), stop: state('btn-stop') };
}

const byText = (root: ParentNode, selector: string, text: string) => [...root.querySelectorAll(selector)].find((el) => el.textContent === text);

test('renders Core status, phase, iteration x / max, session and agent activity straight from the snapshot', async () => {
  const { container, unmount } = await renderApp(
    makeSnapshot({
      runAttached: true,
      controls: { canStart: false, canPause: true, canResume: false, stopMode: 'STOP' },
      status: {
        status: 'RUNNING',
        currentPhase: 'CLAUDE_EXECUTING',
        iteration: 3,
        maxIterations: 10,
        activity: { claude: 'EXECUTING', codex: 'WAITING' },
        claude: { pid: 4242, sessionId: 's' },
        startedAt: new Date().toISOString(),
      },
    }),
  );
  try {
    assert.match(q(container, 'run-status')!.textContent!, /RUNNING/);
    assert.equal(q(container, 'run-phase')!.textContent, 'CLAUDE_EXECUTING');
    assert.equal(q(container, 'iteration')!.textContent!.replace(/\s/g, ''), '3/10');
    assert.match(q(container, 'agent-claude')!.textContent!, /EXECUTING.*pid 4242/);
    assert.match(q(container, 'agent-codex')!.textContent!, /WAITING/);
    assert.match(q(container, 'header')!.textContent!, /demo.*2026-09-26_001.*RUNNING/);
    assert.match(q(container, 'elapsed')!.textContent!, /^\d\d:\d\d:\d\d$/);
  } finally {
    await unmount();
  }
});

test('buttons follow snapshot.controls exactly (IDLE / RUNNING / PAUSED / ERROR)', async () => {
  const cases: [BridgeSnapshot, ReturnType<typeof buttons>][] = [
    [makeSnapshot({}), { start: 'on', pause: 'off', resume: 'off', stop: 'off' }],
    [makeSnapshot({ status: { status: 'RUNNING' }, controls: { canStart: false, canPause: true, canResume: false, stopMode: 'STOP' } }), { start: 'off', pause: 'on', resume: 'off', stop: 'on' }],
    [
      makeSnapshot({
        status: { status: 'PAUSED' },
        recovery: { kind: 'RECOVERABLE', runId: 'r', iteration: 1, status: 'PAUSED', strategy: 'CONTINUE_FROM_PROMPT' },
        controls: { canStart: false, canPause: false, canResume: true, stopMode: 'DISCARD' },
      }),
      { start: 'off', pause: 'off', resume: 'on', stop: 'on' },
    ],
    [makeSnapshot({ status: { status: 'ERROR' } }), { start: 'on', pause: 'off', resume: 'off', stop: 'off' }],
  ];
  for (const [snapshot, expected] of cases) {
    const { container, unmount } = await renderApp(snapshot);
    try {
      assert.deepEqual(buttons(container), expected, snapshot.status?.status);
    } finally {
      await unmount();
    }
  }
});

test('a pushed snapshot updates iteration and phase live; clicking PAUSE invokes bridge:pause once', async () => {
  const running = makeSnapshot({ status: { status: 'RUNNING', iteration: 1, maxIterations: 5 }, controls: { canStart: false, canPause: true, canResume: false, stopMode: 'STOP' } });
  const { main, container, unmount } = await renderApp(running);
  try {
    assert.equal(q(container, 'iteration')!.textContent!.replace(/\s/g, ''), '1/5');
    main.pushSnapshot(makeSnapshot({ controls: running.controls, status: { status: 'RUNNING', iteration: 2, maxIterations: 5, currentPhase: 'CODEX_REVIEWING' } }));
    await flush();
    assert.equal(q(container, 'iteration')!.textContent!.replace(/\s/g, ''), '2/5');
    assert.equal(q(container, 'run-phase')!.textContent, 'CODEX_REVIEWING');
    await click(q(container, 'btn-pause'));
    assert.equal(main.invoked.filter((c) => c.channel === 'bridge:pause').length, 1);
  } finally {
    await unmount();
  }
});

test('live events land in the activity log once each, with warning/error rows distinguished', async () => {
  const { main, container, unmount } = await renderApp(makeSnapshot({ status: { status: 'RUNNING' } }));
  try {
    const started = event();
    main.pushEvent(started);
    main.pushEvent(started); // same event twice (e.g. history + live) → shown once
    main.pushEvent(event({ timestamp: '2026-09-26T01:02:04.000Z', event: 'PAUSE_REQUESTED', detail: undefined }));
    main.pushEvent(event({ timestamp: '2026-09-26T01:02:05.000Z', event: 'ERROR', phase: 'ERROR', detail: 'Error during iteration 001' }));
    await flush();
    const rows = qa(container, 'activity-row');
    assert.equal(rows.length, 3);
    assert.match(rows[0].textContent!, /Claude started/);
    assert.ok(rows[1].classList.contains('level-warning'));
    assert.ok(rows[2].classList.contains('level-error'));
  } finally {
    await unmount();
  }
});

test('error state: title and message shown; technical details only after "View details"', async () => {
  const { container, unmount } = await renderApp(
    makeSnapshot({
      status: { status: 'ERROR' },
      lastError: { code: 'REPORT_INVALID', title: 'Report không hợp lệ', message: 'Report của Claude không đúng hợp đồng.', details: 'REPORT_INVALID\nBAD_HEADER: First line must be "# AI Bridge Report"' },
    }),
  );
  try {
    const alert = container.querySelector('[role="alert"]')!;
    assert.match(alert.textContent!, /Report không hợp lệ/);
    assert.doesNotMatch(alert.textContent!, /BAD_HEADER/);
    await click(byText(alert, 'button', 'View details'));
    assert.match(alert.textContent!, /BAD_HEADER/);
  } finally {
    await unmount();
  }
});

test('recovery banner: RECOVERABLE offers RESUME + DISCARD; BLOCKED shows "RECOVERY BLOCKED" and its reason, never RESUME', async () => {
  const recoverable = await renderApp(
    makeSnapshot({
      status: { status: 'INTERRUPTED', iteration: 3 },
      recovery: { kind: 'RECOVERABLE', runId: '2026-09-26_001', iteration: 3, status: 'INTERRUPTED', strategy: 'CONTINUE_FROM_PROMPT' },
      controls: { canStart: false, canPause: false, canResume: true, stopMode: 'DISCARD' },
    }),
  );
  try {
    const banner = q(recoverable.container, 'recovery-banner')!;
    assert.match(banner.textContent!, /Có session chưa hoàn tất.*2026-09-26_001.*3.*RECOVERABLE/);
    await click(q(recoverable.container, 'banner-resume'));
    assert.equal(recoverable.main.invoked.filter((c) => c.channel === 'bridge:resume').length, 1);
  } finally {
    await recoverable.unmount();
  }

  const blocked = await renderApp(
    makeSnapshot({
      status: { status: 'INTERRUPTED', iteration: 1 },
      recovery: { kind: 'BLOCKED', runId: '2026-09-26_001', iteration: 1, status: 'INTERRUPTED', reason: 'Session last known phase was "CLAUDE_EXECUTING"' },
      controls: { canStart: true, canPause: false, canResume: false, stopMode: 'DISCARD' },
    }),
  );
  try {
    const banner = q(blocked.container, 'recovery-banner')!;
    assert.match(banner.textContent!, /RECOVERY BLOCKED.*CLAUDE_EXECUTING/);
    assert.equal(q(blocked.container, 'banner-resume'), null);
    assert.equal((q(blocked.container, 'btn-resume') as HTMLButtonElement).disabled, true);
  } finally {
    await blocked.unmount();
  }
});

test("session history lists Core sessions and opens a session's artifacts (rendered report, exact prompt, state)", async () => {
  const { main, container, unmount } = await renderApp(makeSnapshot({ status: { status: 'DONE', iteration: 1 } }));
  main.handlers.set('bridge:listSessions', () => ({
    ok: true,
    data: [{ runId: '2026-09-26_001', startedAt: '2026-09-26T01:00:00.000Z', endedAt: '2026-09-26T01:05:00.000Z', status: 'DONE', iterations: 1, errorCode: null, recovered: false, isCurrent: true }],
  }));
  const art = (text: string) => ({ path: 'x', text, bytes: text.length, truncated: false, sha256: 'abc'.padEnd(64, '0') });
  main.handlers.set('bridge:getSessionArtifacts', () => ({
    ok: true,
    data: {
      runId: '2026-09-26_001',
      iterations: [
        {
          iteration: 1,
          claudePrompt: art('Create src/sum.js exactly'),
          report: { availability: 'AVAILABLE', source: 'REPORT_FILE', verification: 'VERIFIED', ...art('# AI Bridge Report\n\n## TASK\nDid **it**') },
          codexInput: art('input'),
          codexResponse: art('<AI_BRIDGE_RESPONSE>…'),
          extractedPrompt: art('next'),
          integrity: null,
        },
      ],
      events: [],
      state: { runId: '2026-09-26_001', status: 'DONE' },
    },
  }));
  try {
    await click(q(container, 'nav-sessions'));
    const rows = qa(container, 'session-row');
    assert.equal(rows.length, 1);
    assert.match(rows[0].textContent!, /2026-09-26_001.*demo.*DONE.*1/);
    await click(rows[0]);
    const history = container.querySelector('.history-artifacts')!;
    assert.ok(history.querySelector('.markdown strong'), 'report rendered as markdown');
    assert.match(history.textContent!, /hash verified/);
    await click(byText(history, '[role="tab"]', 'PROMPT'));
    assert.equal(q(history, 'artifact-prompt')!.textContent, 'Create src/sum.js exactly');
    await click(byText(history, '[role="tab"]', 'STATE'));
    assert.match(q(history, 'artifact-state')!.textContent!, /"status": "DONE"/);
  } finally {
    await unmount();
  }
});

test('no project yet: the dashboard asks to pick one via the native picker (Main), never a typed path', async () => {
  const { main, container, unmount } = await renderApp(makeSnapshot({ project: null, status: null, controls: { canStart: false, canPause: false, canResume: false, stopMode: null } }));
  try {
    assert.equal(container.querySelectorAll('input[type="text"]').length, 0);
    await click(byText(container, '.content button', 'Chọn project…'));
    assert.deepEqual(
      main.invoked.filter((c) => c.channel === 'bridge:selectProject'),
      [{ channel: 'bridge:selectProject', args: [] }],
    );
  } finally {
    await unmount();
  }
});
