import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine, type Preflight, type BridgeEngineDeps } from '../src/core/bridge-engine.ts';
import type { DoctorReport } from '../src/core/preflight/doctor.ts';
import { DEFAULT_CONFIG } from '../src/core/config/config.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

const PASS_REPORT: DoctorReport = { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' };
const BLOCKED_REPORT: DoctorReport = { checks: [{ name: 'api-key-env', status: 'BLOCKED', detail: 'ANTHROPIC_API_KEY set' }], overall: 'BLOCKED' };

function passingDoctor(): (projectPath: string) => Promise<Preflight> {
  return async () => ({
    report: PASS_REPORT,
    claudeExe: process.execPath,
    codexExe: process.execPath,
    config: DEFAULT_CONFIG,
    configErrors: [],
    gitWarning: null,
  });
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-engine-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeEngine(projectPath: string, overrides: Partial<BridgeEngineDeps> = {}): BridgeEngine {
  return new BridgeEngine(projectPath, {
    runDoctor: passingDoctor(),
    claudeCommandArgsPrefix: [FAKE_CLAUDE],
    codexCommandArgsPrefix: [FAKE_CODEX],
    claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
    codexEnv: { FAKE_CODEX_MODE: 'sequence' },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// doctor()
// ---------------------------------------------------------------------------

test('doctor() returns the report produced by the injected runDoctor dependency', () =>
  withProject(async (projectPath) => {
    const engine = new BridgeEngine(projectPath, { runDoctor: async () => ({ report: BLOCKED_REPORT, claudeExe: null, codexExe: null, config: DEFAULT_CONFIG, configErrors: [], gitWarning: null }) });
    const report = await engine.doctor();
    assert.equal(report.overall, 'BLOCKED');
  }));

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

test('start() refuses and reports BLOCKED_PREFLIGHT when doctor is not PASS, without acquiring a lock', () =>
  withProject(async (projectPath) => {
    const engine = new BridgeEngine(projectPath, { runDoctor: async () => ({ report: BLOCKED_REPORT, claudeExe: null, codexExe: null, config: DEFAULT_CONFIG, configErrors: [], gitWarning: null }) });
    const outcome = await engine.start({ task: 'do the thing' });
    assert.equal(outcome.kind, 'BLOCKED_PREFLIGHT');
    if (outcome.kind === 'BLOCKED_PREFLIGHT') assert.equal(outcome.doctorReport.overall, 'BLOCKED');
    await assert.rejects(readFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), 'utf8'));
  }));

test('start() drives a real 2-iteration fake-CLI loop to DONE and returns a COMPLETED outcome', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const outcome = await engine.start({ task: 'Create src/sum.js' });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind === 'COMPLETED') {
      assert.equal(outcome.finalStatus, 'DONE');
      assert.equal(outcome.iterations, 2);
      assert.ok(outcome.claudeSessionId);
      assert.ok(outcome.codexThreadId);
    }
  }));

test('start() refuses with ALREADY_RUNNING when a live lock already exists for the project', () =>
  withProject(async (projectPath) => {
    await mkdir(path.join(projectPath, '.ai-bridge', 'state'), { recursive: true });
    await writeFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    const engine = makeEngine(projectPath);
    const outcome = await engine.start({ task: 'do the thing' });
    assert.equal(outcome.kind, 'ALREADY_RUNNING');
    if (outcome.kind === 'ALREADY_RUNNING') assert.equal(outcome.pid, process.pid);
  }));

// ---------------------------------------------------------------------------
// subscribe()
// ---------------------------------------------------------------------------

test('subscribe() receives live events during a start() run, including RUN_STARTED and RUN_COMPLETED', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const seen: string[] = [];
    const unsubscribe = engine.subscribe((e) => seen.push(e.event));
    await engine.start({ task: 'Create src/sum.js' });
    unsubscribe();
    assert.ok(seen.includes('RUN_STARTED'));
    assert.ok(seen.includes('RUN_COMPLETED'));
    assert.ok(seen.includes('CLAUDE_STARTED'));
    assert.ok(seen.includes('RESPONSE_PARSED'));
  }));

test('unsubscribe stops further delivery to that listener', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const seen: string[] = [];
    const unsubscribe = engine.subscribe((e) => seen.push(e.event));
    unsubscribe();
    await engine.start({ task: 'Create src/sum.js' });
    assert.equal(seen.length, 0);
  }));

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

test('status() before any run reports NOT_STARTED', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const status = await engine.status();
    assert.equal(status.status, 'NOT_STARTED');
  }));

test('status() after a completed run reports DONE with iteration/session details', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    const status = await engine.status();
    assert.equal(status.status, 'DONE');
    assert.equal(status.iteration, 2);
    assert.ok(status.claude.sessionId);
    assert.ok(status.codex.threadId);
  }));

// ---------------------------------------------------------------------------
// pause()
// ---------------------------------------------------------------------------

