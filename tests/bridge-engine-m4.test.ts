import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine, type Preflight, type BridgeEngineDeps } from '../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../src/core/config/config.ts';

// M4 additions to BridgeEngine: recovery preview, session history/artifacts, config
// read/write, richer status, and Core fixes found while wiring the desktop app
// (stale pause marker; a user stop recorded as a crash; resume ignoring the run's cap).

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

function passingDoctor(): (projectPath: string) => Promise<Preflight> {
  return async () => ({
    report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
    claudeExe: process.execPath,
    codexExe: process.execPath,
    config: DEFAULT_CONFIG,
    configErrors: [],
    gitWarning: null,
  });
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-m4-'));
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

const stateDir = (projectPath: string) => path.join(projectPath, '.ai-bridge', 'state');
const stateFile = (projectPath: string) => path.join(stateDir(projectPath), 'current-session.json');

async function writeState(projectPath: string, fields: Record<string, unknown>): Promise<void> {
  await mkdir(stateDir(projectPath), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    stateFile(projectPath),
    JSON.stringify({ runId: '2026-09-26_001', projectPath, status: 'RESPONSE_PARSED', iteration: 1, claudeSessionId: 'c1', codexThreadId: 't1', claudePid: null, codexPid: null, lastReportPath: null, lastPromptHash: null, startedAt: now, updatedAt: now, ...fields }),
    'utf8',
  );
}

async function writeLock(projectPath: string, pid: number): Promise<void> {
  await mkdir(stateDir(projectPath), { recursive: true });
  await writeFile(path.join(stateDir(projectPath), 'lock'), JSON.stringify({ pid, startedAt: new Date().toISOString() }), 'utf8');
}

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

test('status() exposes the run maxIterations and the Core-derived agent activity', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const before = await engine.status();
    assert.equal(before.maxIterations, null);
    assert.deepEqual(before.activity, { claude: 'IDLE', codex: 'IDLE' });

    await engine.start({ task: 'Create src/sum.js', maxIterations: 4 });
    const after = await engine.status();
    assert.equal(after.maxIterations, 4);
    assert.deepEqual(after.activity, { claude: 'IDLE', codex: 'IDLE' });
  }));

test('status() reports live activity from the persisted phase while the lock holder is alive', () =>
  withProject(async (projectPath) => {
    await writeState(projectPath, { status: 'CLAUDE_EXECUTING', maxIterations: 10 });
    await writeLock(projectPath, 4242);
    const status = await makeEngine(projectPath, { isPidAlive: () => true }).status();
    assert.equal(status.status, 'RUNNING');
    assert.deepEqual(status.activity, { claude: 'EXECUTING', codex: 'WAITING' });
  }));

// ---------------------------------------------------------------------------
// checkRecovery()
// ---------------------------------------------------------------------------

test('checkRecovery() is NONE with no state and NONE after a session reached DONE', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    assert.deepEqual(await engine.checkRecovery(), { kind: 'NONE' });
    await engine.start({ task: 'Create src/sum.js' });
    assert.deepEqual(await engine.checkRecovery(), { kind: 'NONE' });
  }));

test('checkRecovery() says RECOVERABLE for an interrupted RESPONSE_PARSED session whose prompt is on disk — and resume() agrees', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    const state = JSON.parse(await readFile(stateFile(projectPath), 'utf8'));
    await writeState(projectPath, { ...state, status: 'RESPONSE_PARSED', iteration: 1 });

    const check = await engine.checkRecovery();
    assert.equal(check.kind, 'RECOVERABLE');
    if (check.kind === 'RECOVERABLE') {
      assert.equal(check.status, 'INTERRUPTED');
      assert.equal(check.strategy, 'CONTINUE_FROM_PROMPT');
      assert.equal(check.iteration, 1);
    }
    assert.equal((await engine.resume()).kind, 'COMPLETED');
  }));

test('checkRecovery() says BLOCKED (with the reason) for a mid-Claude crash — and resume() agrees', () =>
  withProject(async (projectPath) => {
    await writeState(projectPath, { status: 'CLAUDE_EXECUTING' });
    const engine = makeEngine(projectPath);
    const check = await engine.checkRecovery();
    assert.equal(check.kind, 'BLOCKED');
    if (check.kind === 'BLOCKED') assert.match(check.reason, /CLAUDE_EXECUTING/);
    assert.equal((await engine.resume()).kind, 'RECOVERY_BLOCKED');
  }));

test('checkRecovery() says BLOCKED for a session paused before any iteration completed', () =>
  withProject(async (projectPath) => {
    await writeState(projectPath, { status: 'PAUSED', iteration: 0 });
    const check = await makeEngine(projectPath).checkRecovery();
    assert.equal(check.kind, 'BLOCKED');
    if (check.kind === 'BLOCKED') assert.equal(check.status, 'PAUSED');
  }));

