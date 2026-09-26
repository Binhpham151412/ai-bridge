import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine } from '../../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../../src/core/config/config.ts';
import { sha256Text } from '../../src/core/integrity/integrity.ts';
import type { BridgeEvent } from '../../src/core/observability/events.ts';
import { RunController } from '../../src/desktop/main/run-controller.ts';
import { forkRunHost } from '../../src/desktop/main/fork-run-host.ts';
import { eventKey } from '../../src/desktop/renderer/lib/events-store.ts';
import type { BridgeSnapshot } from '../../src/desktop/shared/ipc-contract.ts';

// Main ⇄ run host ⇄ BridgeEngine integration: a real RunController forks a real run
// host process (tests/fixtures/desktop/fake-run-host.ts — the production serveRunHost
// with fake CLIs), exactly as Electron Main does. Only Electron itself is absent.

const FAKE_HOST = fileURLToPath(new URL('../fixtures/desktop/fake-run-host.ts', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex/fake-codex.mjs', import.meta.url));

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function makeController(hostEnv: Record<string, string> = {}): { controller: RunController; events: BridgeEvent[] } {
  const controller = new RunController({
    createEngine: (projectPath) =>
      new BridgeEngine(projectPath, {
        runDoctor: async () => ({
          report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
          claudeExe: process.execPath,
          codexExe: process.execPath,
          config: DEFAULT_CONFIG,
          configErrors: [],
          gitWarning: null,
        }),
        claudeCommandArgsPrefix: [FAKE_CLAUDE],
        codexCommandArgsPrefix: [FAKE_CODEX],
      }),
    forkRunHost: () => forkRunHost({ scriptPath: FAKE_HOST, execPath: process.execPath, env: { ...process.env, ...hostEnv } }),
    activePollMs: 100,
    idlePollMs: 1000,
  });
  const events: BridgeEvent[] = [];
  controller.onEvent((e) => events.push(e));
  return { controller, events };
}

async function waitFor(controller: RunController, predicate: (s: BridgeSnapshot) => boolean, timeoutMs = 20_000): Promise<BridgeSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await controller.getSnapshot();
    if (predicate(snapshot)) return snapshot;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last snapshot: ${JSON.stringify(snapshot)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-desktop-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const project = (p: string) => ({ path: p, name: path.basename(p) });
const finished = (s: BridgeSnapshot) => !s.runAttached && s.pendingAction === null && s.status?.status !== 'RUNNING';

test('start → live events → DONE, with each event delivered exactly once', () =>
  withProject(async (projectPath) => {
    const { controller, events } = makeController();
    try {
      await controller.setProject(project(projectPath));
      assert.deepEqual((await controller.getSnapshot()).controls, { canStart: true, canPause: false, canResume: false, stopMode: null });

      const res = await controller.start({ task: 'Create src/sum.js', maxIterations: 5 });
      assert.deepEqual(res, { ok: true });
      const done = await waitFor(controller, (s) => finished(s) && s.status?.status === 'DONE');

      assert.equal(done.status?.iteration, 2);
      assert.equal(done.status?.maxIterations, 5);
      assert.equal(done.lastError, null);
      assert.deepEqual(done.lastOutcome, { kind: 'COMPLETED', finalStatus: 'DONE', iterations: 2, errorCode: null });
      assert.equal(done.controls.canStart, true);
      const names = events.map((e) => e.event);
      for (const expected of ['RUN_STARTED', 'CLAUDE_STARTED', 'CLAUDE_EXITED', 'REPORT_DETECTED', 'REPORT_VALIDATED', 'CODEX_STARTED', 'CODEX_EXITED', 'RESPONSE_PARSED', 'RUN_COMPLETED']) {
        assert.ok(names.includes(expected as BridgeEvent['event']), expected);
      }
      assert.equal(new Set(events.map(eventKey)).size, events.length, 'no duplicated events');
    } finally {
      controller.dispose();
    }
  }));

test('actions the current state does not allow are refused by Main (never forwarded to Core)', () =>
  withProject(async (projectPath) => {
    const { controller } = makeController();
    try {
      const noProject = await controller.start({ task: 'x' });
      assert.equal(noProject.ok, false);
      await controller.setProject(project(projectPath));
      for (const res of [await controller.pause(), await controller.resume(), await controller.stop(), await controller.discard()]) {
        assert.equal(res.ok, false);
        if (!res.ok) assert.equal(res.error.code, 'NOT_ALLOWED');
      }
    } finally {
      controller.dispose();
    }
  }));

test('pause is cooperative (PAUSED at a safe boundary) and resume continues with the exact persisted prompt', () =>
  withProject(async (projectPath) => {
    const { controller, events } = makeController({ FAKE_CLAUDE_DELAY_MS: '1500' });
    try {
      await controller.setProject(project(projectPath));
      await controller.start({ task: 'Create src/sum.js' });
      // PAUSE is only offered once iteration 1 has started (see controls.ts).
      await waitFor(controller, (s) => s.controls.canPause);
      const paused = await controller.pause();
      assert.equal(paused.ok, true);

      const snap = await waitFor(controller, (s) => finished(s) && s.status?.status === 'PAUSED');
      assert.equal(snap.status?.iteration, 1, 'iteration 1 finished normally — nothing was killed');
      assert.equal(snap.recovery.kind, 'RECOVERABLE');
      assert.deepEqual(snap.controls, { canStart: false, canPause: false, canResume: true, stopMode: 'DISCARD' });
      assert.ok(events.some((e) => e.event === 'PAUSE_REQUESTED'));
      assert.ok(events.some((e) => e.event === 'PAUSED'));

      assert.deepEqual(await controller.resume(), { ok: true });
      const done = await waitFor(controller, (s) => finished(s) && s.status?.status === 'DONE');
      assert.equal(done.status?.iteration, 2);

      const sessionDir = path.join(projectPath, '.ai-bridge', 'sessions', done.status!.runId!);
      const extracted = await readFile(path.join(sessionDir, '001-extracted-prompt.md'), 'utf8');
      const sent = await readFile(path.join(sessionDir, '002-claude-prompt.md'), 'utf8');
      assert.equal(sha256Text(sent), sha256Text(extracted), 'prompt sent after resume is byte-identical');
    } finally {
      controller.dispose();
    }
  }));

test('crash of the Core process → INTERRUPTED + RECOVERABLE; after an app restart, resume keeps prompt/hash continuity', () =>
  withProject(async (projectPath) => {
    const first = makeController({ AI_BRIDGE_CRASH_AT: 'AFTER_PROMPT_PERSISTED' });
    let runId: string;
    try {
      await first.controller.setProject(project(projectPath));
      await first.controller.start({ task: 'Create src/sum.js' });
      const crashed = await waitFor(first.controller, (s) => finished(s) && s.lastError !== null);
      assert.equal(crashed.lastError?.code, 'CORE_PROCESS_EXITED');
      assert.match(crashed.lastError?.details ?? '', /exit code: 137/);
      assert.equal(crashed.status?.status, 'INTERRUPTED');
      assert.equal(crashed.recovery.kind, 'RECOVERABLE');
      runId = crashed.status!.runId!;
    } finally {
      first.controller.dispose(); // the "app" goes away
    }

    // "App restart": a brand-new controller + engine, no crash injection.
    const second = makeController();
    try {
      await second.controller.setProject(project(projectPath));
      const reopened = await second.controller.getSnapshot();
      assert.equal(reopened.recovery.kind, 'RECOVERABLE');
      if (reopened.recovery.kind === 'RECOVERABLE') {
        assert.equal(reopened.recovery.runId, runId);
        assert.equal(reopened.recovery.strategy, 'CONTINUE_FROM_PROMPT');
      }
      assert.equal(reopened.controls.canResume, true);
      assert.equal(reopened.controls.canStart, false, 'a recoverable session is not silently overwritten by START');

      assert.deepEqual(await second.controller.resume(), { ok: true });
      const done = await waitFor(second.controller, (s) => finished(s) && s.status?.status === 'DONE');
      assert.equal(done.status?.runId, runId, 'same session continued');

      const sessionDir = path.join(projectPath, '.ai-bridge', 'sessions', runId);
      const integrity = JSON.parse(await readFile(path.join(sessionDir, '001-integrity.json'), 'utf8'));
      const extracted = await readFile(path.join(sessionDir, '001-extracted-prompt.md'), 'utf8');
      const sent = await readFile(path.join(sessionDir, '002-claude-prompt.md'), 'utf8');
      assert.equal(sha256Text(extracted), integrity.promptHash);
      assert.equal(sha256Text(sent), integrity.promptHash, 'prompt after recovery matches the pre-crash hash');
    } finally {
      second.controller.dispose();
    }
  }));

test('a crash mid-Claude is RECOVERY BLOCKED: no resume offered, START allowed, DISCARD clears it', () =>
  withProject(async (projectPath) => {
    const { controller } = makeController({ AI_BRIDGE_CRASH_AT: 'AFTER_CLAUDE_STARTED' });
    try {
      await controller.setProject(project(projectPath));
      await controller.start({ task: 'Create src/sum.js' });
      const snap = await waitFor(controller, (s) => finished(s) && s.recovery.kind === 'BLOCKED');
      assert.equal(snap.status?.status, 'INTERRUPTED');
      assert.deepEqual(snap.controls, { canStart: true, canPause: false, canResume: false, stopMode: 'DISCARD' });
      assert.equal((await controller.resume()).ok, false);

      assert.equal((await controller.discard()).ok, true);
      const after = await controller.getSnapshot();
      assert.equal(after.status?.status, 'NOT_STARTED');
      assert.equal(after.recovery.kind, 'NONE');
    } finally {
      controller.dispose();
    }
  }));

test('STOP goes through Core process management: host + Claude process tree are gone, session is STOPPED', { timeout: 60_000 }, () =>
  withProject(async (projectPath) => {
    const { controller, events } = makeController({ FAKE_CLAUDE_MODE: 'hang' });
    try {
      await controller.setProject(project(projectPath));
      await controller.start({ task: 'never finishes' });
      const running = await waitFor(controller, (s) => s.status?.status === 'RUNNING' && s.status.claude.pid !== null);
      const claudePid = running.status!.claude.pid!;
      const hostPid = JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), 'utf8')).pid as number;
      assert.ok(isPidAlive(claudePid) && isPidAlive(hostPid));

      const res = await controller.stop();
      assert.equal(res.ok, true);
      const stopped = await waitFor(controller, (s) => finished(s));
      assert.equal(stopped.status?.status, 'STOPPED');
      assert.equal(stopped.recovery.kind, 'NONE');
      assert.equal(stopped.lastError, null, 'a requested stop is not reported as a crash');
      assert.ok(events.some((e) => e.event === 'RUN_STOPPED'));

      const deadline = Date.now() + 10_000;
      while ((isPidAlive(claudePid) || isPidAlive(hostPid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      assert.equal(isPidAlive(hostPid), false, 'run host is gone');
      assert.equal(isPidAlive(claudePid), false, 'Claude (grandchild) is gone — no orphan');
    } finally {
      controller.dispose();
    }
  }));
