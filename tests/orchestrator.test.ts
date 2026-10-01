import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ClaudeCodeCliAdapter } from '../src/adapters/claude/claude-code-cli-adapter.ts';
import { CodexCliAdapter } from '../src/adapters/chatgpt/codex-cli-adapter.ts';
import { Orchestrator } from '../src/core/orchestrator/orchestrator.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

async function withProject<T>(fn: (dirs: { projectPath: string; sessionDir: string; reportsDir: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-orch-'));
  try {
    const sessionDir = path.join(root, 'session');
    const reportsDir = path.join(root, 'reports');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(reportsDir, { recursive: true });
    return await fn({ projectPath: root, sessionDir, reportsDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeOrchestrator(dirs: { projectPath: string; sessionDir: string; reportsDir: string }, overrides: Record<string, unknown> = {}) {
  return new Orchestrator({
    projectName: 'Demo Project',
    projectPath: dirs.projectPath,
    bridgeSessionId: '2026-09-25_001',
    sessionDir: dirs.sessionDir,
    reportsDir: dirs.reportsDir,
    initialPrompt: 'Create src/sum.js with a sum(a, b) function and a test.',
    maxIterations: 10,
    claudeTimeoutMs: 5000,
    codexTimeoutMs: 5000,
    claudeAdapter: new ClaudeCodeCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLAUDE] }),
    codexAdapter: new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] }),
    ...overrides,
  });
}

test('runs two full iterations and stops on DONE, resuming the same Claude session and Codex thread', () =>
  withProject(async (dirs) => {
    const logEvents: Array<{ adapter: string; exitCode: number | null; status: string; iteration: number }> = [];
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_MODE: 'sequence' },
      onLog: (e: { adapter: string; exitCode: number | null; status: string; iteration: number }) => logEvents.push(e),
    });
    const r = await orch.run();

    // One log event per adapter call: 2 iterations x (claude + codex) = 4.
    assert.equal(logEvents.length, 4);
    assert.deepEqual(
      logEvents.map((e) => [e.iteration, e.adapter, e.status]),
      [
        [1, 'claude', 'ok'],
        [1, 'codex', 'ok'],
        [2, 'claude', 'ok'],
        [2, 'codex', 'ok'],
      ],
    );
    assert.ok(logEvents.every((e) => e.exitCode === 0));

    assert.equal(r.finalStatus, 'DONE');
    assert.equal(r.errorCode, null);
    assert.equal(r.iterations.length, 2);
    assert.equal(r.iterations[0].status, 'ok');
    assert.equal(r.iterations[1].status, 'ok');
    assert.ok(r.claudeSessionId, 'claudeSessionId should be set');
    assert.ok(r.codexThreadId, 'codexThreadId should be set');

    // Iteration 2's prompt must be exactly the PROMPT Codex extracted from iteration 1.
    const prompt2 = await readFile(r.iterations[1].promptPath, 'utf8');
    assert.equal(prompt2, 'Sửa `src/sum.js` để throw TypeError khi tham số không phải number.');

    // Both reports were written and can be read back.
    const report1 = await readFile(r.iterations[0].reportPath, 'utf8');
    const report2 = await readFile(r.iterations[1].reportPath, 'utf8');
    assert.match(report1, /ITERATION: 1/);
    assert.match(report2, /ITERATION: 2/);

    const states: string[] = r.transitions.map((t) => t.state);
    for (const expected of [
      'IDLE',
      'PREFLIGHT',
      'CLAUDE_EXECUTING',
      'REPORT_DETECTED',
      'REPORT_VALIDATED',
      'CODEX_REVIEWING',
      'CODEX_RESPONSE_RECEIVED',
      'RESPONSE_PARSED',
      'DONE',
    ]) {
      assert.ok(states.includes(expected), `missing state ${expected} in ${states.join(',')}`);
    }
    // CLAUDE_EXECUTING must appear for both iterations (the loop actually looped).
    assert.equal(states.filter((s) => s === 'CLAUDE_EXECUTING').length, 2);
  }));

