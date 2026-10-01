import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeEngine } from '../../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../../src/core/config/config.ts';
import { workflowLockPath } from '../../src/core/workflow/workflow-lock.ts';
import { forkRunHost } from '../../src/desktop/main/fork-run-host.ts';
import { RunController } from '../../src/desktop/main/run-controller.ts';
import { WorkflowController, type WorkflowEngineApi } from '../../src/desktop/main/workflow-controller.ts';
import { deriveControls, type ControlInput } from '../../src/desktop/shared/controls.ts';
import { ForkedExecutionPort } from '../../src/hosts/forked-execution-port.ts';
import { WorkflowHost } from '../../src/hosts/workflow-host.ts';
import { readWorkflowActivity } from '../../src/hosts/workflow-read.ts';
import { DEAD_PID, DEF_ID, aiBridgeOf, hostDeps, runCommand, stoppablePort, until, withProject, writeDefinition } from '../workflow/host-fixtures.ts';

// M5.8 (docs/35 §3.1): two supervisors never drive one project's executions. Derived from
// Core — the workflow lock, persisted RUNNING instances, BridgeEngine's run lock/status —
// never from renderer state. Scripted ports and fake CLIs only; no quota.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.ts');
const FAKE_RUN_HOST = fileURLToPath(new URL('../fixtures/desktop/fake-run-host.ts', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex/fake-codex.mjs', import.meta.url));
const project = (p: string) => ({ path: p, name: path.basename(p) });
const OFF = { canStart: false, canPause: false, canResume: false, stopMode: null };

function fakeEngine(projectPath: string): BridgeEngine {
  return new BridgeEngine(projectPath, {
    runDoctor: async () => ({ report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' }, claudeExe: process.execPath, codexExe: process.execPath, config: DEFAULT_CONFIG, configErrors: [], gitWarning: null }),
    claudeCommandArgsPrefix: [FAKE_CLAUDE],
    codexCommandArgsPrefix: [FAKE_CODEX],
  });
}

function runController(opts: { forkRunHost?: () => ReturnType<typeof forkRunHost> } = {}) {
  let forks = 0;
  const controller = new RunController({
    createEngine: (p) => fakeEngine(p),
    forkRunHost: () => {
      forks += 1;
      if (!opts.forkRunHost) throw new Error('no run host may be forked');
      return opts.forkRunHost();
    },
    activePollMs: 50,
    idlePollMs: 1000,
    workflowActivity: async (p) => (await readWorkflowActivity(aiBridgeOf(p))).active,
  });
  return { controller, forks: () => forks };
}

async function hostedWorkflow(p: string) {
  const hash = await writeDefinition(p);
  const port = stoppablePort();
  const host = new WorkflowHost(hostDeps(p, port));
  const began = await host.begin(runCommand(p, hash));
  assert.ok(began.ok);
  await until(() => host.engine?.instance.steps[0].attempts[0]?.observedIteration === 1, 5000, 'iteration 1');
  return { host, port, hash, workflowId: began.ok ? began.workflowId : '' };
}

test('deriveControls: a workflow owning the project turns every Run control off; without it nothing changes', () => {
  const base: ControlInput = { hasProject: true, status: 'NOT_STARTED', iteration: 0, recovery: 'NONE', pendingAction: null, pauseRequested: false, runAttached: false };
  assert.deepEqual(deriveControls(base), { canStart: true, canPause: false, canResume: false, stopMode: null });
  assert.deepEqual(deriveControls({ ...base, workflowActive: false }), deriveControls(base));
  for (const status of ['NOT_STARTED', 'RUNNING', 'PAUSED', 'INTERRUPTED', 'DONE']) {
    assert.deepEqual(deriveControls({ ...base, status, iteration: 2, recovery: 'RECOVERABLE', workflowActive: true }), OFF, status);
  }
});

test('workflow active → ordinary run refused: RunController canStart is false and start returns WORKFLOW_ACTIVE; no run host forked; back once the workflow rests', { timeout: 30_000 }, () =>
  withProject(async (p) => {
    const { host } = await hostedWorkflow(p);
    const { controller, forks } = runController();
    try {
      await controller.setProject(project(p));
      assert.deepEqual((await controller.getSnapshot()).controls, OFF);
      const refused = await controller.start({ task: 'an ordinary run' });
      assert.equal(!refused.ok && refused.error.code, 'WORKFLOW_ACTIVE');
      assert.equal((await controller.resume()).ok, false);
      assert.equal(forks(), 0);

      await host.control('stop');
      assert.equal((await host.finished()).state, 'STOPPED');
      assert.equal((await controller.getSnapshot()).controls.canStart, true, 'derived again from Core once the workflow rests');
    } finally {
      controller.dispose();
    }
  }));

test('an INTERRUPTED workflow (RUNNING on disk, dead host) still owns the project: Run controls stay off until it is resumed or stopped', () =>
  withProject(async (p) => {
    const { host, port } = await hostedWorkflow(p);
    host.abandon();
    await writeFile(workflowLockPath(aiBridgeOf(p)), JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
    const activity = await readWorkflowActivity(aiBridgeOf(p));
    assert.equal(activity.host, null);
    assert.equal(activity.active, true);
    const { controller } = runController();
    try {
      await controller.setProject(project(p));
      assert.deepEqual((await controller.getSnapshot()).controls, OFF);
    } finally {
      controller.dispose();
      await port.stop(); // releases the scripted execution the "dead" host left behind
    }
  }));

test('ordinary run active → workflow refused: the Workflow Host precheck and Main both answer RUN_ACTIVE; nothing is created or forked', { timeout: 60_000 }, () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const { controller: runs } = runController({ forkRunHost: () => forkRunHost({ scriptPath: FAKE_RUN_HOST, execPath: process.execPath, env: { ...process.env, FAKE_CLAUDE_DELAY_MS: '3000' } }) });
    try {
      await runs.setProject(project(p));
      const started = await runs.start({ task: 'hold the run lock for a while', maxIterations: 1 });
      assert.deepEqual(started, { ok: true });
      assert.equal((await new BridgeEngine(p).status()).status, 'RUNNING');

      const port = new ForkedExecutionPort({ projectPath: p, engine: new BridgeEngine(p), spawnHost: () => assert.fail('no Execution Host may start') });
      const host = new WorkflowHost({ projectPath: p, port });
      const r = await host.begin(runCommand(p, hash));
      assert.equal(!r.ok && r.error.code, 'RUN_ACTIVE');

      let workflowForks = 0;
      const workflows = new WorkflowController({ createEngine: (pp) => new BridgeEngine(pp) as unknown as WorkflowEngineApi, forkWorkflowHost: () => (workflowForks++, assert.fail('no Workflow Host may start')) });
      await workflows.setProject(project(p));
      const viaMain = await workflows.start({ definitionId: DEF_ID, definitionHash: hash, inputs: {} });
      assert.equal(!viaMain.ok && viaMain.error.code, 'RUN_ACTIVE');
      assert.equal((await workflows.getSnapshot()).startBlockedBy?.code, 'RUN_ACTIVE');
      assert.equal(workflowForks, 0);
      workflows.dispose();
      assert.deepEqual(await readdir(path.join(aiBridgeOf(p), 'workflows', 'instances')).catch(() => []), [], 'no instance was created');
      await until(async () => (await new BridgeEngine(p).status()).status !== 'RUNNING', 30_000, 'the ordinary run to finish');
    } finally {
      runs.dispose();
    }
  }));

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: unknown }).code ?? 1) : 0, stdout, stderr }));
  });
}

test('the ordinary CLI: `ai-bridge start` / `resume` refuse with ERROR_WORKFLOW_ACTIVE (exit 2) while a workflow is active — before any preflight', { timeout: 60_000 }, () =>
  withProject(async (p) => {
    const { host, workflowId } = await hostedWorkflow(p);
    const start = await runCli(['start', '--project', p, '--task', 'an ordinary run']);
    assert.equal(start.code, 2, start.stderr);
    assert.match(start.stderr, new RegExp(`^ERROR_WORKFLOW_ACTIVE: ${workflowId} is running`, 'm'));
    const resume = await runCli(['resume', '--project', p]);
    assert.equal(resume.code, 2);
    assert.deepEqual(await readdir(path.join(aiBridgeOf(p), 'sessions')).catch(() => []), [], 'no run was started');
    await host.control('stop');
    await host.finished();
  }));
