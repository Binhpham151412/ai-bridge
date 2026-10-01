import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../../src/automation/process-runner.ts';
import { BridgeEngine } from '../../src/core/bridge-engine.ts';
import { isPidAlive } from '../../src/core/lock/run-lock.ts';
import { WorkflowStore } from '../../src/core/workflow/store.ts';
import type { WorkflowEvent } from '../../src/core/workflow/types.ts';
import { forkChildHost } from '../../src/desktop/main/fork-run-host.ts';
import type { RunHostExit } from '../../src/desktop/main/run-controller.ts';
import { isWorkflowHostMessage, type WorkflowHostMessage } from '../../src/hosts/workflow-host-protocol.ts';
import { getWorkflowSnapshot } from '../../src/hosts/workflow-read.ts';
import { step } from './definition-fixtures.ts';
import { aiBridgeOf, runCommand, sleep, until, withProject, writeDefinition } from './host-fixtures.ts';

// ============================================================================================
// WINDOWS PROCESS-LIFETIME INTEGRATION TESTS (M5.8.1) — isolated here on purpose.
//
// They assert the REAL Windows process model (Node/libuv kill-on-close job objects) with real
// processes: the production Workflow Host (serveWorkflowHost), the production ExecutionPort
// with its production 'independent' Execution Host lifetime (createExecutionPort), real
// Execution Hosts (the production run host + BridgeEngine), the WorkflowEngine and the M5.6
// reconciler. Only the provider executables are fake (fake Claude/Codex CLIs; no quota).
// Skipped on other platforms: their parent/child lifetime rules differ, and a pass there would
// prove nothing about Windows.
// ============================================================================================

const WINDOWS = process.platform === 'win32';
const windowsOnly = (timeout: number) => ({ timeout, skip: WINDOWS ? false : 'Windows-only: asserts real Windows job-object process lifetime' });

const CHAIN = fileURLToPath(new URL('../fixtures/process/lifetime-chain.ts', import.meta.url));
const WORKFLOW_HOST = fileURLToPath(new URL('../fixtures/workflow/fake-workflow-host.ts', import.meta.url));
const ONE_STEP = { schema: 1, id: 'lifetime-flow', version: 1, title: 'Lifetime flow', steps: [step('build')] };

const exists = (p: string) => stat(p).then(() => true, () => false);
/** Reads of BridgeEngine's state files, at a production-like cadence (see host-fixtures `until`). */
const STATUS_POLL_MS = 200;

/** Pids this test run saw end. Windows recycles pids quickly: once a pid is known dead, a live
 * process with that number is SOMEONE ELSE's (e.g. a test file running in parallel). */
const confirmedDead = new Set<number>();

async function untilDead(pids: number[], timeoutMs = 15_000): Promise<void> {
  await until(() => pids.every((pid) => !isPidAlive(pid)), timeoutMs, `pids ${pids.join(', ')} to end`);
  for (const pid of pids) confirmedDead.add(pid);
}

/** Safety net after a FAILED assertion: ends what this test started and never saw end. Never a
 * tree kill and never a pid already seen dead — `taskkill /T` of a recycled pid (or of a recycled
 * parent pid) would kill unrelated processes. An Execution Host's CLI ends with it (its job). */