test('stops with NEED_HUMAN after a single iteration when Codex says so', () =>
  withProject(async (dirs) => {
    const response = '<AI_BRIDGE_RESPONSE>\n<STATUS>NEED_HUMAN</STATUS>\n<PROMPT>\nAsk the user for the API base URL.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
    const orch = makeOrchestrator(dirs, { claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexEnv: { FAKE_CODEX_RESPONSE: response } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'NEED_HUMAN');
    assert.equal(r.iterations.length, 1);
  }));

test('stops at maxIterations when Codex keeps saying CONTINUE', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { maxIterations: 2, claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexEnv: { FAKE_CODEX_MODE: 'ok' } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'STOPPED_MAX_ITERATIONS');
    assert.equal(r.iterations.length, 2);
  }));

test('stops with an error, after a single attempt, when Claude report is invalid', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { claudeEnv: { FAKE_CLAUDE_MODE: 'bad-report' } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'ERROR');
    assert.equal(r.errorCode, 'REPORT_INVALID');
    assert.equal(r.iterations.length, 1);
  }));

test('stops with an error when Codex response is malformed', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexEnv: { FAKE_CODEX_RESPONSE: 'no response block here' } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'ERROR');
    assert.equal(r.errorCode, 'RESPONSE_INVALID');
  }));

test('stops with an error when Claude exits non-zero', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { claudeEnv: { FAKE_CLAUDE_MODE: 'error-exit' } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'ERROR');
    assert.equal(r.errorCode, 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT');
    assert.equal(r.iterations.length, 1);
  }));

test('stops with an error when Claude hangs past its timeout, without retrying', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { claudeTimeoutMs: 300, claudeEnv: { FAKE_CLAUDE_MODE: 'hang' } });
    const start = Date.now();
    const r = await orch.run();
    assert.equal(r.finalStatus, 'ERROR');
    assert.equal(r.errorCode, 'CLAUDE_RUN_FAILED:TIMEOUT');
    assert.equal(r.iterations.length, 1);
    assert.ok(Date.now() - start < 5000);
  }));

test('stops with an error when Codex exits non-zero', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexEnv: { FAKE_CODEX_MODE: 'error-exit' } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'ERROR');
    assert.equal(r.errorCode, 'CODEX_RUN_FAILED:NON_ZERO_EXIT');
  }));

test('M5.10.1: rejects construction with an unsupported permission policy, before spawning anything (fails closed)', () =>
  withProject(async (dirs) => {
    const bogus = { provider: 'claude', requested: 'inherit', resolved: 'yolo', source: 'provider-setting', reason: 'x' } as never;
    const ok = { provider: 'codex', requested: 'inherit', resolved: 'bypass', source: 'provider-setting', reason: 'x' } as const;
    assert.throws(() => makeOrchestrator(dirs, { permissionPolicies: { claude: bogus, codex: ok } }), /UNSUPPORTED_PERMISSION_POLICY/);
    // A policy filed under the wrong provider is refused too.
    assert.throws(() => makeOrchestrator(dirs, { permissionPolicies: { claude: ok as never, codex: ok } }), /UNSUPPORTED_PERMISSION_POLICY/);
  }));

test('pauses cooperatively before starting the next iteration when shouldPause reports true', () =>
  withProject(async (dirs) => {
    let calls = 0;
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_MODE: 'ok' }, // always CONTINUE
      shouldPause: () => {
        calls++;
        return calls > 1; // let iteration 1 run, pause before iteration 2
      },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'PAUSED');
    assert.equal(r.iterations.length, 1);
  }));

test('pauses before iteration 1 too, stopping without running Claude at all', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { shouldPause: () => true });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'PAUSED');
    assert.equal(r.iterations.length, 0);
  }));

test('shouldStop takes priority over shouldPause when both report true at the same boundary', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { shouldStop: () => true, shouldPause: () => true });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'STOPPED');
  }));

test('a paused run reports the claudeSessionId/codexThreadId known so far, so pause-then-resume can continue them', () =>
  withProject(async (dirs) => {
    let calls = 0;
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_MODE: 'ok' },
      shouldPause: () => { calls++; return calls > 1; },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'PAUSED');
    assert.ok(r.claudeSessionId);
    assert.ok(r.codexThreadId);
  }));

