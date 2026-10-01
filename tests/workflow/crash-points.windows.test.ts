// M5.10 B″ (docs/59 §23) — REAL-PROCESS tests of the two TEST-ONLY Workflow Host crash points.
//
// Real processes throughout. THIS FILE, forked in child mode, is the Workflow Host: the production
// serveWorkflowHost + the production ExecutionPort (createExecutionPort, 'independent' Execution
// Hosts), wrapped by the crash decorator (scripts/real/m5.10-crash/crash-port.ts). The Execution
// Hosts are the production run host + BridgeEngine (tests/fixtures/workflow/fake-execution-host.ts);
// only the Claude/Codex CLIs are fake (no quota). The preflight grace is shortened HERE ONLY — the
// crash app keeps the production ≈ 5 min (D3).
//
// The reconciler's decisions are NOT hard-coded: each persisted decision is replayed through the
// real, pure reconcileAttempt() over the evidence recorded for that moment, and must equal it.
// Windows only: J2 relies on the M5.8.1 lifetime (the Execution Host outlives its Workflow Host).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeEngine } from '../../src/core/bridge-engine.ts';
import { isPidAlive } from '../../src/core/lock/run-lock.ts';
import { readEventLog } from '../../src/core/workflow/event-log.ts';
import { reconcileAttempt, type ReconcileFacts, type ReconcileSession } from '../../src/core/workflow/reconciler.ts';
import { WorkflowStore } from '../../src/core/workflow/store.ts';
import type { WorkflowAttempt, WorkflowEvent } from '../../src/core/workflow/types.ts';
import { forkChildHost } from '../../src/desktop/main/fork-run-host.ts';
import type { RunHostExit } from '../../src/desktop/main/run-controller.ts';
import { isWorkflowHostMessage, type WorkflowHostMessage } from '../../src/hosts/workflow-host-protocol.ts';
import { CRASH_ENV, CRASH_EXIT_CODE, MARKER_ENV } from '../../scripts/real/m5.10-crash/crash-config.ts';
import { step } from './definition-fixtures.ts';
import { aiBridgeOf, runCommand, until, withProject, writeDefinition } from './host-fixtures.ts';

const THIS_FILE = fileURLToPath(import.meta.url);
const FAKE_EXECUTION_HOST = fileURLToPath(new URL('../fixtures/workflow/fake-execution-host.ts', import.meta.url));
const CHILD_FLAG = 'M510_CRASH_POINTS_CHILD';
const GRACE_MS = 3000;

if (process.env[CHILD_FLAG] === '1') {
  // Child mode: this process IS the Workflow Host under test (node:test is never loaded here).
  const { serveCrashWorkflowHost } = await import('../../scripts/real/m5.10-crash/crash-port.ts');
  serveCrashWorkflowHost({
    runHostScript: FAKE_EXECUTION_HOST,
    execPath: process.execPath,
    hostEnv: process.env,
    engine: { pollIntervalMs: 50, preflightGraceMs: GRACE_MS },
    controlPollMs: 50,
  });
} else {
  await registerTests();
}

