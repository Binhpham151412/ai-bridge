import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine } from '../../src/core/bridge-engine.ts';
import type { BridgeEvent } from '../../src/core/observability/events.ts';
import { acquireLock, releaseLock } from '../../src/core/lock/run-lock.ts';
import { forkRunHost } from '../../src/desktop/main/fork-run-host.ts';
import { ForkedExecutionPort, sumReportedTokens, summarizeOutcome } from '../../src/hosts/forked-execution-port.ts';
import type { SessionArtifacts } from '../../src/core/session-history/session-history.ts';

// M5.4: the ExecutionPort over real, forked Execution Hosts (the production serveRunHost,
// tests/fixtures/workflow/fake-execution-host.ts) with fake Claude/Codex CLIs. No real CLI,
// no quota. This test process plays the Workflow Host.

const HOST = fileURLToPath(new URL('../fixtures/workflow/fake-execution-host.ts', import.meta.url));
const ATTEMPT = 'wf_2026-10-01_001/build/1';
const LONG = { timeout: 90_000 };

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-exec-port-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makePort(projectPath: string, hostEnv: Record<string, string> = {}) {
  const infoFile = path.join(projectPath, 'host-info.json');
  let spawned = 0;
  const port = new ForkedExecutionPort({
    projectPath,
    // In-process engine: status/read + stop/pause only (no doctor, no CLI spawned here).
    engine: new BridgeEngine(projectPath),
    spawnHost: () => {
      spawned += 1;
      return forkRunHost({ scriptPath: HOST, execPath: process.execPath, env: { ...process.env, FAKE_HOST_INFO_FILE: infoFile, ...hostEnv } });
    },
  });
  return { port, spawned: () => spawned, info: async () => JSON.parse(await readFile(infoFile, 'utf8')) };
}

const request = (o: Partial<{ task: string; maxIterations: number; correlation: string }> = {}) => ({ attemptId: ATTEMPT, task: 'Create src/sum.js', maxIterations: 5, ...o });