test('pause() reports NOT_RUNNING when there is no live session', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath, { isPidAlive: () => false });
    const outcome = await engine.pause();
    assert.equal(outcome.kind, 'NOT_RUNNING');
  }));

test('pause() reports PAUSED immediately when the state file already shows PAUSED', () =>
  withProject(async (projectPath) => {
    await mkdir(path.join(projectPath, '.ai-bridge', 'state'), { recursive: true });
    await writeFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }), 'utf8');
    await writeFile(
      path.join(projectPath, '.ai-bridge', 'state', 'current-session.json'),
      JSON.stringify({ runId: '2026-09-25_001', status: 'PAUSED', iteration: 1, claudeSessionId: 'c1', codexThreadId: 't1', claudePid: null, codexPid: null, lastReportPath: null, lastPromptHash: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      'utf8',
    );
    const engine = makeEngine(projectPath, { isPidAlive: () => true });
    const outcome = await engine.pause();
    assert.equal(outcome.kind, 'PAUSED');
  }));

// ---------------------------------------------------------------------------
// resume()
// ---------------------------------------------------------------------------

test('resume() reports NO_STATE when there is nothing to resume', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const outcome = await engine.resume();
    assert.equal(outcome.kind, 'NO_STATE');
  }));

test('resume() reports RECOVERY_BLOCKED for a non-resumable last-known phase, without acquiring a lock', () =>
  withProject(async (projectPath) => {
    await mkdir(path.join(projectPath, '.ai-bridge', 'state'), { recursive: true });
    await writeFile(
      path.join(projectPath, '.ai-bridge', 'state', 'current-session.json'),
      JSON.stringify({ runId: '2026-09-25_001', status: 'CLAUDE_EXECUTING', iteration: 1, claudeSessionId: 'c1', codexThreadId: null, claudePid: null, codexPid: null, lastReportPath: null, lastPromptHash: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      'utf8',
    );
    const engine = makeEngine(projectPath);
    const outcome = await engine.resume();
    assert.equal(outcome.kind, 'RECOVERY_BLOCKED');
  }));

test('resume() continues a RESPONSE_PARSED session from its persisted prompt through to DONE', () =>
  withProject(async (projectPath) => {
    const startEngine = makeEngine(projectPath);
    const first = await startEngine.start({ task: 'Create src/sum.js' });
    assert.equal(first.kind, 'COMPLETED');

    // Rewrite state back to RESPONSE_PARSED at iteration 1, as if the process had
    // crashed right after persisting iteration 1's extracted prompt but before
    // iteration 2's Claude call — the file that iteration 1 actually wrote is reused.
    const stateFile = path.join(projectPath, '.ai-bridge', 'state', 'current-session.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    state.status = 'RESPONSE_PARSED';
    state.iteration = 1;
    await writeFile(stateFile, JSON.stringify(state), 'utf8');

    const resumeEngine = makeEngine(projectPath);
    const outcome = await resumeEngine.resume();
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind === 'COMPLETED') {
      assert.equal(outcome.finalStatus, 'DONE');
      assert.equal(outcome.claudeSessionId, state.claudeSessionId);
    }
  }));

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

test('stop() reports NOT_RUNNING when there is no lock file', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const outcome = await engine.stop();
    assert.equal(outcome.kind, 'NOT_RUNNING');
  }));

test('stop() reports STOPPED with GRACEFUL_STOP when the process dies right after the graceful attempt', () =>
  withProject(async (projectPath) => {
    await mkdir(path.join(projectPath, '.ai-bridge', 'state'), { recursive: true });
    await writeFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }), 'utf8');
    let alive = true;
    const engine = makeEngine(projectPath, {
      isPidAlive: () => alive,
      attemptGracefulStop: async () => {
        alive = false;
      },
    });
    const outcome = await engine.stop();
    assert.equal(outcome.kind, 'STOPPED');
    if (outcome.kind === 'STOPPED') assert.equal(outcome.reason, 'GRACEFUL_STOP');
  }));

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

test('reset() refuses while a session is still running', () =>
  withProject(async (projectPath) => {
    await mkdir(path.join(projectPath, '.ai-bridge', 'state'), { recursive: true });
    await writeFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), JSON.stringify({ pid: 42, startedAt: new Date().toISOString() }), 'utf8');
    const engine = makeEngine(projectPath, { isPidAlive: () => true });
    const outcome = await engine.reset();
    assert.equal(outcome.kind, 'REFUSED_RUNNING');
  }));

test('reset() clears the lock and state file when nothing is running', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    const outcome = await engine.reset();
    assert.equal(outcome.kind, 'RESET');
    const status = await engine.status();
    assert.equal(status.status, 'NOT_STARTED');
  }));

// ---------------------------------------------------------------------------
// logs()
// ---------------------------------------------------------------------------

test('logs() returns an empty result before any run, and real lines after one', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const before = await engine.logs();
    assert.equal(before.length, 0);
    await engine.start({ task: 'Create src/sum.js' });
    const after = await engine.logs(5);
    assert.ok(after.length > 0);
  }));
