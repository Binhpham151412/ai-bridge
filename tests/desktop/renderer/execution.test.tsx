import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionRecord } from '../../../src/core/execution/execution-record.ts';
import type { JournalIndex } from '../../../src/core/journal/journal.ts';
import type { SessionArtifacts } from '../../../src/core/session-history/session-history.ts';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { ArtifactViewer } from '../../../src/desktop/renderer/components/ArtifactViewer.tsx';
import { JournalPanel } from '../../../src/desktop/renderer/components/JournalPanel.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import { FakeMain, click, makeSnapshot, q, qa, render } from './harness.tsx';
import { change } from './input.ts';

const CLAUDE_ID = '846af024-e8ed-4f81-80dc-cc6276728abc';
const SHA = 'b'.repeat(64);

function record(over: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    schema: 1,
    agent: 'claude',
    iteration: 1,
    bridgeSessionId: '2026-09-26_002',
    mode: 'NEW',
    cliSessionId: { requested: CLAUDE_ID, reported: CLAUDE_ID, evidence: 'CONFIRMED_BY_CLI' },
    continuity: { expected: null, reported: null, verdict: 'NOT_APPLICABLE', note: 'Fresh session — nothing to continue.' },
    input: { file: '001-claude-prompt.md', sha256: SHA, bytes: 42, delivery: 'STDIN_FLUSHED_AND_CLOSED', deliveredAt: '2026-09-26T03:53:20.100Z', deliveryError: null },
    process: { pid: 12345, startedAt: '2026-09-26T03:53:20.000Z', endedAt: '2026-09-26T03:56:53.000Z', durationMs: 213000, exitCode: 1, signal: null, timedOut: false },
    status: 'FAILED',
    errorCode: 'NON_ZERO_EXIT',
    output: { kind: 'CLI_OUTPUT', stdoutFile: '001-claude-stdout.jsonl', stdoutBytes: 10, stdoutTruncated: false, stderrFile: '001-claude-stderr.log', stderrBytes: 20, stderrTruncated: false },
    command: { executable: 'claude.exe', args: ['-p'] },
    updatedAt: '2026-09-26T03:56:53.000Z',
    ...over,
  };
}

const art = (text: string, sha = 'c'.repeat(64), path = 'x') => ({ path, text, bytes: text.length, truncated: false, sha256: sha });

function artifacts(): SessionArtifacts {
  return {
    runId: '2026-09-26_002',
    events: [],
    state: null,
    iterations: [
      {
        iteration: 1,
        claudePrompt: art('Do the exact thing', SHA, 'D:\\p\\.ai-bridge\\sessions\\2026-09-26_002\\001-claude-prompt.md'),
        report: { availability: 'MISSING', path: 'D:\\p\\.ai-bridge\\sessions\\2026-09-26_002\\001-claude-report.md', note: 'n' },
        codexInput: null,
        codexResponse: null,
        extractedPrompt: null,
        integrity: null,
        claudeExecution: { record: record(), effectiveStatus: 'FAILED' },
        codexExecution: null,
        codexVerdict: null,
      },
      {
        iteration: 2,
        claudePrompt: art('next', 'd'.repeat(64), 'D:\\p\\.ai-bridge\\sessions\\2026-09-26_002\\002-claude-prompt.md'),
        report: { availability: 'MISSING', path: 'D:\\p\\.ai-bridge\\sessions\\2026-09-26_002\\002-claude-report.md', note: 'n' },
        codexInput: null,
        codexResponse: null,
        extractedPrompt: null,
        integrity: null,
        claudeExecution: {
          record: record({
            iteration: 2,
            mode: 'RESUME',
            input: { ...record().input, sha256: 'd'.repeat(64), file: '002-claude-prompt.md' },
            cliSessionId: { requested: CLAUDE_ID, reported: null, evidence: 'REQUESTED_NOT_CONFIRMED' },
            continuity: { expected: CLAUDE_ID, reported: null, verdict: 'UNKNOWN', note: 'The CLI did not report a session id in its output, so continuity cannot be proven.' },
          }),
          effectiveStatus: 'INTERRUPTED',
        },
        codexExecution: null,
        codexVerdict: null,
      },
    ],
  };
}

