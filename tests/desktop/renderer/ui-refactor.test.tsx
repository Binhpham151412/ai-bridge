import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalIndex } from '../../../src/core/journal/journal.ts';
import type { SessionArtifacts } from '../../../src/core/session-history/session-history.ts';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import { describeAgent, describeHeadline, roundSteps } from '../../../src/desktop/renderer/lib/run-summary.ts';
import { humanizeEvent, isTechnicalEvent } from '../../../src/desktop/renderer/lib/events-store.ts';
import type { BridgeSnapshot } from '../../../src/desktop/shared/ipc-contract.ts';
import { FakeMain, click, event, flush, makeSnapshot, q, qa, render } from './harness.tsx';
import { change } from './input.ts';

// UI/UX refactor (docs/15): RUN / JOURNAL / ARTIFACTS / SETTINGS / SYSTEM. Every sentence
// on the RUN screen is picked from Core's own status/phase — these tests pin that mapping.

async function renderApp(snapshot: BridgeSnapshot, setup?: (main: FakeMain) => void) {
  const main = new FakeMain(snapshot);
  setup?.(main);
  const view = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  return { main, ...view };
}

const running = (over: Partial<NonNullable<BridgeSnapshot['status']>> = {}) =>
  makeSnapshot({ runAttached: true, controls: { canStart: false, canPause: true, canResume: false, stopMode: 'STOP' }, status: { status: 'RUNNING', iteration: 1, maxIterations: 3, ...over } });

// ---------------------------------------------------------------------------
// run-summary: plain-language text derived only from Core values
// ---------------------------------------------------------------------------