async function waitUntil<T>(probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function sessionCount(projectPath: string): Promise<number> {
  return (await readdir(path.join(projectPath, '.ai-bridge', 'sessions')).catch(() => [])).length;
}

// ---------------------------------------------------------------------------
// A. contract: start → events → outcome; host lifecycle
// ---------------------------------------------------------------------------

test('start runs one execution in its own Execution Host; events and the outcome come back', LONG, () =>
  withProject(async (projectPath) => {
    const { port, spawned, info } = makePort(projectPath);
    const events: BridgeEvent[] = [];
    const r = await port.start(request(), (e) => events.push(e));

    assert.equal(r.hostFailure, null);
    assert.equal(r.summary.kind, 'ENDED');
    if (r.summary.kind !== 'ENDED') return;
    assert.equal(r.summary.finalStatus, 'DONE');
    assert.equal(r.summary.iterations, 2);
    assert.match(r.summary.executionId, /^\d{4}-\d{2}-\d{2}_\d{3}$/);
    assert.equal(r.executionId, r.summary.executionId);
    assert.equal(r.outcome?.kind, 'COMPLETED');

    assert.equal(events[0].event, 'RUN_STARTED');
    assert.ok(events.some((e) => e.event === 'RUN_COMPLETED'));
    assert.ok(events.every((e) => e.runId === r.executionId));

    assert.equal(spawned(), 1, 'exactly one host for one execution');
    assert.deepEqual(r.hostExit && { code: r.hostExit.code, signal: r.hostExit.signal }, { code: 0, signal: null }, 'the host exits cleanly after its one run');
    const hostInfo = await info();
    assert.equal(hostInfo.ppid, process.pid, 'the Execution Host is a child of the Workflow Host');
    assert.equal(hostInfo.pid, r.hostPid);
    assert.notEqual(r.hostPid, process.pid);
    assert.equal(isPidAlive(r.hostPid!), false);
    assert.equal(await sessionCount(projectPath), 1);
  }));

test('status / checkRecovery / artifacts / findExecutions pass through to BridgeEngine', LONG, () =>
  withProject(async (projectPath) => {
    const { port } = makePort(projectPath);
    const before = new Date(Date.now() - 1000).toISOString();
    const r = await port.start(request());
    const status = await port.status();
    assert.equal(status.runId, r.executionId);
    assert.equal(status.status, 'DONE');
    assert.deepEqual(await port.checkRecovery(), { kind: 'NONE' });
    assert.equal((await port.artifacts(r.executionId!))?.runId, r.executionId);
    assert.deepEqual(
      (await port.findExecutions({ startedAfter: before })).map((s) => s.runId),
      [r.executionId],
    );
    assert.deepEqual(await port.findExecutions({ startedAfter: '2999-01-01T00:00:00.000Z' }), []);
  }));

// ---------------------------------------------------------------------------
// D. correlation round trip
// ---------------------------------------------------------------------------

test('correlation round trip: caller → host → BridgeEngine → RUN_STARTED → current-session.json, exact', LONG, () =>
  withProject(async (projectPath) => {
    const { port, info } = makePort(projectPath);
    const correlation = 'wf_2026-10-01_001/implement-feature/1 ünïcode ✓';
    const events: BridgeEvent[] = [];
    const r = await port.start(request({ correlation }), (e) => events.push(e));
    assert.equal(r.hostFailure, null);

    assert.equal((await info()).startOptions.correlation, correlation, 'the host passed it to BridgeEngine.start');
    const runStarted = events.find((e) => e.event === 'RUN_STARTED')!;
    assert.equal(runStarted.correlation, correlation, 'RUN_STARTED carries it');
    const state = JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'state', 'current-session.json'), 'utf8'));
    assert.equal(state.correlation, correlation, 'persisted in current-session.json');
    const logged = (await readFile(path.join(projectPath, '.ai-bridge', 'logs', 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.event === 'RUN_STARTED');
    assert.equal(logged.correlation, correlation, 'and in the run event log');
    assert.equal(r.correlation, correlation);
    assert.equal(r.observedCorrelation, correlation);
    assert.equal((await port.artifacts(r.executionId!))?.state?.correlation, correlation, 'readable back through the port');
  }));

test('the correlation defaults to the attemptId', LONG, () =>
  withProject(async (projectPath) => {
    const { port } = makePort(projectPath);
    const r = await port.start(request());
    assert.equal(r.correlation, ATTEMPT);
    assert.equal(r.observedCorrelation, ATTEMPT);
  }));

test('a correlation mismatch on RUN_STARTED is reported as a host failure, never trusted', LONG, () =>
  withProject(async (projectPath) => {
    const { port, spawned } = makePort(projectPath, { FAKE_HOST_MODE: 'tamper-correlation' });
    const r = await port.start(request());
    assert.equal(r.summary.kind, 'HOST_FAILED');
    assert.equal(r.hostFailure?.kind, 'CORRELATION_MISMATCH');
    assert.equal(r.observedCorrelation, 'tampered-by-host');
    assert.ok(r.outcome, 'the outcome is kept for the reconciler (M5.6)');
    assert.equal(r.summary.kind === 'HOST_FAILED' && r.summary.executionId, r.executionId);
    assert.equal(spawned(), 1, 'no retry');
  }));

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