async function renderViewer(data: SessionArtifacts = artifacts(), journal?: JournalIndex) {
  const main = new FakeMain(makeSnapshot({ status: { status: 'ERROR' } }));
  main.handlers.set('bridge:getSessionArtifacts', () => ({ ok: true, data }));
  if (journal) main.handlers.set('bridge:getJournal', () => ({ ok: true, data: journal }));
  main.handlers.set('bridge:getExecutionOutput', (req) => {
    const r = req as { stream: string };
    return { ok: true, data: { path: 'x', text: r.stream === 'stderr' ? 'Error: API overloaded (529)\nsecond line' : '{"type":"result"}', bytes: 27, truncated: false } };
  });
  const view = await render(
    <BridgeProvider api={main.api}>
      <ArtifactViewer runId="2026-09-26_002" />
    </BridgeProvider>,
  );
  return { main, ...view };
}

/** A file in the ARTIFACTS tree, by its stable key (e.g. "exec-claude:1"). */
const item = (root: ParentNode, key: string) => root.querySelector(`[data-testid="artifact-item"][data-key="${key}"]`);

test('ARTIFACTS tree groups the session files (Reports / Prompts / Technical) using real file names', async () => {
  const { container, unmount } = await renderViewer();
  try {
    const groups = [...container.querySelectorAll('.tree-title')].map((h) => h.textContent);
    assert.deepEqual(groups, ['Reports', 'Prompts', 'Technical']);
    assert.match(item(container, 'report:1')!.textContent!, /001-claude-report\.md.*missing/);
    assert.match(item(container, 'prompt:2')!.textContent!, /002-claude-prompt\.md/);
    assert.ok(item(container, 'exec-claude:1'));
    assert.equal(item(container, 'exec-codex:1'), null, 'no Codex execution record → no Codex execution file listed');
  } finally {
    await unmount();
  }
});

test('Claude execution shows bridge session, confirmed Claude CLI session, pid, exit code, prompt SHA/bytes and an evidence-based lifecycle', async () => {
  const { container, unmount } = await renderViewer();
  try {
    await click(item(container, 'exec-claude:1'));
    const panel = q(container, 'exec-claude')!;
    assert.match(panel.textContent!, /2026-09-26_002/);
    assert.equal(q(panel, 'exec-cli-session')!.textContent, CLAUDE_ID);
    assert.match(panel.textContent!, /CLI xác nhận/);
    assert.match(q(panel, 'exec-exit-code')!.textContent!, /1 \(NON_ZERO_EXIT\)/);
    assert.equal(q(panel, 'exec-sha')!.textContent, SHA);
    const steps = qa(panel, 'exec-step').map((s) => s.textContent ?? '');
    assert.match(steps[0], /PROMPT PERSISTED.*khớp SHA-256/);
    assert.match(steps[1], /CLAUDE PROCESS STARTED.*pid 12345/);
    assert.match(steps[2], /PROMPT WRITTEN TO CLAUDE STDIN.*không chứng minh CLI đã đọc/);
    assert.match(steps[4], /CLAUDE FAILED.*exit code 1/);
    assert.match(panel.textContent!, /Claude Desktop không phải là nguồn trạng thái/);
  } finally {
    await unmount();
  }
});

