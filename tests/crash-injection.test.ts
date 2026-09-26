import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeCodeCliAdapter } from '../src/adapters/claude/claude-code-cli-adapter.ts';
import { CodexCliAdapter } from '../src/adapters/chatgpt/codex-cli-adapter.ts';
import { Orchestrator, CRASH_POINTS } from '../src/core/orchestrator/orchestrator.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

async function withProject<T>(fn: (dirs: { projectPath: string; sessionDir: string; reportsDir: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-crash-'));
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
    projectName: 'Demo',
    projectPath: dirs.projectPath,
    bridgeSessionId: '2026-09-25_001',
    sessionDir: dirs.sessionDir,
    reportsDir: dirs.reportsDir,
    initialPrompt: 'Do the thing.',
    maxIterations: 10,
    claudeTimeoutMs: 5000,
    codexTimeoutMs: 5000,
    claudeAdapter: new ClaudeCodeCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLAUDE] }),
    codexAdapter: new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] }),
    claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
    codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nNext step.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
    ...overrides,
  });
}

test('exposes exactly the 8 crash points named in the spec', () => {
  assert.deepEqual(
    [...CRASH_POINTS].sort(),
    [
      'AFTER_CLAUDE_STARTED',
      'AFTER_CLAUDE_COMPLETED',
      'AFTER_REPORT_VALIDATED',
      'AFTER_CODEX_STARTED',
      'AFTER_CODEX_COMPLETED',
      'AFTER_RESPONSE_PARSED',
      'AFTER_PROMPT_PERSISTED',
      'BEFORE_PROMPT_SENT',
    ].sort(),
  );
});

for (const point of [
  'AFTER_CLAUDE_STARTED',
  'AFTER_CLAUDE_COMPLETED',
  'AFTER_REPORT_VALIDATED',
  'AFTER_CODEX_STARTED',
  'AFTER_CODEX_COMPLETED',
  'AFTER_RESPONSE_PARSED',
  'AFTER_PROMPT_PERSISTED',
] as const) {
  test(`triggers onTrigger exactly once at ${point} and never completes the run`, () =>
    withProject(async (dirs) => {
      let calls = 0;
      // AFTER_CLAUDE_STARTED/AFTER_CODEX_STARTED don't stop the loop themselves (a real
      // process.exit() would kill the whole process instead) — bound maxIterations so
      // the test stays fast regardless.
      const orch = makeOrchestrator(dirs, { maxIterations: 2, crashInjection: { at: point, onTrigger: () => { calls++; } } });
      const r = await orch.run();
      assert.equal(calls, 1);
      assert.notEqual(r.finalStatus, 'DONE');
    }));
}

test('BEFORE_PROMPT_SENT fires on iteration 2, not iteration 1', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, {
      crashInjection: { at: 'BEFORE_PROMPT_SENT', onTrigger: () => {} },
    });
    const r = await orch.run();
    // Iteration 1 completed fully (report+codex+parse); the crash fires at the START
    // of iteration 2, before Claude is invoked for it — so iteration 2 never appears
    // as a completed IterationRecord.
    assert.equal(r.iterations.length, 1);
    assert.equal(r.iterations[0].status, 'ok');
  }));

test('a crash point that never fires (e.g. run stops with DONE first) does not affect the normal happy path', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, {
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      crashInjection: { at: 'BEFORE_PROMPT_SENT', onTrigger: () => { throw new Error('must not fire — DONE means no iteration 2'); } },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
  }));

test('with no crashInjection option, the run completes normally (feature is inert by default)', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, { codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDone.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' } });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
  }));

test('AFTER_PROMPT_PERSISTED: the extracted-prompt file is already on disk, byte-identical to what onTrigger can read, at the moment it fires', () =>
  withProject(async (dirs) => {
    let fileContentAtCrash: string | null = null;
    const orch = makeOrchestrator(dirs, {
      crashInjection: {
        at: 'AFTER_PROMPT_PERSISTED',
        onTrigger: () => {
          // Synchronous read to prove the file is already fully written before onTrigger runs.
          fileContentAtCrash = readFileSync(path.join(dirs.sessionDir, '001-extracted-prompt.md'), 'utf8');
        },
      },
    });
    await orch.run();
    assert.equal(fileContentAtCrash, 'Next step.');
  }));

test('AFTER_PROMPT_PERSISTED never fires when Codex\'s own verdict is DONE — there is no "next Claude call" to crash before (found via a real M3.5 integration test: resuming from that split-second window fed Claude a closing remark as a work instruction, producing REPORT_INVALID)', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, {
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nTask is complete. Do not make further changes.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      crashInjection: { at: 'AFTER_PROMPT_PERSISTED', onTrigger: () => { throw new Error('must not fire — DONE has no next prompt to resume from'); } },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'DONE');
  }));

test('AFTER_PROMPT_PERSISTED never fires when Codex\'s own verdict is NEED_HUMAN, for the same reason', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, {
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>NEED_HUMAN</STATUS>\n<PROMPT>\nAsk the user something.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
      crashInjection: { at: 'AFTER_PROMPT_PERSISTED', onTrigger: () => { throw new Error('must not fire — NEED_HUMAN has no next prompt to resume from'); } },
    });
    const r = await orch.run();
    assert.equal(r.finalStatus, 'NEED_HUMAN');
  }));

test('the extracted-prompt file and integrity chain are still written for a DONE/NEED_HUMAN response, even though AFTER_PROMPT_PERSISTED cannot fire for them', () =>
  withProject(async (dirs) => {
    const orch = makeOrchestrator(dirs, {
      codexEnv: { FAKE_CODEX_RESPONSE: '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nAll done.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n' },
    });
    await orch.run();
    assert.equal(readFileSync(path.join(dirs.sessionDir, '001-extracted-prompt.md'), 'utf8'), 'All done.');
    const chain = JSON.parse(readFileSync(path.join(dirs.sessionDir, '001-integrity.json'), 'utf8'));
    assert.ok(chain.promptHash);
  }));