test('checkRecovery() says BLOCKED when the checkpoint artifact it needs is missing on disk', () =>
  withProject(async (projectPath) => {
    await writeState(projectPath, { status: 'PAUSED', iteration: 2 });
    const check = await makeEngine(projectPath).checkRecovery();
    assert.equal(check.kind, 'BLOCKED');
    if (check.kind === 'BLOCKED') assert.match(check.reason, /002-extracted-prompt\.md/);
  }));

test('checkRecovery() says RUNNING (never offers resume) while the lock holder is alive', () =>
  withProject(async (projectPath) => {
    await writeState(projectPath, { status: 'RESPONSE_PARSED' });
    await writeLock(projectPath, 4242);
    const check = await makeEngine(projectPath, { isPidAlive: () => true }).checkRecovery();
    assert.deepEqual(check, { kind: 'RUNNING', runId: '2026-09-26_001' });
  }));

// ---------------------------------------------------------------------------
// Core fixes
// ---------------------------------------------------------------------------

test('start() ignores a stale pause-request marker left behind by an earlier run (regression)', () =>
  withProject(async (projectPath) => {
    await mkdir(stateDir(projectPath), { recursive: true });
    await writeFile(path.join(stateDir(projectPath), 'pause-request'), JSON.stringify({ requestedAt: new Date().toISOString() }), 'utf8');
    const outcome = await makeEngine(projectPath).start({ task: 'Create src/sum.js' });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind === 'COMPLETED') assert.equal(outcome.finalStatus, 'DONE');
  }));

test('stop() records a confirmed user stop as STOPPED (terminal, not resumable) with a RUN_STOPPED event (regression)', () =>
  withProject(async (projectPath) => {
    await writeState(projectPath, { status: 'CLAUDE_EXECUTING', claudePid: 777 });
    await writeLock(projectPath, 999999);
    await writeFile(path.join(stateDir(projectPath), 'pause-request'), '{}', 'utf8');
    let alive = true;
    const engine = makeEngine(projectPath, {
      isPidAlive: () => alive,
      attemptGracefulStop: async () => {
        alive = false;
      },
    });
    const seen: string[] = [];
    engine.subscribe((e) => seen.push(e.event));

    const outcome = await engine.stop();
    assert.equal(outcome.kind, 'STOPPED');
    const status = await engine.status();
    assert.equal(status.status, 'STOPPED');
    assert.equal(status.claude.pid, null);
    assert.deepEqual(await engine.checkRecovery(), { kind: 'NONE' });
    assert.deepEqual(seen, ['RUN_STOPPED']);
    await assert.rejects(readFile(path.join(stateDir(projectPath), 'pause-request'), 'utf8'));
  }));

test('stop() leaves an already-terminal state untouched', () =>
  withProject(async (projectPath) => {
    await writeState(projectPath, { status: 'DONE' });
    await writeLock(projectPath, 999999);
    let alive = true;
    const engine = makeEngine(projectPath, {
      isPidAlive: () => alive,
      attemptGracefulStop: async () => {
        alive = false;
      },
    });
    const seen: string[] = [];
    engine.subscribe((e) => seen.push(e.event));
    await engine.stop();
    assert.equal((await engine.status()).status, 'DONE');
    assert.deepEqual(seen, []);
  }));

test('resume() keeps the maxIterations the run was started with instead of the config default (regression)', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'ok' } }); // always CONTINUE
    const first = await engine.start({ task: 'Create src/sum.js', maxIterations: 1 });
    assert.equal(first.kind, 'COMPLETED');
    if (first.kind === 'COMPLETED') assert.equal(first.finalStatus, 'STOPPED_MAX_ITERATIONS');

    const state = JSON.parse(await readFile(stateFile(projectPath), 'utf8'));
    assert.equal(state.maxIterations, 1);
    await writeState(projectPath, { ...state, status: 'RESPONSE_PARSED', iteration: 1 });
    const resumed = await engine.resume();
    assert.equal(resumed.kind, 'COMPLETED');
    if (resumed.kind === 'COMPLETED') {
      assert.equal(resumed.finalStatus, 'STOPPED_MAX_ITERATIONS');
      assert.equal(resumed.iterations, 0, 'must not run past the original cap of 1');
    }
  }));

// ---------------------------------------------------------------------------
// Session history / artifacts / events
// ---------------------------------------------------------------------------