test('stops cooperatively before starting the next iteration when shouldStop reports true', () =>
  withProject(async (dirs) => {
    let calls = 0;
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_MODE: 'ok' }, // always CONTINUE, so without shouldStop this would hit maxIterations
      shouldStop: () => {
        calls++;
        return calls > 1; // let iteration 1 run, stop before iteration 2
      },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'STOPPED');
    assert.equal(r.iterations.length, 1);
  }));

test('checks shouldStop before iteration 1 too, stopping without running Claude at all', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { shouldStop: () => true });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'STOPPED');
    assert.equal(r.iterations.length, 0);
  }));

test('resumes at a later iteration, reusing the given Claude session and Codex thread ids', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      resumeState: { startIteration: 5, claudeSessionId: 'aaaaaaaa-0000-0000-0000-000000000000', codexThreadId: 'bbbbbbbb-1111-1111-1111-111111111111', skipClaudeThisIteration: false },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
    assert.equal(r.iterations.length, 1);
    assert.equal(r.iterations[0].iteration, 5);
    assert.equal(r.claudeSessionId, 'aaaaaaaa-0000-0000-0000-000000000000');
  }));

test('resuming with skipClaudeThisIteration reuses the existing report on disk instead of calling Claude', () =>
  withProject(async (dirs) => {
    const reportPath = path.join(dirs.reportsDir, '002-report.md');
    const reportText = [
      '# AI Bridge Report',
      '',
      'SESSION_ID: 2026-09-25_001',
      'ITERATION: 2',
      'REPORT_STATUS: COMPLETE',
      'NEXT_ACTION: CONTINUE',
      '',
      '## TASK',
      'x',
      '## CHANGES',
      'x',
      '## TESTS',
      'x',
      '## ISSUES',
      'x',
      '## NEXT_RECOMMENDATION',
      'x',
      '',
    ].join('\n');
    await writeFile(reportPath, reportText, 'utf8');

    let claudeCalled = false;
    const adapter = new ClaudeCodeCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLAUDE] });
    const originalRun = adapter.run.bind(adapter);
    adapter.run = (...args) => {
      claudeCalled = true;
      return originalRun(...args);
    };

    const orch = makeOrchestrator(dirs, {
      claudeAdapter: adapter,
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      resumeState: { startIteration: 2, claudeSessionId: 'aaaaaaaa-0000-0000-0000-000000000000', codexThreadId: null, skipClaudeThisIteration: true },
    });
    const r = await orch.run();
    assert.equal(claudeCalled, false, 'Claude must not be re-invoked when resuming past a completed report');
    assert.equal(r.finalStatus, 'DONE');
    assert.equal(r.iterations[0].reportSha256, createHash('sha256').update(Buffer.from(reportText, 'utf8')).digest('hex'));
  }));

test('reports the Claude session id and Codex thread id as soon as each becomes known, not only at the end', () =>
  withProject(async (dirs) => {
    const seen: Array<{ claudeSessionId?: string; codexThreadId?: string }> = [];
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      onSessionUpdate: (info: { claudeSessionId?: string; codexThreadId?: string }) => seen.push(info),
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
    // The Claude session id must be known BEFORE Codex is ever called, so a crash
    // between them still leaves a resumable, session-preserving state on disk.
    const claudeEntry = seen.find((s) => s.claudeSessionId);
    const codexEntry = seen.find((s) => s.codexThreadId);
    assert.ok(claudeEntry, 'no onSessionUpdate call reported claudeSessionId');
    assert.equal(claudeEntry!.claudeSessionId, r.claudeSessionId);
    assert.ok(codexEntry, 'no onSessionUpdate call reported codexThreadId');
    assert.equal(codexEntry!.codexThreadId, r.codexThreadId);
    assert.ok(seen.indexOf(claudeEntry!) < seen.indexOf(codexEntry!));
  }));

test('reports live PIDs for both Claude and Codex as they are spawned', () =>
  withProject(async (dirs) => {
    const pids: Array<{ adapter: string; pid: number }> = [];
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      onPidUpdate: (info: { adapter: string; pid: number }) => pids.push(info),
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
    assert.equal(pids.length, 2);
    assert.equal(pids[0].adapter, 'claude');
    assert.equal(pids[1].adapter, 'codex');
    assert.ok(pids.every((p) => typeof p.pid === 'number' && p.pid > 0));
  }));

