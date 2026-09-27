import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutionRecord } from '../../../src/core/execution/execution-record.ts';
import type { SessionArtifacts } from '../../../src/core/session-history/session-history.ts';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { ArtifactViewer } from '../../../src/desktop/renderer/components/ArtifactViewer.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import { FakeMain, click, makeSnapshot, q, qa, render } from './harness.tsx';

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

const art = (text: string, sha = 'c'.repeat(64)) => ({ path: 'x', text, bytes: text.length, truncated: false, sha256: sha });

function artifacts(): SessionArtifacts {
  return {
    runId: '2026-09-26_002',
    events: [],
    state: null,
    iterations: [
      {
        iteration: 1,
        claudePrompt: art('Do the exact thing', SHA),
        report: { availability: 'MISSING', path: 'r', note: 'n' },
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
        claudePrompt: art('next', 'd'.repeat(64)),
        report: { availability: 'MISSING', path: 'r', note: 'n' },
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

async function renderViewer() {
  const main = new FakeMain(makeSnapshot({ status: { status: 'ERROR' } }));
  main.handlers.set('bridge:getSessionArtifacts', () => ({ ok: true, data: artifacts() }));
  main.handlers.set('bridge:getExecutionOutput', (req) => {
    const r = req as { stream: string };
    return { ok: true, data: { path: 'x', text: r.stream === 'stderr' ? 'Error: API overloaded (529)' : '{"type":"result"}', bytes: 27, truncated: false } };
  });
  const view = await render(
    <BridgeProvider api={main.api}>
      <ArtifactViewer runId="2026-09-26_002" />
    </BridgeProvider>,
  );
  return { main, ...view };
}

const tab = (root: ParentNode, name: string) => [...root.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name) ?? null;
const iterButton = (root: ParentNode, label: string) => [...root.querySelectorAll('.iter-picker button')].find((b) => b.textContent === label) ?? null;

test('CLAUDE EXECUTION shows bridge session, confirmed Claude CLI session, pid, exit code, prompt SHA/bytes and an evidence-based lifecycle', async () => {
  const { container, unmount } = await renderViewer();
  try {
    await click(iterButton(container, '#1'));
    await click(tab(container, 'CLAUDE EXECUTION'));
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

test('VIEW STDERR / VIEW CLI OUTPUT fetch the redacted tail over the dedicated IPC call (labelled CLI output, not transcript)', async () => {
  const { main, container, unmount } = await renderViewer();
  try {
    await click(iterButton(container, '#1'));
    await click(tab(container, 'CLAUDE EXECUTION'));
    await click(q(container, 'exec-view-stderr'));
    assert.equal(q(container, 'exec-output')!.textContent, 'Error: API overloaded (529)');
    assert.deepEqual(main.invoked.find((c) => c.channel === 'bridge:getExecutionOutput')?.args, [{ runId: '2026-09-26_002', iteration: 1, agent: 'claude', stream: 'stderr' }]);
    await click(q(container, 'exec-view-stdout'));
    assert.match(container.textContent!, /CLI output \(stdout — luồng event của CLI, không phải transcript/);
  } finally {
    await unmount();
  }
});

test('JOURNAL tab lists rounds + FINAL REPORT and lazily loads exactly the selected entry', async () => {
  const { main, container, unmount } = await renderViewer();
  main.handlers.set('bridge:getJournal', () => ({
    ok: true,
    data: {
      runId: '2026-09-26_002',
      status: 'DONE',
      maxIterations: 3,
      rounds: [
        { iteration: 1, state: 'COMPLETED', verdict: 'CONTINUE', available: ['CLAUDE_REPORT', 'CHATGPT_REVIEW', 'CLAUDE_PROMPT', 'NEXT_PROMPT'] },
        { iteration: 2, state: 'COMPLETED', verdict: 'DONE', available: ['CLAUDE_REPORT', 'CHATGPT_REVIEW', 'CLAUDE_PROMPT'] },
      ],
      hasSessionIndex: true,
      hasFinalReport: true,
    },
  }));
  main.handlers.set('bridge:getJournalEntry', (req) => {
    const r = req as { kind: string; iteration?: number };
    return { ok: true, data: { path: `${r.iteration ?? 'session'}-${r.kind}.md`, text: `# ${r.kind} ${r.iteration ?? ''}`, bytes: 10, truncated: false, sha256: 'e'.repeat(64) } };
  });
  try {
    await click(tab(container, 'JOURNAL'));
    assert.ok(q(container, 'journal-list'));
    assert.ok(q(container, 'journal-session-index'));
    assert.ok(q(container, 'journal-final-report'));
    assert.equal(qa(container, 'journal-round').length, 2);
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

test('CHATGPT RESPONSE tab distinguishes Raw / Review / Next Prompt', async () => {
  const { main, container, unmount } = await renderViewer();
  main.handlers.set('bridge:getJournalEntry', () => ({ ok: true, data: { path: '001-review.md', text: '# ChatGPT Review\n\nSome human-readable review text.', bytes: 10, truncated: false, sha256: 'f'.repeat(64) } }));
  try {
    await click(iterButton(container, '#1'));
    await click(tab(container, 'CHATGPT RESPONSE'));
    assert.ok(q(container, 'response-view-raw'));
    assert.match(container.textContent!, /Chưa có response cho iteration này/, 'RAW is the default view');
    await click(q(container, 'response-view-review'));
    assert.match(container.textContent!, /Some human-readable review text\./);
    assert.deepEqual(main.invoked.find((c) => c.channel === 'bridge:getJournalEntry')?.args, [{ runId: '2026-09-26_002', kind: 'CHATGPT_REVIEW', iteration: 1 }]);
    await click(q(container, 'response-view-next-prompt'));
    assert.match(container.textContent!, /Chưa có next prompt cho iteration này/);
  } finally {
    await unmount();
  }
});

test('a resumed call whose session the CLI never confirmed shows continuity UNKNOWN and an INTERRUPTED status — nothing faked', async () => {
  const { container, unmount } = await renderViewer();
  try {
    await click(tab(container, 'CLAUDE EXECUTION')); // defaults to the latest iteration (#2)
    const panel = q(container, 'exec-claude')!;
    assert.match(q(panel, 'exec-continuity')!.textContent!, /Session continuity: UNKNOWN/);
    assert.match(panel.textContent!, /CHƯA xác nhận/);
    assert.match(panel.textContent!, /INTERRUPTED/);
  } finally {
    await unmount();
  }
});

test('a missing record says so honestly (no fabricated execution)', async () => {
  const { container, unmount } = await renderViewer();
  try {
    await click(tab(container, 'CODEX EXECUTION'));
    assert.match(container.textContent!, /Không có execution record của Codex/);
  } finally {
    await unmount();
  }
});

test('Sessions: row shows the Claude CLI session; opening it shows the session header and one trace row per iteration', async () => {
  const main = new FakeMain(makeSnapshot({ status: { status: 'ERROR', claude: { pid: null, sessionId: CLAUDE_ID } } }));
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
    assert.equal(q(container, 'claude-session-id')!.textContent, CLAUDE_ID, 'dashboard shows the Claude CLI session separately');
    await click(q(container, 'nav-sessions'));
    const row = qa(container, 'session-row')[0];
    assert.match(row.textContent!, /2026-09-26_002.*846af024…/);
    await click(row);
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