test('listSessions() and getSessionArtifacts() describe a completed run from the existing on-disk layout', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });

    const sessions = await engine.listSessions();
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.equal(s.status, 'DONE');
    assert.equal(s.iterations, 2);
    assert.equal(s.isCurrent, true);
    assert.ok(s.startedAt && s.endedAt && s.endedAt >= s.startedAt);

    const artifacts = await engine.getSessionArtifacts(s.runId);
    assert.ok(artifacts);
    assert.equal(artifacts.iterations.length, 2);
    const first = artifacts.iterations[0];
    assert.equal(first.claudePrompt?.text, 'Create src/sum.js');
    assert.equal(first.report.availability, 'AVAILABLE');
    if (first.report.availability === 'AVAILABLE') {
      assert.equal(first.report.source, 'REPORT_FILE');
      assert.equal(first.report.verification, 'VERIFIED');
      assert.equal(first.report.sha256, first.integrity?.reportHash);
    }
    assert.match(first.codexResponse?.text ?? '', /<STATUS>CONTINUE<\/STATUS>/);
    // The prompt Claude got in iteration 2 is byte-for-byte what Codex's PROMPT said.
    assert.equal(artifacts.iterations[1].claudePrompt?.sha256, first.extractedPrompt?.sha256);
    assert.equal(first.extractedPrompt?.sha256, first.integrity?.promptHash);
    assert.ok(artifacts.events.every((e) => e.runId === s.runId));
    assert.ok(artifacts.events.some((e) => e.event === 'RUN_COMPLETED'));
    assert.equal(artifacts.state?.runId, s.runId);
  }));

test('an older session whose shared report file was overwritten gets its report back from what was sent to Codex', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'first task' });
    const [firstRun] = await engine.listSessions();
    const before = await engine.getSessionArtifacts(firstRun.runId);
    const originalReportHash = before?.iterations[0].integrity?.reportHash;

    // Simulate a later session overwriting reports/001-report.md.
    await writeFile(path.join(projectPath, '.ai-bridge', 'reports', '001-report.md'), '# AI Bridge Report\n\nsomething else\n', 'utf8');
    const report = (await engine.getSessionArtifacts(firstRun.runId))?.iterations[0].report;
    assert.equal(report?.availability, 'AVAILABLE');
    if (report?.availability === 'AVAILABLE') {
      assert.equal(report.source, 'CODEX_INPUT');
      assert.equal(report.verification, 'VERIFIED');
      assert.equal(report.sha256, originalReportHash);
    }
  }));

test('getSessionArtifacts() refuses anything that is not a well-formed run id (no path traversal)', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    for (const bad of ['..', '../state', '2026-09-26_001/../../x', 'C:\\Windows', '', '2026-09-26_1']) {
      assert.equal(await engine.getSessionArtifacts(bad), null, bad);
    }
    assert.equal(await engine.getSessionArtifacts('2099-01-01_001'), null);
  }));

test('recentEvents() returns the newest structured events and skips a torn line instead of failing', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    await appendFile(path.join(projectPath, '.ai-bridge', 'logs', 'events.jsonl'), '{"timestamp":"2026-', 'utf8');
    const events = await engine.recentEvents(3);
    assert.equal(events.length, 3);
    assert.equal(events[events.length - 1].event, 'RUN_COMPLETED');
  }));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('getConfig()/saveConfig() round-trip a valid config and reject an invalid one with Core validation errors', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const initial = await engine.getConfig();
    assert.equal(initial.exists, false);
    assert.deepEqual(initial.config, DEFAULT_CONFIG);

    const invalid = await engine.saveConfig({ ...DEFAULT_CONFIG, maxIterations: 0, apiKey: 'x' });
    assert.equal(invalid.kind, 'INVALID');
    if (invalid.kind === 'INVALID') {
      assert.ok(invalid.errors.some((e) => e.includes('maxIterations')));
      assert.ok(invalid.errors.some((e) => e.includes('apiKey')));
    }
    assert.equal((await engine.getConfig()).exists, false, 'nothing written for an invalid config');

    const saved = await engine.saveConfig({ ...DEFAULT_CONFIG, maxIterations: 3 });
    assert.equal(saved.kind, 'SAVED');
    const reread = await engine.getConfig();
    assert.equal(reread.exists, true);
    assert.equal(reread.config.maxIterations, 3);
    assert.deepEqual(reread.errors, []);
  }));

test('saveConfig() refuses while a session is running', () =>
  withProject(async (projectPath) => {
    await writeLock(projectPath, 4242);
    const outcome = await makeEngine(projectPath, { isPidAlive: () => true }).saveConfig(DEFAULT_CONFIG);
    assert.deepEqual(outcome, { kind: 'REFUSED_RUNNING', pid: 4242 });
  }));