test('awaits onTransition before proceeding to the next step, so a slow/async persist is durable before any further side effect', () =>
  withProject(async (dirs) => {
    let writesInFlight = 0;
    let maxConcurrentWrites = 0;
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      onTransition: async () => {
        writesInFlight++;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, writesInFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        writesInFlight--;
      },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
    // If the orchestrator did NOT await onTransition, several would overlap (since
    // push() is called many times in quick succession); awaited, at most one is ever
    // in flight at a time.
    assert.equal(maxConcurrentWrites, 1);
    assert.equal(writesInFlight, 0);
  }));

test('awaits onSessionUpdate before proceeding, so the session id is durable before the other adapter is ever invoked', () =>
  withProject(async (dirs) => {
    let sawSessionIdDurable = false;
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      onSessionUpdate: async (info: { claudeSessionId?: string }) => {
        if (info.claudeSessionId) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          sawSessionIdDurable = true;
        }
      },
      // Codex must never start before the (slow) claudeSessionId persist above resolves.
      codexAdapter: new (class extends CodexCliAdapter {
        override async run(opts: Parameters<CodexCliAdapter['run']>[0]) {
          assert.equal(sawSessionIdDurable, true, 'Codex started before the Claude session id was durably persisted');
          return super.run(opts);
        }
      })({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] }),
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
  }));

test('calls onTransition in real time as each state is entered, not just at the end', () =>
  withProject(async (dirs) => {
    const seen: string[] = [];
    const orch = makeOrchestrator(dirs, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      onTransition: (t: { state: string }) => {
        seen.push(t.state);
        // At the moment CLAUDE_EXECUTING fires, nothing past it should have happened yet.
        if (t.state === 'CLAUDE_EXECUTING') assert.ok(!seen.includes('DONE'));
      },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
    assert.deepEqual(seen, r.transitions.map((t) => t.state));
  }));

test('stops with REPORT_TRANSPORT_INTEGRITY_FAILURE when the validator returns a self-inconsistent report (defense in depth)', () =>
  withProject(async (dirs) => {
    const brokenValidator = {
      validateFile: async () => ({ valid: true, errors: [], fields: { sessionId: '2026-09-25_001', iteration: 1, reportStatus: 'COMPLETE' as const, nextAction: 'DONE' as const }, text: 'report text', sha256: 'not-the-real-hash', bytes: 11 }),
    };
    const orch = makeOrchestrator(dirs, { claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, reportValidator: brokenValidator as never });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'ERROR');
    assert.equal(r.errorCode, 'REPORT_TRANSPORT_INTEGRITY_FAILURE');
  }));

test('refuses to run and never spawns anything when a cost-risk API key env var is set', () =>
  withProject(async (dirs) => {
    let claudeCalled = false;
    const adapter = new ClaudeCodeCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLAUDE] });
    const originalRun = adapter.run.bind(adapter);
    adapter.run = (...args) => {
      claudeCalled = true;
      return originalRun(...args);
    };
    const orch = makeOrchestrator(dirs, { claudeAdapter: adapter, env: { ANTHROPIC_API_KEY: 'sk-ant-fake' } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'ERROR');
    assert.equal(r.errorCode, 'BLOCKED_API_AUTH');
    assert.equal(claudeCalled, false, 'Claude must never be spawned when a cost-risk env var is set');
    assert.equal(r.iterations.length, 0);
  }));

test("sends the user's exact initial prompt to Claude on iteration 1", () =>
  withProject(async (dirs) => {
    const initialPrompt = 'Sửa `src/sum.js`:\n\n```js\nexport const x = 1;\n```\n\n   giữ nguyên thụt lề này';
    const orch = makeOrchestrator(dirs, {
      initialPrompt,
      claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
    const sentPrompt = await readFile(r.iterations[0].promptPath, 'utf8');
    assert.equal(sentPrompt, initialPrompt);
  }));