test('a start BridgeEngine refuses maps to NOT_STARTED: preflight, lock held, invalid options', LONG, () =>
  withProject(async (projectPath) => {
    const doctorFail = await makePort(projectPath, { FAKE_HOST_MODE: 'doctor-fail' }).port.start(request());
    assert.deepEqual(doctorFail.summary, { kind: 'NOT_STARTED', reason: 'BLOCKED_PREFLIGHT' });
    assert.equal(doctorFail.hostFailure, null);

    const lockPath = path.join(projectPath, '.ai-bridge', 'state', 'lock');
    await mkdir(path.dirname(lockPath), { recursive: true });
    assert.equal((await acquireLock(lockPath)).ok, true);
    try {
      assert.deepEqual((await makePort(projectPath).port.start(request())).summary, { kind: 'NOT_STARTED', reason: 'ALREADY_RUNNING' });
    } finally {
      await releaseLock(lockPath);
    }

    assert.deepEqual((await makePort(projectPath).port.start(request({ maxIterations: 101 }))).summary, { kind: 'NOT_STARTED', reason: 'INVALID_OPTIONS' });
    assert.deepEqual((await makePort(projectPath).port.start(request({ correlation: 'bad\ncorrelation' }))).summary, { kind: 'NOT_STARTED', reason: 'INVALID_OPTIONS' });
    assert.equal(await sessionCount(projectPath), 0, 'no refused start created a session');
  }));

// ---------------------------------------------------------------------------
// C. host failure
// ---------------------------------------------------------------------------

test('a host that crashes mid-run → HOST_FAILED with the facts; no retry, no second execution', LONG, () =>
  withProject(async (projectPath) => {
    const { port, spawned } = makePort(projectPath, { AI_BRIDGE_CRASH_AT: 'AFTER_CLAUDE_STARTED' });
    const r = await port.start(request());
    assert.equal(r.summary.kind, 'HOST_FAILED');
    assert.equal(r.hostFailure?.kind, 'EXITED_WITHOUT_OUTCOME');
    assert.equal(r.hostExit?.code, 137);
    assert.match(r.executionId ?? '', /^\d{4}-\d{2}-\d{2}_\d{3}$/, 'the runId is known from RUN_STARTED');
    assert.equal(r.summary.kind === 'HOST_FAILED' && r.summary.executionId, r.executionId);
    assert.equal(r.observedCorrelation, ATTEMPT, 'the correlation was seen before the crash');
    assert.equal(r.outcome, null);
    assert.equal(spawned(), 1, 'the port never relaunches');
    assert.equal(await sessionCount(projectPath), 1, 'no duplicate execution');
    assert.equal((await port.status()).status, 'INTERRUPTED', 'the facts are left for the reconciler (M5.6)');
  }));

test('a host exception is HOST_REPORTED_FAILURE', LONG, () =>
  withProject(async (projectPath) => {
    const r = await makePort(projectPath, { FAKE_HOST_MODE: 'throw' }).port.start(request());
    assert.equal(r.summary.kind, 'HOST_FAILED');
    assert.equal(r.hostFailure?.kind, 'HOST_REPORTED_FAILURE');
    assert.match(r.hostFailure?.message ?? '', /simulated host exception/);
    assert.equal(r.executionId, null);
  }));

test('malformed host messages are ignored and counted, never acted on', LONG, () =>
  withProject(async (projectPath) => {
    const r = await makePort(projectPath, { FAKE_HOST_MODE: 'garbage' }).port.start(request());
    assert.equal(r.invalidMessages, 3);
    assert.equal(r.summary.kind, 'ENDED');
    assert.equal(r.hostFailure, null);
  }));

test('a host that cannot be created → SPAWN_FAILED', LONG, () =>
  withProject(async (projectPath) => {
    const throwing = new ForkedExecutionPort({
      projectPath,
      engine: new BridgeEngine(projectPath),
      spawnHost: () => {
        throw new Error('fork refused');
      },
    });
    const a = await throwing.start(request());
    assert.equal(a.hostFailure?.kind, 'SPAWN_FAILED');
    assert.equal(a.summary.kind, 'HOST_FAILED');

    // A process that never got a pid (what forkRunHost reports when spawning fails). Not
    // provoked with a real fork of a missing executable: on Windows, Node 24 aborts the
    // *parent* process on a failed fork with an IPC channel (an internal assertion in
    // InternalCallbackScope::Close) — a runtime bug; production always forks process.execPath.
    const noPid = new ForkedExecutionPort({
      projectPath,
      engine: new BridgeEngine(projectPath),
      spawnHost: () => {
        const exitListeners: ((e: { code: number | null; signal: string | null; stderrTail: string }) => void)[] = [];
        return {
          pid: undefined,
          send: () => setImmediate(() => exitListeners.forEach((l) => l({ code: null, signal: null, stderrTail: 'spawn ENOENT' }))),
          onMessage: () => {},
          onExit: (l) => exitListeners.push(l),
        };
      },
    });
    const b = await noPid.start(request());
    assert.equal(b.hostFailure?.kind, 'SPAWN_FAILED');
    assert.match(b.hostFailure?.message ?? '', /spawn ENOENT/);
  }));