async function registerTests(): Promise<void> {
  const { test } = await import('node:test');
  const WINDOWS = process.platform === 'win32';
  const windowsOnly = (timeout: number) => ({ timeout, skip: WINDOWS ? false : 'Windows-only: asserts the real Windows Workflow/Execution Host lifetime' });
  const ONE_STEP = { schema: 1, id: 'crash-flow', version: 1, title: 'Crash flow', steps: [step('build')] };
  /** Reads of BridgeEngine's state files, at a production-like cadence (see host-fixtures `until`). */
  const STATUS_POLL_MS = 200;

  /** Pids seen to end: a live process with such a pid later is someone else's (pid reuse). */
  const confirmedDead = new Set<number>();
  const untilDead = async (pids: number[], timeoutMs = 20_000) => {
    await until(() => pids.every((pid) => !isPidAlive(pid)), timeoutMs, `pids ${pids.join(', ')} to end`);
    for (const pid of pids) confirmedDead.add(pid);
  };
  /** Safety net after a FAILED assertion: never a tree kill, never a pid already seen dead. */
  const reap = (pids: (number | null | undefined)[]) => {
    for (const pid of pids) {
      if (typeof pid !== 'number' || confirmedDead.has(pid) || !isPidAlive(pid)) continue;
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
  };

  interface HostHandle {
    pid: number;
    messages: WorkflowHostMessage[];
    exited: Promise<RunHostExit>;
    send(m: unknown): void;
  }
  /** Forked exactly as Electron Main forks the Workflow Host (default 'with-parent' lifetime). */
  function crashWorkflowHost(p: string, env: Record<string, string>): HostHandle {
    const { NODE_TEST_CONTEXT: _runner, ...base } = process.env;
    const child = forkChildHost<unknown>({
      scriptPath: THIS_FILE,
      execPath: process.execPath,
      env: { ...base, [CHILD_FLAG]: '1', FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1', FAKE_HOST_INFO_FILE: path.join(p, 'execution-host.json'), ...env },
    });
    const messages: WorkflowHostMessage[] = [];
    child.onMessage((m) => {
      if (isWorkflowHostMessage(m)) messages.push(m);
    });
    const exited = new Promise<RunHostExit>((resolve) =>
      child.onExit((exit) => {
        confirmedDead.add(child.pid!);
        resolve(exit);
      }),
    );
    return { pid: child.pid!, messages, exited, send: (m) => child.send(m) };
  }
  const ended = (h: HostHandle) => h.messages.flatMap((m) => (m.type === 'ended' ? [m.end] : []))[0];

  /** The durable workflow record, read the way a restarted host reads it (chain verified). */
  async function persisted(p: string, workflowId: string) {
    const loaded = await new WorkflowStore(aiBridgeOf(p)).load(workflowId, { repair: false });
    assert.ok(loaded.ok, 'the instance loads');
    const log = await readEventLog(path.join(aiBridgeOf(p), 'workflows', 'instances', workflowId, 'events.jsonl'), workflowId);
    assert.ok(log.ok, 'the event log verifies (hash chain)');
    return { instance: loaded.handle.instance, lastSeq: loaded.handle.lastSeq, events: log.events };
  }
  const count = (evs: WorkflowEvent[], type: string) => evs.filter((e) => e.type === type).length;
  const inputs = (evs: WorkflowEvent[], type: string) =>
    evs.filter((e) => e.type === 'INPUT_RECEIVED' && e.payload.inputType === type).map((e) => ({ at: e.timestamp, input: JSON.parse(String(e.payload.input)) as Record<string, any> }));
  const sessionsOf = async (p: string) => (await readdir(path.join(aiBridgeOf(p), 'sessions')).catch(() => [] as string[])).sort();
  const statusLines = async (marker: string) => (await readFile(`${marker}.status.jsonl`, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { pid: number; armed: boolean; spent?: boolean });
  /** The execution-side facts the engine's #facts() builds for the reconciler (sessions + RUN_STARTED correlation). */
  async function sessionFacts(p: string): Promise<ReconcileSession[]> {
    const engine = new BridgeEngine(p);
    const out: ReconcileSession[] = [];
    for (const s of await engine.listSessions()) {
      const started = (await engine.getSessionArtifacts(s.runId))?.events.find((e) => e.event === 'RUN_STARTED');
      out.push({ runId: s.runId, startedAt: s.startedAt, status: s.status, iterations: s.iterations, errorCode: s.errorCode, correlation: typeof started?.correlation === 'string' ? started.correlation : null });
    }
    return out;
  }
  async function runEndedAt(p: string, runId: string): Promise<string | null> {
    const events = (await new BridgeEngine(p).getSessionArtifacts(runId))?.events ?? [];
    return events.find((e) => e.event === 'RUN_COMPLETED' || e.event === 'RUN_STOPPED')?.timestamp ?? null;
  }
  const facts = (o: Partial<ReconcileFacts> & Pick<ReconcileFacts, 'nowMs' | 'sessions'>): ReconcileFacts => ({
    preflightGraceMs: GRACE_MS,
    current: { runId: null, status: 'NOT_STARTED' },
    recoverable: false,
    hostAlive: null,
    cliAlive: false,
    ...o,
  });

  // -------------------------------------------------------------------------

  test('J1 (fake CLIs): crash after the durable launch intent, before the Execution Host fork → no Execution Host, no session → a new Workflow Host waits out the preflight grace, the real reconciler finds NOT_STARTED, the SAME attempt is relaunched → exactly one execution', windowsOnly(120_000), (t) =>
    withProject(async (p) => {
      const hash = await writeDefinition(p, ONE_STEP);
      const marker = path.join(p, 'm510-crash-j1.marker');
      const env = { [CRASH_ENV]: 'BEFORE_EXECUTION_HOST_FORK', [MARKER_ENV]: marker };
      const a = crashWorkflowHost(p, env);
      let b: HostHandle | null = null;
      let executionHostPid: number | null = null;
      try {
        a.send(runCommand(p, hash, {}, ONE_STEP.id));
        const exitA = await a.exited;
        assert.equal(exitA.code, CRASH_EXIT_CODE, `the Workflow Host exited at the crash point (stderr: ${exitA.stderrTail})`);
        const fired = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; point: string };
        assert.deepEqual([fired.pid, fired.point], [a.pid, 'BEFORE_EXECUTION_HOST_FORK']);

        const [workflowId] = await new WorkflowStore(aiBridgeOf(p)).list();
        const atCrash = await persisted(p, workflowId);
        const attempt = atCrash.instance.steps[0].attempts[0];
        assert.equal(atCrash.instance.state, 'RUNNING');
        assert.equal(attempt.state, 'LAUNCHING', 'durable: the launch intent');
        assert.deepEqual([attempt.launches, attempt.executionId, attempt.hostPid ?? null], [1, null, null], 'not durable: a host pid, an execution');
        assert.equal(count(atCrash.events, 'ATTEMPT_LAUNCHING'), 1);
        assert.equal(inputs(atCrash.events, 'EXECUTION_HOST_SPAWNED').length, 0);
        assert.equal(existsSync(path.join(aiBridgeOf(p), 'workflows', 'instances', workflowId, 'attempts', 'build-1', 'task.md')), true, 'durable: task.md');
        assert.deepEqual(await sessionsOf(p), [], 'no execution session');
        assert.equal(existsSync(path.join(p, 'execution-host.json')), false, 'no Execution Host process was ever started');
        t.diagnostic(`crash: Workflow Host ${a.pid} exited ${exitA.code} at BEFORE_EXECUTION_HOST_FORK; attempt ${attempt.attemptId} LAUNCHING (launches 1, no hostPid); no Execution Host, no session`);

        b = crashWorkflowHost(p, env); // the same environment: the one-shot marker keeps it from firing again
        b.send({ type: 'resume', projectPath: p, workflowId });
        const exitB = await b.exited;
        assert.equal(exitB.code, 0, exitB.stderrTail);
        assert.equal(ended(b)?.state, 'COMPLETED');
        assert.deepEqual((await statusLines(marker)).map((l) => [l.pid, l.armed, l.spent]), [[a.pid, true, false], [b.pid, true, true]], 'the new Workflow Host was armed but spent: it did not fire');

        // The reconciler's decision, replayed over the evidence of that moment.
        const final = await persisted(p, workflowId);
        const after = final.events.filter((e) => e.seq > atCrash.lastSeq);
        const reconciled = after.filter((e) => e.type === 'RECONCILED');
        assert.equal(reconciled.length, 1, 'one persisted reconciler finding');
        const decision = reconciled[0];
        const sessionsAtDecision = (await sessionFacts(p)).filter((s) => s.startedAt !== null && s.startedAt <= decision.timestamp);
        const replay = reconcileAttempt(attempt, facts({ nowMs: Date.parse(decision.timestamp), sessions: sessionsAtDecision }));
        assert.equal(replay.action, 'FINDING', `replayed: ${JSON.stringify(replay)}`);
        assert.equal(decision.payload.finding, replay.finding.kind, 'the persisted finding is the real reconciler’s decision for that evidence');
        const waitedMs = Date.parse(decision.timestamp) - Date.parse(attempt.launchedAt!);
        t.diagnostic(`reconciler: ${decision.payload.finding} at +${waitedMs} ms after launchedAt (grace ${GRACE_MS} ms); sessions then: ${sessionsAtDecision.length}; replayed → ${replay.finding.kind}`);

        // Relaunch of the SAME attempt → exactly one execution.
        const attempts = final.instance.steps[0].attempts;
        assert.equal(attempts.length, 1, 'no second attempt');
        assert.equal(attempts[0].attemptId, attempt.attemptId);
        assert.equal(count(final.events, 'ATTEMPT_LAUNCHING'), 2, 'the launch intent, then the relaunch');
        assert.equal(attempts[0].launches, 2);
        assert.equal(inputs(after, 'EXECUTION_HOST_SPAWNED').length, 1, 'one Execution Host, spawned by the new Workflow Host');
        const sessions = await sessionsOf(p);
        assert.equal(sessions.length, 1, 'exactly ONE execution');
        assert.equal(attempts[0].executionId, sessions[0]);
        const [only] = await sessionFacts(p);
        assert.deepEqual([only.correlation, only.status, only.iterations], [attempt.attemptId, 'DONE', 1], 'RUN_STARTED carries the attemptId (ADR-017); one iteration');
        const info = JSON.parse(await readFile(path.join(p, 'execution-host.json'), 'utf8')) as { pid: number; ppid: number };
        executionHostPid = info.pid;
        assert.equal(info.ppid, b.pid, 'the only Execution Host is a child of the new Workflow Host');
        await untilDead([info.pid]);
        t.diagnostic(`relaunch: same attempt, launches ${attempts[0].launches}, sessions [${sessions.join(', ')}], one Execution Host ${info.pid} (parent ${b.pid}) → COMPLETED; no orphan`);
      } finally {
        reap([a.pid, b?.pid, executionHostPid]);
      }
    }));

  test('J2 (fake CLIs): crash when RUN_STARTED reaches the Workflow Host, before EXECUTION_LINKED → the Execution Host and its CLI survive → a new Workflow Host LINKs, then WATCHes/ADOPTs as the real reconciler decides → no duplicate execution', windowsOnly(120_000), (t) =>
    withProject(async (p) => {
      const hash = await writeDefinition(p, ONE_STEP);
      const marker = path.join(p, 'm510-crash-j2.marker');
      const env = { [CRASH_ENV]: 'ON_RUN_STARTED_BEFORE_LINK', [MARKER_ENV]: marker, FAKE_CLAUDE_DELAY_MS: '6000' };
      const a = crashWorkflowHost(p, env);
      let b: HostHandle | null = null;
      let executionHostPid: number | null = null;
      let cliPid: number | null = null;
      try {
        a.send(runCommand(p, hash, {}, ONE_STEP.id));
        const exitA = await a.exited;
        assert.equal(exitA.code, CRASH_EXIT_CODE, `the Workflow Host exited at the crash point (stderr: ${exitA.stderrTail})`);
        const fired = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; point: string };
        assert.deepEqual([fired.pid, fired.point], [a.pid, 'ON_RUN_STARTED_BEFORE_LINK']);

        const [workflowId] = await new WorkflowStore(aiBridgeOf(p)).list();
        const atCrash = await persisted(p, workflowId);
        const attempt = atCrash.instance.steps[0].attempts[0];
        assert.deepEqual([attempt.state, attempt.executionId], ['LAUNCHING', null], 'not durable: the link');
        assert.equal(count(atCrash.events, 'EXECUTION_LINKED'), 0, 'EXECUTION_LINKED was never committed');
        const info = JSON.parse(await readFile(path.join(p, 'execution-host.json'), 'utf8')) as { pid: number; ppid: number };
        executionHostPid = info.pid;
        assert.equal(info.ppid, a.pid, 'the Execution Host was forked by the crashed Workflow Host');
        assert.equal(isPidAlive(info.pid), true, 'the Execution Host survives its Workflow Host (independent)');
        const engine = new BridgeEngine(p);
        const run = await engine.status();
        assert.equal(run.status, 'RUNNING');
        const runId = run.runId!;
        const execSide = (await sessionFacts(p)).find((s) => s.runId === runId);
        assert.equal(execSide?.correlation, attempt.attemptId, 'durable on the execution side: RUN_STARTED with the attemptId');
        await until(async () => (await engine.status()).claude.pid !== null, 30_000, 'the fake Claude CLI', STATUS_POLL_MS);
        cliPid = (await engine.status()).claude.pid;
        assert.equal(isPidAlive(cliPid!), true, 'the provider CLI runs under the surviving Execution Host');
        t.diagnostic(`crash: Workflow Host ${a.pid} exited ${exitA.code} at RUN_STARTED; attempt LAUNCHING, not linked; hostPid persisted: ${attempt.hostPid ?? 'no'}; Execution Host ${info.pid} + CLI ${cliPid} alive; run ${runId} RUNNING (correlation ${execSide?.correlation})`);

        b = crashWorkflowHost(p, env);
        b.send({ type: 'resume', projectPath: p, workflowId });
        const exitB = await b.exited;
        assert.equal(exitB.code, 0, exitB.stderrTail);
        assert.equal(ended(b)?.state, 'COMPLETED');
        assert.deepEqual((await statusLines(marker)).map((l) => [l.pid, l.armed, l.spent]), [[a.pid, true, false], [b.pid, true, true]], 'the new Workflow Host was armed but spent: it did not fire');

        const final = await persisted(p, workflowId);
        const after = final.events.filter((e) => e.seq > atCrash.lastSeq);
        const endedAt = await runEndedAt(p, runId);
        assert.ok(endedAt, 'the execution recorded its own end');
        const [finalSession] = (await sessionFacts(p)).filter((s) => s.runId === runId);

        // 1. LINK — the real reconciler over the LAUNCHING attempt and the sessions recorded by then.
        const linked = inputs(after, 'EXECUTION_LINKED');
        assert.equal(linked.length, 1, 'one link');
        const linkReplay = reconcileAttempt(attempt, facts({ nowMs: Date.parse(linked[0].at), sessions: (await sessionFacts(p)).filter((s) => s.startedAt !== null && s.startedAt <= linked[0].at) }));
        assert.deepEqual(linkReplay, { action: 'LINK', executionId: linked[0].input.executionId }, 'the persisted link is the real reconciler’s decision');
        assert.equal(linked[0].input.executionId, runId, 'the SAME execution');

        // 2. WATCH while the run was running (if the run had not ended by then), then ADOPT its end.
        const linkedAttempt: WorkflowAttempt = { ...attempt, state: 'EXECUTING', executionId: runId };
        const watch = after.find((e) => e.type === 'RECONCILED' && e.payload.finding === 'WATCH');
        if (watch) {
          assert.ok(Date.parse(watch.timestamp) < Date.parse(endedAt), 'WATCH was decided while the run was still running');
          const running = { ...finalSession, status: 'RUNNING' };
          const watchReplay = reconcileAttempt(linkedAttempt, facts({ nowMs: Date.parse(watch.timestamp), current: { runId, status: 'RUNNING' }, sessions: [running] }));
          assert.deepEqual(watchReplay, { action: 'FINDING', finding: { kind: watch.payload.finding, executionId: watch.payload.executionId } }, 'the persisted WATCH is the real reconciler’s decision');
        }
        const adopted = inputs(after, 'EXECUTION_ENDED');
        assert.equal(adopted.length, 1, 'one outcome');
        const current = await engine.status();
        const adoptReplay = reconcileAttempt(linkedAttempt, facts({ nowMs: Date.parse(adopted[0].at), current: { runId: current.runId, status: current.status }, sessions: [finalSession] }));
        assert.deepEqual(adoptReplay, { action: 'ADOPT', result: adopted[0].input.result }, 'the persisted outcome is the real reconciler’s ADOPT of the run’s final facts');
        assert.equal(adopted[0].input.result.executionId, runId);
        t.diagnostic(`reconciler: LINK ${runId} → ${watch ? 'WATCH → ' : ''}ADOPT ${adopted[0].input.result.finalStatus} (run ended ${endedAt}); each replayed through reconcileAttempt → identical`);

        // 3. No duplicate execution.
        const attempts = final.instance.steps[0].attempts;
        assert.equal(attempts.length, 1);
        assert.deepEqual([attempts[0].executionId, attempts[0].launches], [runId, 1], 'never relaunched');
        assert.equal(count(final.events, 'ATTEMPT_LAUNCHING'), 1);
        assert.equal(inputs(after, 'EXECUTION_HOST_SPAWNED').length, 0, 'the new Workflow Host spawned ZERO Execution Hosts');
        assert.deepEqual(await sessionsOf(p), [runId], 'execution count = 1');
        assert.equal(finalSession.iterations, 1);
        await untilDead([info.pid, cliPid!]);
        t.diagnostic(`no duplicate: sessions [${runId}], launches 1, 0 new Execution Hosts; Execution Host ${info.pid} and CLI ${cliPid} ended by themselves`);
      } finally {
        reap([a.pid, b?.pid, executionHostPid, cliPid]);
      }
    }));
}