test('describeHeadline: one fixed sentence per Core status/phase; unknown phases fall back to a neutral "Processing…"', () => {
  const s = (status: Partial<NonNullable<BridgeSnapshot['status']>>, rest: Partial<BridgeSnapshot> = {}) => describeHeadline(makeSnapshot({ runAttached: true, ...rest, status }));
  assert.equal(describeHeadline(null).text, 'Connecting to AI Bridge…');
  assert.equal(describeHeadline(makeSnapshot({ project: null, status: null })).text, 'No project selected.');
  assert.equal(s({ status: 'NOT_STARTED' }).text, 'Ready. Start a run to begin.');
  assert.equal(s({ status: 'RUNNING', currentPhase: 'PREFLIGHT' }).text, 'Running pre-flight checks…');
  assert.equal(s({ status: 'RUNNING', currentPhase: 'CLAUDE_EXECUTING', iteration: 1 }).text, 'Claude is working on the task.');
  assert.equal(s({ status: 'RUNNING', currentPhase: 'CLAUDE_EXECUTING', iteration: 3 }).text, 'Claude is working on the changes ChatGPT requested in round 2.');
  assert.equal(s({ status: 'RUNNING', currentPhase: 'REPORT_DETECTED' }).text, 'Claude produced its report — AI Bridge is validating it.');
  assert.equal(s({ status: 'RUNNING', currentPhase: 'CODEX_REVIEWING' }).text, "ChatGPT is reviewing Claude's report.");
  assert.equal(s({ status: 'RUNNING', currentPhase: 'SOMETHING_NEW' }).text, 'Processing…');
  assert.equal(s({ status: 'RUNNING', currentPhase: 'CLAUDE_EXECUTING' }, { pauseRequested: true }).note, 'Pause requested — AI Bridge will pause at the next safe point.');
  assert.match(s({ status: 'RUNNING' }, { runAttached: false }).note!, /managed by another process/);
  assert.deepEqual(s({ status: 'DONE' }), { text: 'Run completed — ChatGPT marked the work as done.', note: null, tone: 'success' });
  assert.equal(s({ status: 'NEED_HUMAN' }).text, 'Run stopped — ChatGPT asked for a human decision.');
  assert.equal(s({ status: 'STOPPED_MAX_ITERATIONS' }).text, 'Run stopped — the maximum number of review rounds was reached.');
  assert.equal(s({ status: 'STOPPED' }).text, 'Run stopped.');
  assert.deepEqual(s({ status: 'ERROR' }, { lastError: { code: 'X', title: 'Claude CLI lỗi', message: 'm' } }), { text: 'Run failed.', note: 'Claude CLI lỗi', tone: 'danger' });
  // After a restart there is no lastError: the note comes from the session's own final event.
  assert.equal(describeHeadline(makeSnapshot({ status: { status: 'ERROR' } }), 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT').note, 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT');
  assert.equal(describeHeadline(makeSnapshot({ status: { status: 'ERROR' }, lastError: { code: 'X', title: 'T', message: 'm' } }), 'CODE').note, 'T', 'lastError wins over the event detail');
  assert.equal(describeHeadline(makeSnapshot({ status: { status: 'STOPPED' } }), 'Stopped by user (UI)').note, 'Stopped by user (UI)');
  assert.equal(describeHeadline(makeSnapshot({ status: { status: 'DONE' } }), 'ignored').note, null);
  assert.equal(s({ status: 'PAUSED' }, { recovery: { kind: 'RECOVERABLE', runId: 'r', iteration: 1, status: 'PAUSED', strategy: 'CONTINUE_FROM_PROMPT' } }).note, 'Resume to continue from the last safe point.');
  assert.equal(s({ status: 'INTERRUPTED' }, { recovery: { kind: 'BLOCKED', runId: 'r', iteration: 1, status: 'INTERRUPTED', reason: 'x' } }).note, 'It cannot be resumed — see the reason above.');
});

test('describeAgent / roundSteps follow Core activity + phase; the stepper exists only while RUNNING inside a round', () => {
  const snap = (phase: string, activity: { claude: 'IDLE' | 'WAITING' | 'EXECUTING'; codex: 'IDLE' | 'WAITING' | 'REVIEWING' }) => running({ currentPhase: phase, iteration: 2, activity });
  assert.deepEqual(describeAgent('claude', snap('CLAUDE_EXECUTING', { claude: 'EXECUTING', codex: 'WAITING' })), { label: 'Working', raw: 'EXECUTING', detail: 'Working on round 2' });
  assert.equal(describeAgent('codex', snap('CLAUDE_EXECUTING', { claude: 'EXECUTING', codex: 'WAITING' })).detail, "Waiting for Claude's report");
  assert.equal(describeAgent('claude', snap('CODEX_REVIEWING', { claude: 'WAITING', codex: 'REVIEWING' })).detail, "Waiting for ChatGPT's review");
  assert.equal(describeAgent('codex', snap('CODEX_REVIEWING', { claude: 'WAITING', codex: 'REVIEWING' })).detail, "Reviewing Claude's report for round 2");
  assert.deepEqual(describeAgent('claude', makeSnapshot({ status: { status: 'DONE' } })), { label: 'Idle', raw: 'IDLE', detail: 'Not running' });

  const states = (phase: string) => roundSteps(running({ currentPhase: phase }))!.map((s) => s.state);
  assert.deepEqual(states('CLAUDE_EXECUTING'), ['active', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('REPORT_DETECTED'), ['done', 'active', 'todo', 'todo']);
  assert.deepEqual(states('CODEX_REVIEWING'), ['done', 'done', 'active', 'todo']);
  assert.deepEqual(states('RESPONSE_PARSED'), ['done', 'done', 'done', 'done']);
  assert.equal(roundSteps(running({ currentPhase: 'PREFLIGHT' })), null);
  assert.equal(roundSteps(makeSnapshot({ status: { status: 'DONE', currentPhase: 'DONE' } })), null);
});

test('the plain feed hides pipe-level events and words the rest for people; levels match the technical log', () => {
  assert.equal(isTechnicalEvent(event({ event: 'PROMPT_PERSISTED' })), true);
  assert.equal(isTechnicalEvent(event({ event: 'CODEX_PROCESS_STARTED' })), true);
  assert.equal(isTechnicalEvent(event({ event: 'CLAUDE_STARTED' })), false);
  assert.deepEqual(humanizeEvent(event()), { label: 'Claude started working', level: 'normal', detail: null });
  assert.equal(humanizeEvent(event({ event: 'REPORT_DETECTED' })).label, 'Report generated');
  assert.deepEqual(humanizeEvent(event({ event: 'CODEX_EXITED', detail: 'Codex CLI exited — exit code 1, 5ms — error' })), {
    label: 'ChatGPT (Codex) exited with an error',
    level: 'error',
    detail: 'Codex CLI exited — exit code 1, 5ms — error',
  });
  assert.equal(humanizeEvent(event({ event: 'CLAUDE_SESSION_RESUMED', continuity: 'MISMATCH' })).label, 'Claude session continuity not verified');
  assert.equal(humanizeEvent(event({ event: 'RUN_COMPLETED', phase: 'NEED_HUMAN' })).label, 'Run ended (NEED_HUMAN)');
});

// ---------------------------------------------------------------------------
// RUN screen states
// ---------------------------------------------------------------------------

const JOURNAL: JournalIndex = {
  runId: '2026-09-26_001',
  status: 'RUNNING',
  maxIterations: 3,
  rounds: [
    { iteration: 1, state: 'COMPLETED', verdict: 'CONTINUE', available: ['CLAUDE_PROMPT', 'CLAUDE_REPORT', 'CHATGPT_REVIEW', 'NEXT_PROMPT'] },
    { iteration: 2, state: 'RUNNING', verdict: null, available: ['CLAUDE_PROMPT'] },
  ],
  hasSessionIndex: false,
  hasFinalReport: false,
};

test('RUNNING: status, round, activity sentence, agents, live stepper and the rounds so far', async () => {
  const { container, unmount } = await renderApp(running({ iteration: 2, currentPhase: 'CODEX_REVIEWING', activity: { claude: 'WAITING', codex: 'REVIEWING' } }), (m) =>
    m.handlers.set('bridge:getJournal', () => ({ ok: true, data: JOURNAL })),
  );
  try {
    assert.match(q(container, 'run-status')!.textContent!, /Running/);
    assert.equal(q(container, 'iteration')!.textContent!.replace(/\s/g, ''), 'Round2/3');
    assert.equal(q(container, 'run-activity')!.textContent, "ChatGPT is reviewing Claude's report.");
    assert.ok(q(container, 'agent-codex')!.classList.contains('agent-active'));
    assert.ok(!q(container, 'agent-claude')!.classList.contains('agent-active'));
    const steps = [...q(container, 'round-steps')!.querySelectorAll('li')].map((li) => `${li.textContent}:${li.className.replace('stepper-step ', '')}`);
    assert.deepEqual(steps, ['Claude works:step-done', 'Report validated:step-done', 'ChatGPT reviews:step-active', 'Verdict:step-todo']);
    const chips = qa(container, 'round-chip');
    assert.equal(chips.length, 2);
    assert.match(chips[0].getAttribute('aria-label')!, /Round 1, Completed, ChatGPT: continue/);
    assert.ok(chips[1].classList.contains('current'));
  } finally {
    await unmount();
  }
});

test('DONE: success sentence, idle agents, the last round outcome from the journal (no stepper), START enabled', async () => {
  const done: JournalIndex = { ...JOURNAL, status: 'DONE', rounds: [JOURNAL.rounds[0], { iteration: 2, state: 'COMPLETED', verdict: 'DONE', available: ['CLAUDE_PROMPT', 'CLAUDE_REPORT', 'CHATGPT_REVIEW'] }] };
  const { container, unmount } = await renderApp(makeSnapshot({ status: { status: 'DONE', iteration: 2, maxIterations: 3, currentPhase: 'DONE' } }), (m) =>
    m.handlers.set('bridge:getJournal', () => ({ ok: true, data: done })),
  );
  try {
    assert.match(q(container, 'run-status')!.textContent!, /Completed/);
    assert.equal(q(container, 'run-activity')!.textContent, 'Run completed — ChatGPT marked the work as done.');
    assert.ok(q(container, 'run-activity')!.classList.contains('text-success'));
    assert.match(q(container, 'agent-claude')!.textContent!, /Idle.*Not running/);
    assert.equal(q(container, 'round-steps'), null);
    assert.match(q(container, 'round-outcome')!.textContent!, /Completed.*Round 2 · ChatGPT: done/);
    assert.equal((q(container, 'btn-start') as HTMLButtonElement).disabled, false);
  } finally {
    await unmount();
  }
});

test('PAUSED: paused sentence with the resume hint, RESUME enabled, PAUSE disabled', async () => {
  const { container, unmount } = await renderApp(
    makeSnapshot({
      status: { status: 'PAUSED', iteration: 1, currentPhase: 'PAUSED' },
      recovery: { kind: 'RECOVERABLE', runId: '2026-09-26_001', iteration: 1, status: 'PAUSED', strategy: 'CONTINUE_FROM_PROMPT' },
      controls: { canStart: false, canPause: false, canResume: true, stopMode: 'DISCARD' },
    }),
  );
  try {
    assert.match(q(container, 'run-status')!.textContent!, /Paused/);
    assert.equal(q(container, 'run-activity')!.textContent, 'Run paused.');
    assert.equal(q(container, 'run-activity-note')!.textContent, 'Resume to continue from the last safe point.');
    assert.equal((q(container, 'btn-resume') as HTMLButtonElement).disabled, false);
    assert.equal((q(container, 'btn-pause') as HTMLButtonElement).disabled, true);
    assert.ok(q(container, 'recovery-banner'));
  } finally {
    await unmount();
  }
});

test('ERROR: failure sentence carries the error title; the error panel keeps technical details folded', async () => {
  const { container, unmount } = await renderApp(
    makeSnapshot({ status: { status: 'ERROR', iteration: 2 }, lastError: { code: 'CLAUDE_RUN_FAILED', title: 'Claude CLI thất bại', message: 'Exit code 1', details: 'Exit code: 1\nBridge session: 2026-09-26_001' } }),
  );
  try {
    assert.equal(q(container, 'run-activity')!.textContent, 'Run failed.');
    assert.equal(q(container, 'run-activity-note')!.textContent, 'Claude CLI thất bại');
    assert.ok(q(container, 'run-activity')!.classList.contains('text-danger'));
    const alert = container.querySelector('[role="alert"]')!;
    assert.doesNotMatch(alert.textContent!, /Bridge session:/);
  } finally {
    await unmount();
  }
});

test('RUN feed shows only milestone events of the current session; the full technical log sits under Technical output', async () => {
  const { main, container, unmount } = await renderApp(running());
  try {
    main.pushEvents([
      event({ timestamp: '2026-09-26T01:02:01.000Z', event: 'PROMPT_PERSISTED', detail: 'Claude prompt persisted — 001-claude-prompt.md, 42 bytes' }),
      event({ timestamp: '2026-09-26T01:02:02.000Z', event: 'CLAUDE_PROCESS_STARTED', detail: 'pid 4242' }),
      event({ timestamp: '2026-09-26T01:02:03.000Z' }),
      event({ timestamp: '2026-09-26T01:02:04.000Z', runId: '2026-09-25_009', event: 'RUN_COMPLETED', phase: 'DONE' }),
    ]);
    await flush();
    const feed = qa(container, 'activity-row');
    assert.equal(feed.length, 1, 'technical events and other sessions stay out of the plain feed');
    assert.match(feed[0].textContent!, /Claude started working.*Round 1/);
    await click(q(container, 'tech-output-toggle'));
    const log = qa(q(container, 'tech-output')!, 'activity-row').map((r) => r.textContent ?? '');
    assert.equal(log.length, 3, 'every event of this session is still available');
    assert.match(log[0], /Claude prompt persisted.*001-claude-prompt\.md/);
    assert.match(log[1], /Claude CLI started.*pid 4242/);
  } finally {
    await unmount();
  }
});

test('RUN → Technical output: raw stdout/stderr of the current round per agent, loaded on demand, searchable', async () => {
  const data: SessionArtifacts = {
    runId: '2026-09-26_001',
    events: [],
    state: null,
    iterations: [
      {
        iteration: 1,
        claudePrompt: null,
        report: { availability: 'MISSING', path: 'r', note: 'n' },
        codexInput: null,
        codexResponse: null,
        extractedPrompt: null,
        integrity: null,
        claudeExecution: null,
        codexExecution: {
          effectiveStatus: 'COMPLETED',
          record: {
            schema: 1,
            agent: 'codex',
            iteration: 1,
            bridgeSessionId: '2026-09-26_001',
            mode: 'NEW',
            cliSessionId: { requested: null, reported: 't-1', evidence: 'CONFIRMED_BY_CLI' },
            continuity: { expected: null, reported: null, verdict: 'NOT_APPLICABLE', note: '' },
            input: { file: '001-codex-input.md', sha256: 'a'.repeat(64), bytes: 5, delivery: 'STDIN_FLUSHED_AND_CLOSED', deliveredAt: null, deliveryError: null },
            process: { pid: 77, startedAt: null, endedAt: null, durationMs: 65000, exitCode: 0, signal: null, timedOut: false },
            status: 'COMPLETED',
            errorCode: null,
            output: { kind: 'CLI_OUTPUT', stdoutFile: 'o', stdoutBytes: 2048, stdoutTruncated: false, stderrFile: 'e', stderrBytes: 0, stderrTruncated: false },
            command: { executable: 'codex.exe', args: ['exec', '--json'] },
            updatedAt: '2026-09-26T01:00:00.000Z',
          },
        },
        codexVerdict: 'CONTINUE',
      },
    ],
  };
  const { main, container, unmount } = await renderApp(makeSnapshot({ status: { status: 'ERROR', iteration: 1 } }), (m) => {
    m.handlers.set('bridge:getSessionArtifacts', () => ({ ok: true, data }));
    m.handlers.set('bridge:getExecutionOutput', () => ({ ok: true, data: { path: 'o', text: '{"type":"thread.started"}\n{"type":"turn.completed"}', bytes: 50, truncated: true } }));
  });
  try {
    await click(q(container, 'tech-output-toggle'));
    const out = q(container, 'tech-output')!;
    assert.match(out.textContent!, /Không có execution record cho bước này/, 'Claude tab: no record → said plainly, no output buttons');
    assert.equal(q(out, 'cli-output-claude'), null);
    await click(q(out, 'tech-output-codex'));
    assert.match(out.textContent!, /codex\.exe exec --json.*0.*00:01:05.*2\.0 KB/);
    assert.equal(main.invoked.filter((c) => c.channel === 'bridge:getExecutionOutput').length, 0, 'raw output is not fetched until asked for');
    await click(q(out, 'cli-codex-stdout'));
    assert.deepEqual(main.invoked.find((c) => c.channel === 'bridge:getExecutionOutput')?.args, [{ runId: '2026-09-26_001', iteration: 1, agent: 'codex', stream: 'stdout' }]);
    assert.match(out.textContent!, /chỉ hiển thị phần cuối \(256 KB\).*đã che thông tin nhạy cảm/);
    await change(q(out, 'cli-codex-search'), 'turn');
    assert.match(q(out, 'exec-output-filtered')!.textContent!, /2 {2}\{"type":"turn\.completed"\}/);
  } finally {
    await unmount();
  }
});

test('a round chip on RUN opens that round in JOURNAL (session picker + round detail)', async () => {
  const { container, unmount } = await renderApp(running({ iteration: 2, currentPhase: 'CLAUDE_EXECUTING', activity: { claude: 'EXECUTING', codex: 'WAITING' } }), (m) => {
    m.handlers.set('bridge:getJournal', () => ({ ok: true, data: JOURNAL }));
    m.handlers.set('bridge:listSessions', () => ({
      ok: true,
      data: [{ runId: '2026-09-26_001', startedAt: null, endedAt: null, status: 'RUNNING', iterations: 2, errorCode: null, recovered: false, isCurrent: true, claudeSessionId: null, codexThreadId: null }],
    }));
  });
  try {
    await click(qa(container, 'round-chip')[0]);
    assert.equal(q(container, 'nav-journal')!.getAttribute('aria-current'), 'page');
    assert.ok(q(container, 'session-select'));
    assert.match(q(container, 'round-detail')!.textContent!, /Round 1.*Completed.*ChatGPT: continue/);
    assert.equal(qa(container, 'journal-round-pending').length, 1, 'round 3 of 3 is still pending while the run continues');
  } finally {
    await unmount();
  }
});

test('SYSTEM groups the doctor by Claude Code / ChatGPT-Codex / Project / Environment and shows the app runtime; SETTINGS holds configuration only', async () => {
  const { container, unmount } = await renderApp(makeSnapshot({}), (m) => {
    m.handlers.set('bridge:doctor', () => ({
      ok: true,
      data: {
        overall: 'PASS',
        checks: [
          { name: 'node', status: 'PASS', detail: 'v22.18.0' },
          { name: 'claude-cli', status: 'PASS', detail: 'C:\\bin\\claude.exe' },
          { name: 'claude-auth', status: 'PASS', detail: 'logged in with a Claude subscription' },
          { name: 'codex-auth', status: 'PASS', detail: 'logged in using ChatGPT' },
          { name: 'git-repository', status: 'WARNING', detail: 'WARNING_UNCOMMITTED_CHANGES' },
        ],
      },
    }));
    m.handlers.set('bridge:getSettings', () => ({ ok: true, data: { app: { defaultProjectPath: null }, project: null, logs: { maxFileBytes: 10 * 1024 * 1024 } } }));
  });
  try {
    await click(q(container, 'nav-system'));
    assert.ok(q(container, 'runtime'));
    assert.match(container.textContent!, /10\.0 MB/);
    await click(q(container, 'btn-doctor'));
    const groups = [...q(container, 'doctor-table')!.querySelectorAll('.doctor-group')].map((g) => g.textContent);
    assert.deepEqual(groups, ['Claude Code', 'ChatGPT / Codex', 'Project', 'Environment']);
    await click(q(container, 'nav-settings'));
    const titles = [...container.querySelectorAll('.card-head h2')].map((h) => h.textContent);
    assert.deepEqual(titles, ['Project', 'Run configuration (.ai-bridge/config.json)']);
  } finally {
    await unmount();
  }
});