function reap(pids: (number | null | undefined)[]): void {
  for (const pid of pids) {
    if (typeof pid !== 'number' || confirmedDead.has(pid) || !isPidAlive(pid)) continue;
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------
// 1. the boundary itself
// ---------------------------------------------------------------------------

test('the lifetime boundary: default and with-parent children die with their parent; an independent child and its CLI survive, and are cleaned up by a tree stop', windowsOnly(90_000), (t) =>
  withProject(async (dir) => {
    for (const mode of ['default', 'with-parent', 'independent'] as const) {
      const info = path.join(dir, `${mode}.json`);
      const parent = forkChildHost<unknown>({ scriptPath: CHAIN, execPath: process.execPath, env: { ...process.env, LIFETIME_ROLE: 'parent', LIFETIME_INFO: info, LIFETIME_MODE: mode } });
      const parentExited = new Promise<RunHostExit>((resolve) =>
        parent.onExit((exit) => {
          confirmedDead.add(parent.pid!);
          resolve(exit);
        }),
      );
      let ids: { parent: number; child: number; cli: number } | null = null;
      try {
        await until(() => exists(info), 20_000, `${mode}: the chain to start`);
        ids = JSON.parse(await readFile(info, 'utf8'));
        assert.ok(ids);
        assert.equal(ids.parent, parent.pid, `${mode}: the child's parent is the forking process`);
        assert.ok([ids.parent, ids.child, ids.cli].every(isPidAlive), `${mode}: all three running`);

        process.kill(parent.pid!); // TerminateProcess — the parent only
        await parentExited;
        await sleep(1500);
        const after = { child: isPidAlive(ids.child), cli: isPidAlive(ids.cli) };
        t.diagnostic(`${mode.padEnd(11)} parent ${ids.parent} → child ${ids.child} → cli ${ids.cli}; after killing ONLY the parent: child ${after.child ? 'ALIVE' : 'dead'}, cli ${after.cli ? 'ALIVE' : 'dead'}`);
        if (mode === 'independent') {
          assert.deepEqual(after, { child: true, cli: true }, 'the independent child and the CLI it owns outlive the parent');
          assert.equal((await readFile(`${info}.log`, 'utf8')).trim(), 'disconnect', 'it saw the parent go and kept running (a late stderr write included)');
          killProcessTree(ids.child); // BridgeEngine.stop's force path
          await untilDead([ids.child, ids.cli]);
          t.diagnostic(`${mode.padEnd(11)} after taskkill /T of the child: child dead, cli dead (no orphan)`);
        } else {
          await untilDead([ids.child, ids.cli], 5000);
        }
      } finally {
        reap([ids?.child, ids?.cli]);
      }
    }
  }));

// ---------------------------------------------------------------------------
// 2–6. Workflow Host / Execution Host / CLI
// ---------------------------------------------------------------------------

interface HostHandle {
  pid: number;
  messages: WorkflowHostMessage[];
  exited: Promise<RunHostExit>;
  send(m: unknown): void;
}

function workflowHost(p: string, env: Record<string, string>): HostHandle {
  // Forked exactly as Electron Main forks it (default lifetime).
  const child = forkChildHost<unknown>({
    scriptPath: WORKFLOW_HOST,
    execPath: process.execPath,
    env: { ...process.env, FAKE_WF_PORT: 'forked', FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1', FAKE_HOST_INFO_FILE: path.join(p, 'execution-host.json'), ...env },
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

const events = (h: HostHandle): WorkflowEvent[] => h.messages.flatMap((m) => (m.type === 'event' ? [m.event] : []));
const inputs = (h: HostHandle, type: string) => events(h).filter((e) => e.type === 'INPUT_RECEIVED' && e.payload.inputType === type).map((e) => JSON.parse(String(e.payload.input)) as Record<string, any>);
const ended = (h: HostHandle) => h.messages.flatMap((m) => (m.type === 'ended' ? [m.end] : []))[0];

interface Running {
  host: HostHandle;
  workflowId: string;
  attemptId: string;
  runId: string;
  executionHostPid: number;
  cliPid: number;
}

/** Starts the one-step workflow and waits until its execution is in Claude (fake): every pid known. */
async function runningWorkflow(t: TestContext, p: string, env: Record<string, string>): Promise<Running> {
  const hash = await writeDefinition(p, ONE_STEP);
  const host = workflowHost(p, env);
  host.send(runCommand(p, hash, {}, ONE_STEP.id));
  await until(() => events(host).some((e) => e.type === 'EXECUTION_LINKED'), 60_000, 'the execution to start');
  const linked = events(host).find((e) => e.type === 'EXECUTION_LINKED')!;
  const engine = new BridgeEngine(p);
  await until(async () => (await engine.status()).claude.pid !== null, 30_000, 'the fake Claude CLI to be spawned', STATUS_POLL_MS);
  const status = await engine.status();
  const info = JSON.parse(await readFile(path.join(p, 'execution-host.json'), 'utf8')) as { pid: number; ppid: number };
  const lock = JSON.parse(await readFile(path.join(aiBridgeOf(p), 'state', 'lock'), 'utf8')) as { pid: number };
  const started = (await engine.getSessionArtifacts(linked.executionId!))?.events.find((e) => e.event === 'RUN_STARTED');

  const r: Running = { host, workflowId: linked.workflowId, attemptId: linked.attemptId!, runId: linked.executionId!, executionHostPid: info.pid, cliPid: status.claude.pid! };
  assert.equal(info.ppid, host.pid, 'process tree: the Execution Host is a child of the Workflow Host');
  assert.equal(lock.pid, r.executionHostPid, 'ownership record: the Execution Host holds the run lock');
  assert.equal(status.runId, r.runId, 'the execution linked to the attempt is the project’s current run');
  assert.equal(started?.correlation, r.attemptId, 'correlation: RUN_STARTED carries the attemptId (ADR-017)');
  assert.ok([host.pid, r.executionHostPid, r.cliPid].every(isPidAlive));
  t.diagnostic(`tree: Workflow Host ${host.pid} → Execution Host ${r.executionHostPid} (run lock holder, run ${r.runId}, correlation ${r.attemptId}) → fake Claude CLI ${r.cliPid}`);
  return r;
}

async function instanceOf(p: string, workflowId: string) {
  const loaded = await new WorkflowStore(aiBridgeOf(p)).load(workflowId);
  assert.ok(loaded.ok);
  return loaded.handle.instance;
}

test('Workflow Host crash → the Execution Host and its CLI survive → a new Workflow Host WATCHes, then ADOPTs, the SAME execution — execution count 1', windowsOnly(180_000), (t) =>
  withProject(async (p) => {
    const w = await runningWorkflow(t, p, { FAKE_CLAUDE_DELAY_MS: '8000' });
    let b: HostHandle | null = null;
    try {
      process.kill(w.host.pid); // only the Workflow Host
      await w.host.exited;
      await sleep(1000);
      assert.equal(isPidAlive(w.executionHostPid), true, 'the Execution Host outlived its Workflow Host');
      assert.equal(isPidAlive(w.cliPid), true, 'the CLI it was running is still running');
      const engine = new BridgeEngine(p);
      assert.deepEqual([(await engine.status()).status, (await engine.status()).runId], ['RUNNING', w.runId]);
      const snap = await getWorkflowSnapshot(aiBridgeOf(p), w.workflowId);
      assert.ok(snap.ok);
      assert.equal(snap.value.displayState, 'INTERRUPTED', 'persisted RUNNING, no live Workflow Host');
      t.diagnostic(`after killing Workflow Host ${w.host.pid}: Execution Host ${w.executionHostPid} ALIVE, CLI ${w.cliPid} ALIVE, run ${w.runId} RUNNING, workflow INTERRUPTED`);

      b = workflowHost(p, {});
      b.send({ type: 'resume', projectPath: p, workflowId: w.workflowId });
      const exit = await b.exited;
      assert.equal(exit.code, 0, exit.stderrTail);
      assert.deepEqual(ended(b), { workflowId: w.workflowId, state: 'COMPLETED', reason: 'REST', errors: [] });

      const watch = events(b).find((e) => e.type === 'RECONCILED' && e.payload.finding === 'WATCH');
      assert.ok(watch, 'the surviving execution was WATCHed (M5.6)');
      assert.equal(watch.payload.executionId, w.runId);
      const adopted = inputs(b, 'EXECUTION_ENDED');
      assert.equal(adopted.length, 1);
      assert.equal(adopted[0].result.executionId, w.runId, 'its own outcome was ADOPTed');
      assert.equal(adopted[0].result.finalStatus, 'DONE');
      assert.deepEqual(inputs(b, 'EXECUTION_HOST_SPAWNED'), [], 'the new Workflow Host launched no Execution Host');

      const inst = await instanceOf(p, w.workflowId);
      const attempt = inst.steps[0].attempts[0];
      assert.equal(inst.steps[0].attempts.length, 1);
      assert.equal(attempt.executionId, w.runId, 'original executionId === reconciled executionId');
      assert.equal(attempt.launches, 1);
      assert.deepEqual(await readdir(path.join(aiBridgeOf(p), 'sessions')), [w.runId], 'execution count = 1');
      t.diagnostic(`reconciled: WATCH ${watch.payload.executionId} → ADOPT ${adopted[0].result.executionId} (DONE) → COMPLETED; sessions = [${w.runId}]`);

      await untilDead([w.executionHostPid, w.cliPid]);
      t.diagnostic(`orphan check: Execution Host ${w.executionHostPid} and CLI ${w.cliPid} ended by themselves after the run`);
    } finally {
      reap([w.host.pid, w.executionHostPid, w.cliPid, b?.pid]);
    }
  }));

test('the execution finishes while no Workflow Host exists → the next Workflow Host ADOPTs it — nothing watched, nothing relaunched', windowsOnly(180_000), (t) =>
  withProject(async (p) => {
    const w = await runningWorkflow(t, p, { FAKE_CLAUDE_DELAY_MS: '3000' });
    try {
      process.kill(w.host.pid);
      await w.host.exited;
      const engine = new BridgeEngine(p);
      await until(async () => (await engine.status()).status !== 'RUNNING', 90_000, 'the orphaned run to end by itself', STATUS_POLL_MS);
      const endedAs = await engine.status();
      const trail = await readFile(path.join(p, 'execution-host.json.trail'), 'utf8').catch(() => '(no trail — terminated from outside)');
      assert.equal(endedAs.status, 'DONE', `the orphaned run ended ${endedAs.status} (phase ${endedAs.currentPhase}); Execution Host alive: ${isPidAlive(w.executionHostPid)}; its own record: ${trail.trim()}`);
      await untilDead([w.executionHostPid, w.cliPid]);
      t.diagnostic(`run ${w.runId} reached DONE with no Workflow Host; Execution Host ${w.executionHostPid} exited normally`);

      const b = workflowHost(p, {});
      b.send({ type: 'resume', projectPath: p, workflowId: w.workflowId });
      assert.equal((await b.exited).code, 0);
      assert.equal(ended(b).state, 'COMPLETED');
      assert.equal(events(b).filter((e) => e.type === 'RECONCILED' && e.payload.finding === 'WATCH').length, 0, 'nothing left to watch');
      assert.deepEqual(inputs(b, 'EXECUTION_ENDED').map((i) => i.result.executionId), [w.runId], 'ADOPTed');
      assert.deepEqual(inputs(b, 'EXECUTION_HOST_SPAWNED'), []);
      const attempt = (await instanceOf(p, w.workflowId)).steps[0].attempts[0];
      assert.deepEqual([attempt.executionId, attempt.launches], [w.runId, 1]);
      assert.deepEqual(await readdir(path.join(aiBridgeOf(p), 'sessions')), [w.runId]);
    } finally {
      reap([w.host.pid, w.executionHostPid, w.cliPid]);
    }
  }));

test('explicit STOP: Workflow Host → ExecutionPort.stop() → the Execution Host and its CLI are terminated → STOPPED; no orphan', windowsOnly(120_000), (t) =>
  withProject(async (p) => {
    const w = await runningWorkflow(t, p, { FAKE_CLAUDE_DELAY_MS: '60000' });
    try {
      w.host.send({ type: 'control', requestId: 'stop-1', action: 'stop' });
      assert.equal((await w.host.exited).code, 0);
      assert.equal(ended(w.host).state, 'STOPPED');
      await untilDead([w.executionHostPid, w.cliPid], 20_000);
      assert.equal((await new BridgeEngine(p).status()).status, 'STOPPED', 'BridgeEngine recorded the stop (ADR-014)');
      assert.deepEqual(await readdir(path.join(aiBridgeOf(p), 'sessions')), [w.runId]);
      t.diagnostic(`STOP: Execution Host ${w.executionHostPid} dead, CLI ${w.cliPid} dead, run ${w.runId} STOPPED, Workflow Host exited 0`);
    } finally {
      reap([w.host.pid, w.executionHostPid, w.cliPid]);
    }
  }));

test('normal completion: Workflow Host → Execution Host → clean exits; locks released; nothing left running', windowsOnly(120_000), (t) =>
  withProject(async (p) => {
    // Long enough to observe the CLI pid under a loaded full suite (Core clears it once Claude ends).
    const w = await runningWorkflow(t, p, { FAKE_CLAUDE_DELAY_MS: '3000' });
    try {
      assert.equal((await w.host.exited).code, 0);
      assert.equal(ended(w.host).state, 'COMPLETED');
      await untilDead([w.executionHostPid, w.cliPid]);
      assert.equal(await exists(path.join(aiBridgeOf(p), 'state', 'lock')), false, 'run lock released');
      assert.equal(await exists(path.join(aiBridgeOf(p), 'state', 'workflow-lock')), false, 'workflow lock released');
      t.diagnostic(`completion: Workflow Host ${w.host.pid}, Execution Host ${w.executionHostPid}, CLI ${w.cliPid} all exited; no lock left`);
    } finally {
      reap([w.host.pid, w.executionHostPid, w.cliPid]);
    }
  }));

test('the Execution Host itself dies: its CLI dies with it; M5.6 decides — mid-Claude → WAITING_HUMAN, never a relaunch', windowsOnly(120_000), (t) =>
  withProject(async (p) => {
    const w = await runningWorkflow(t, p, { FAKE_CLAUDE_DELAY_MS: '60000' });
    try {
      process.kill(w.executionHostPid);
      await untilDead([w.executionHostPid, w.cliPid], 10_000);
      t.diagnostic(`killed Execution Host ${w.executionHostPid}: CLI ${w.cliPid} ended with it (it is in the Execution Host's job)`);
      assert.equal((await w.host.exited).code, 0);
      const end = ended(w.host);
      assert.equal(end.state, 'WAITING_HUMAN');
      const inst = await instanceOf(p, w.workflowId);
      assert.ok(['EXECUTION_NOT_RECOVERABLE', 'ORPHANED_CLI_PROCESS_ALIVE'].includes(inst.waitingFor?.reason ?? ''), inst.waitingFor?.reason);
      assert.deepEqual([inst.steps[0].attempts.length, inst.steps[0].attempts[0].launches], [1, 1]);
      assert.deepEqual(await readdir(path.join(aiBridgeOf(p), 'sessions')), [w.runId]);
    } finally {
      reap([w.host.pid, w.executionHostPid, w.cliPid]);
    }
  }));

test('the Execution Host dies at a resumable checkpoint: the SAME execution is RESUMED (no new run)', windowsOnly(120_000), (t) =>
  withProject(async (p) => {
    const hash = await writeDefinition(p, ONE_STEP);
    const host = workflowHost(p, { AI_BRIDGE_CRASH_AT: 'AFTER_REPORT_VALIDATED' }); // the Execution Host self-exits (137) there
    try {
      host.send(runCommand(p, hash, {}, ONE_STEP.id));
      const exit = await host.exited;
      assert.equal(exit.code, 0, exit.stderrTail);
      assert.equal(ended(host).state, 'COMPLETED');
      const linked = events(host).filter((e) => e.type === 'EXECUTION_LINKED').map((e) => e.executionId);
      const resume = events(host).find((e) => e.type === 'RECONCILED' && e.payload.finding === 'RESUME');
      assert.ok(resume, 'M5.6 found it RECOVERABLE');
      assert.equal(resume.payload.executionId, linked[0]);
      assert.deepEqual(await readdir(path.join(aiBridgeOf(p), 'sessions')), [linked[0]], 'one execution, resumed');
      const inst = await instanceOf(p, ended(host).workflowId);
      assert.equal(inst.steps[0].attempts[0].executionId, linked[0]);
      t.diagnostic(`crash at AFTER_REPORT_VALIDATED → RESUME ${resume.payload.executionId} → COMPLETED; sessions = [${linked[0]}]`);
    } finally {
      reap([host.pid]);
    }
  }));