test('VIEW STDERR / VIEW CLI OUTPUT fetch the redacted tail over the dedicated IPC call (labelled CLI output, not transcript); search filters lines', async () => {
  const { main, container, unmount } = await renderViewer();
  try {
    await click(item(container, 'exec-claude:1'));
    await click(q(container, 'exec-view-stderr'));
    assert.equal(q(container, 'exec-output')!.textContent, 'Error: API overloaded (529)\nsecond line');
    assert.deepEqual(main.invoked.find((c) => c.channel === 'bridge:getExecutionOutput')?.args, [{ runId: '2026-09-26_002', iteration: 1, agent: 'claude', stream: 'stderr' }]);
    await change(q(container, 'cli-claude-search'), 'overloaded');
    assert.match(q(container, 'exec-output-filtered')!.textContent!, /^\s+1 {2}Error: API overloaded \(529\)$/);
    assert.match(container.textContent!, /1 dòng khớp/);
    await click(q(container, 'exec-view-stdout'));
    assert.match(container.textContent!, /CLI output \(stdout — luồng event của CLI, không phải transcript/);
  } finally {
    await unmount();
  }
});

const JOURNAL: JournalIndex = {
  runId: '2026-09-26_002',
  status: 'DONE',
  maxIterations: 3,
  rounds: [
    { iteration: 1, state: 'COMPLETED', verdict: 'CONTINUE', available: ['CLAUDE_REPORT', 'CHATGPT_REVIEW', 'CLAUDE_PROMPT', 'NEXT_PROMPT', 'RAW_CODEX_RESPONSE'] },
    { iteration: 2, state: 'COMPLETED', verdict: 'DONE', available: ['CLAUDE_REPORT', 'CHATGPT_REVIEW', 'CLAUDE_PROMPT', 'RAW_CODEX_RESPONSE'] },
  ],
  hasSessionIndex: true,
  hasFinalReport: true,
};

async function renderJournal(journal: JournalIndex = JOURNAL) {
  const main = new FakeMain(makeSnapshot({ status: { status: 'DONE' } }));
  main.handlers.set('bridge:getJournal', () => ({ ok: true, data: journal }));
  main.handlers.set('bridge:getJournalEntry', (req) => {
    const r = req as { kind: string; iteration?: number };
    return { ok: true, data: { path: `${r.iteration ?? 'session'}-${r.kind}.md`, text: `# ${r.kind} ${r.iteration ?? ''}`, bytes: 10, truncated: false, sha256: 'e'.repeat(64) } };
  });
  const view = await render(
    <BridgeProvider api={main.api}>
      <JournalPanel runId="2026-09-26_002" />
    </BridgeProvider>,
  );
  return { main, ...view };
}

test('JOURNAL lists rounds + FINAL REPORT and lazily loads exactly the selected entry', async () => {
  const { main, container, unmount } = await renderJournal();
  try {
    assert.ok(q(container, 'journal-list'));
    assert.ok(q(container, 'journal-session-index'));
    assert.ok(q(container, 'journal-final-report'));
    assert.equal(qa(container, 'journal-round').length, 2);
    assert.equal(qa(container, 'journal-round-pending').length, 0, 'a finished session lists no pending rounds');
    // Before any selection, nothing has been fetched for an individual entry yet.
    assert.equal(main.invoked.filter((c) => c.channel === 'bridge:getJournalEntry').length, 0, 'lazy load: no entry is fetched until picked');
    await click(q(container, 'journal-item-CLAUDE_REPORT'));
    assert.match(q(container, 'journal-body')!.textContent!, /CLAUDE_REPORT/);
    assert.deepEqual(main.invoked.find((c) => c.channel === 'bridge:getJournalEntry')?.args, [{ runId: '2026-09-26_002', kind: 'CLAUDE_REPORT', iteration: 1 }]);
    assert.equal(main.invoked.filter((c) => c.channel === 'bridge:getJournalEntry').length, 1, 'exactly one entry fetched, not the whole session');
    await click(q(container, 'journal-final-report'));
    const entryCalls = main.invoked.filter((c) => c.channel === 'bridge:getJournalEntry');
    assert.deepEqual(entryCalls[entryCalls.length - 1].args, [{ runId: '2026-09-26_002', kind: 'FINAL_REPORT' }]);
  } finally {
    await unmount();
  }
});

test('JOURNAL round detail: state + verdict, one View per entry (prompt → report → review → next prompt), missing next prompt explained', async () => {
  const { main, container, unmount } = await renderJournal();
  try {
    // Default: the latest round's detail — a listing only, nothing fetched.
    const detail = q(container, 'round-detail')!;
    assert.match(detail.textContent!, /Round 2.*Completed.*ChatGPT: done/);
    assert.equal((q(detail, 'round-view-NEXT_PROMPT') as HTMLButtonElement).disabled, true);
    assert.match(detail.textContent!, /reviewer đã kết thúc run ở round này/);
    const names = [...detail.querySelectorAll('.entry-name')].map((e) => e.textContent);
    assert.deepEqual(names, ['Claude Prompt', 'Claude Report', 'ChatGPT Review', 'Next Prompt', 'Raw ChatGPT Response']);
    // Clicking a round header shows that round.
    await click(qa(container, 'journal-round-head')[0]);
    assert.match(q(container, 'round-detail')!.textContent!, /Round 1.*ChatGPT: continue/);
    await click(q(container, 'round-view-CHATGPT_REVIEW'));
    assert.match(q(container, 'journal-body')!.textContent!, /Round 1.*ChatGPT Review.*CHATGPT_REVIEW 1/);
    assert.deepEqual(
      main.invoked.filter((c) => c.channel === 'bridge:getJournalEntry').map((c) => c.args[0]),
      [{ runId: '2026-09-26_002', kind: 'CHATGPT_REVIEW', iteration: 1 }],
    );
  } finally {
    await unmount();
  }
});

test('JOURNAL shows upcoming rounds as Pending only while the session can still continue', async () => {
  const { container, unmount } = await renderJournal({
    ...JOURNAL,
    status: 'RUNNING',
    maxIterations: 10,
    rounds: [{ ...JOURNAL.rounds[0] }, { iteration: 2, state: 'RUNNING', verdict: null, available: ['CLAUDE_PROMPT'] }],
    hasFinalReport: false,
  });
  try {
    const pending = qa(container, 'journal-round-pending');
    assert.deepEqual(
      pending.map((p) => p.textContent),
      ['○Round 3Pending', '○Round 4Pending', '○Round 5Pending'],
    );
    assert.match(container.textContent!, /tối đa đến round 10/);
  } finally {
    await unmount();
  }
});

test('Reviews: the readable ChatGPT review (journal) and the raw response are separate entries; the next prompt is under Prompts', async () => {
  const data = artifacts();
  data.iterations[0] = {
    ...data.iterations[0],
    codexResponse: art('<AI_BRIDGE_RESPONSE>raw', 'f'.repeat(64), 'C:\\s\\001-codex-response.md'),
    extractedPrompt: art('Please fix X', '1'.repeat(64), 'C:\\s\\001-extracted-prompt.md'),
  };
  const { main, container, unmount } = await renderViewer(data, JOURNAL);
  main.handlers.set('bridge:getJournalEntry', () => ({ ok: true, data: { path: '001-review.md', text: '# ChatGPT Review\n\nSome human-readable review text.', bytes: 10, truncated: false, sha256: 'f'.repeat(64) } }));
  try {
    const groups = [...container.querySelectorAll('.tree-title')].map((h) => h.textContent);
    assert.deepEqual(groups, ['Final', 'Reports', 'Reviews', 'Prompts', 'Technical']);
    await click(item(container, 'response:1'));
    assert.equal(q(container, 'artifact-response')!.textContent, '<AI_BRIDGE_RESPONSE>raw');
    await click(item(container, 'review:1'));
    assert.match(container.textContent!, /Some human-readable review text\./);
    assert.deepEqual(main.invoked.find((c) => c.channel === 'bridge:getJournalEntry')?.args, [{ runId: '2026-09-26_002', kind: 'CHATGPT_REVIEW', iteration: 1 }]);
    await click(item(container, 'next:1'));
    assert.equal(q(container, 'artifact-next-prompt')!.textContent, 'Please fix X');
    assert.match(item(container, 'next:1')!.textContent!, /001-extracted-prompt\.md/);
  } finally {
    await unmount();
  }
});

test('a resumed call whose session the CLI never confirmed shows continuity UNKNOWN and an INTERRUPTED status — nothing faked', async () => {
  const { container, unmount } = await renderViewer();
  try {
    await click(item(container, 'exec-claude:2'));
    const panel = q(container, 'exec-claude')!;
    assert.match(q(panel, 'exec-continuity')!.textContent!, /Session continuity: UNKNOWN/);
    assert.match(panel.textContent!, /CHƯA xác nhận/);
    assert.match(panel.textContent!, /INTERRUPTED/);
  } finally {
    await unmount();
  }
});

test('RUN technical details: a round without a Codex execution record says so honestly (no fabricated execution)', async () => {
  const main = new FakeMain(makeSnapshot({ status: { runId: '2026-09-26_002', status: 'ERROR', iteration: 1, claude: { pid: null, sessionId: CLAUDE_ID } } }));
  main.handlers.set('bridge:getSessionArtifacts', () => ({ ok: true, data: artifacts() }));
  const { container, unmount } = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  try {
    assert.equal(q(container, 'tech-details'), null, 'technical details are collapsed by default');
    assert.equal(main.invoked.filter((c) => c.channel === 'bridge:getSessionArtifacts').length, 0, 'nothing technical is fetched while collapsed');
    await click(q(container, 'tech-details-toggle'));
    const tech = q(container, 'tech-details')!;
    assert.equal(q(tech, 'claude-session-id')!.textContent, CLAUDE_ID, 'the Claude CLI session is shown separately');
    assert.equal(q(tech, 'claude-pid')!.textContent, '—', 'no PID for an agent Core does not report as active');
    assert.ok(q(tech, 'exec-claude'));
    assert.match(tech.textContent!, /Không có execution record của Codex/);
  } finally {
    await unmount();
  }
});

test('ARTIFACTS view: session facts carry the Claude CLI session; the execution trace lists one row per iteration and opens its Claude execution', async () => {
  const main = new FakeMain(makeSnapshot({ status: { runId: '2026-09-26_002', status: 'ERROR', claude: { pid: null, sessionId: CLAUDE_ID } } }));
  main.handlers.set('bridge:listSessions', () => ({
    ok: true,
    data: [
      {
        runId: '2026-09-26_002',
        startedAt: null,
        endedAt: null,
        status: 'ERROR',
        iterations: 2,
        errorCode: 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT',
        recovered: false,
        isCurrent: true,
        claudeSessionId: CLAUDE_ID,
        codexThreadId: null,
      },
    ],
  }));
  main.handlers.set('bridge:getSessionArtifacts', () => ({ ok: true, data: artifacts() }));
  const { container, unmount } = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  try {
    await click(q(container, 'nav-artifacts'));
    const facts = q(container, 'session-facts')!;
    assert.equal(q(facts, 'facts-claude-session')!.textContent, CLAUDE_ID);
    assert.match(facts.textContent!, /CLAUDE_RUN_FAILED:NON_ZERO_EXIT/);
    assert.match(q(container, 'session-select')!.textContent!, /2026-09-26_002 · Failed · 2 rounds · current/);
    await click(item(container, 'trace'));
    assert.equal(q(container, 'trace-claude-session')!.textContent, CLAUDE_ID);
    assert.equal(q(container, 'trace-codex-thread')!.textContent, 'UNKNOWN');
    const rows = qa(container, 'trace-row');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent!, /#1.*846af024-e8ed-4f81-80dc-cc6276728abc.*FAILED.*1.*MISSING/);
    assert.match(rows[1].textContent!, /#2.*\(chưa xác nhận\).*INTERRUPTED/);
    await click(rows[0]);
    assert.ok(q(container, 'exec-claude'), "clicking a trace row opens that iteration's Claude execution");
  } finally {
    await unmount();
  }
});