// ---------------------------------------------------------------------------
// E. stop isolation + busy
// ---------------------------------------------------------------------------

test('stop kills only the Execution Host tree: Workflow Host and unrelated processes survive; STOPPED is confirmed', { timeout: 90_000 }, () =>
  withProject(async (projectPath) => {
    const { port, spawned } = makePort(projectPath, { FAKE_CLAUDE_MODE: 'hang' });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', windowsHide: true });
    try {
      const running = port.start(request());
      const status = await waitUntil(() => port.status(), (s) => s.status === 'RUNNING' && s.claude.pid !== null);
      const claudePid = status.claude.pid!;
      const hostPid = JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), 'utf8')).pid as number;
      assert.notEqual(hostPid, process.pid, 'the lock holder is the Execution Host, not us');

      await assert.rejects(port.start(request()), /EXECUTION_PORT_BUSY/, 'one execution at a time');

      const stopped = await port.stop();
      assert.equal(stopped.kind, 'STOPPED');
      const r = await running;
      assert.equal(r.stopRequested, true);
      assert.equal(r.hostFailure, null, 'a requested stop is not a host failure');
      assert.deepEqual(r.summary.kind === 'ENDED' && [r.summary.finalStatus, r.summary.executionId], ['STOPPED', status.runId]);

      await waitUntil(async () => isPidAlive(hostPid) || isPidAlive(claudePid), (alive) => !alive, 15_000);
      assert.equal(isPidAlive(process.pid), true, 'the Workflow Host (this process) survives');
      assert.equal(isPidAlive(unrelated.pid!), true, 'an unrelated process is untouched');
      assert.equal(spawned(), 1);
    } finally {
      unrelated.kill();
    }
  }));

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

test('pause lands at an iteration boundary; resume runs the SAME execution in a new host, correlation intact', { timeout: 120_000 }, () =>
  withProject(async (projectPath) => {
    const { port, spawned } = makePort(projectPath, { FAKE_CLAUDE_DELAY_MS: '1500' });
    const correlation = 'wf_2026-10-01_001/build/1';
    const running = port.start(request({ correlation }));
    await waitUntil(() => port.status(), (s) => s.status === 'RUNNING' && s.iteration >= 1);
    assert.deepEqual(await port.pause(), { kind: 'PAUSED' });
    const first = await running;
    assert.deepEqual(first.summary.kind === 'ENDED' && [first.summary.finalStatus, first.summary.iterations], ['PAUSED', 1]);

    const resumed = await port.resume({ executionId: first.executionId! });
    assert.equal(resumed.hostFailure, null);
    assert.equal(resumed.executionId, first.executionId, 'resume never creates a new execution');
    assert.deepEqual(resumed.summary.kind === 'ENDED' && [resumed.summary.finalStatus, resumed.summary.iterations], ['DONE', 1]);
    assert.equal(resumed.correlation, correlation, 'the persisted correlation is the expected one');
    assert.equal(resumed.observedCorrelation, correlation, 'RUN_STARTED of the resumed run carries it again');
    assert.equal(spawned(), 2, 'one host for the start, one for the resume');
    assert.equal(await sessionCount(projectPath), 1);
  }));

test('resume refuses a run that is not the current session (no host spawned) and maps BridgeEngine refusals', LONG, () =>
  withProject(async (projectPath) => {
    const { port, spawned } = makePort(projectPath);
    const notCurrent = await port.resume({ executionId: '2026-01-01_001' });
    assert.deepEqual(notCurrent.summary, { kind: 'RESUME_REFUSED', reason: 'NOT_CURRENT_SESSION' });
    assert.equal(spawned(), 0);

    const done = await port.start(request());
    const again = await port.resume({ executionId: done.executionId! });
    assert.deepEqual(again.summary, { kind: 'RESUME_REFUSED', reason: 'RECOVERY_BLOCKED' }, 'a DONE run is not resumable');
  }));

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('summarizeOutcome maps every BridgeRunOutcome kind and detects usage limits only for errors', () => {
  const doctorReport = { checks: [], overall: 'FAIL' as const };
  assert.deepEqual(summarizeOutcome({ kind: 'BLOCKED_PREFLIGHT', doctorReport }, null), { kind: 'NOT_STARTED', reason: 'BLOCKED_PREFLIGHT' });
  assert.deepEqual(summarizeOutcome({ kind: 'ALREADY_RUNNING', pid: 1, doctorReport }, null), { kind: 'NOT_STARTED', reason: 'ALREADY_RUNNING' });
  assert.deepEqual(summarizeOutcome({ kind: 'INVALID_OPTIONS', reason: 'x' }, null), { kind: 'NOT_STARTED', reason: 'INVALID_OPTIONS' });
  assert.deepEqual(summarizeOutcome({ kind: 'NO_STATE' }, null), { kind: 'RESUME_REFUSED', reason: 'NO_STATE' });
  assert.deepEqual(summarizeOutcome({ kind: 'RECOVERY_BLOCKED', reason: 'x', doctorReport }, null), { kind: 'RESUME_REFUSED', reason: 'RECOVERY_BLOCKED' });
  const completed = (errorCode: string | null, errorMessage: string | null) =>
    summarizeOutcome(
      { kind: 'COMPLETED', finalStatus: errorCode ? 'ERROR' : 'DONE', errorCode, errorMessage, iterations: 3, sessionDir: path.join('x', '2026-10-01_004'), claudeSessionId: null, codexThreadId: null, diagnostics: null, doctorReport },
      42,
    );
  assert.deepEqual(completed(null, "You've hit your usage limit"), { kind: 'ENDED', executionId: '2026-10-01_004', finalStatus: 'DONE', errorCode: null, iterations: 3, reportedTokens: 42, usageLimitDetected: false });
  assert.equal((completed('CLAUDE_RUN_FAILED:NON_ZERO_EXIT', "You've hit your usage limit · resets 5pm") as { usageLimitDetected: boolean }).usageLimitDetected, true);
  assert.equal((completed('CLAUDE_RUN_FAILED:NON_ZERO_EXIT', 'rate limit 429, retry later') as { usageLimitDetected: boolean }).usageLimitDetected, false);
});

test('sumReportedTokens counts only the segment after baseIteration and never estimates', () => {
  const view = (totalTokens: number | null) => ({ record: { usage: totalTokens === null ? null : { totalTokens } }, effectiveStatus: 'COMPLETED' });
  const artifacts = (its: [number, number | null, number | null][]) =>
    ({ runId: 'r', events: [], state: null, iterations: its.map(([iteration, c, x]) => ({ iteration, claudeExecution: view(c), codexExecution: view(x) })) }) as unknown as SessionArtifacts;
  assert.equal(sumReportedTokens(artifacts([[1, 10, 5], [2, 20, 7]]), 0), 42);
  assert.equal(sumReportedTokens(artifacts([[1, 10, 5], [2, 20, 7]]), 1), 27, 'a resumed segment does not recount iteration 1');
  assert.equal(sumReportedTokens(artifacts([[1, 10, null]]), 0), null, 'unknown usage stays UNKNOWN');
  assert.equal(sumReportedTokens(artifacts([]), 0), null);
  assert.equal(sumReportedTokens(null, 0), null);
});
