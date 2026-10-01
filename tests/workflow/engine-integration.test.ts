import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine } from '../../src/core/bridge-engine.ts';
import { forkRunHost } from '../../src/desktop/main/fork-run-host.ts';
import { ForkedExecutionPort } from '../../src/hosts/forked-execution-port.ts';
import { WorkflowEngine } from '../../src/core/workflow/engine.ts';
import { step } from './definition-fixtures.ts';

// M5.5 end to end over REAL forked Execution Hosts (fake Claude/Codex CLIs, no quota):
// WorkflowEngine → ForkedExecutionPort → run host → BridgeEngine → Orchestrator.

const HOST = fileURLToPath(new URL('../fixtures/workflow/fake-execution-host.ts', import.meta.url));

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-wf-e2e-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function engineDeps(projectPath: string, hostEnv: Record<string, string> = {}) {
  const port = new ForkedExecutionPort({
    projectPath,
    engine: new BridgeEngine(projectPath),
    spawnHost: () => forkRunHost({ scriptPath: HOST, execPath: process.execPath, env: { ...process.env, FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1', ...hostEnv } }),
  });
  return { aiBridgeDir: path.join(projectPath, '.ai-bridge'), port, pollIntervalMs: 50 };
}

const DEF = {
  schema: 1,
  id: 'two-steps',
  version: 1,
  title: 'Two steps',
  steps: [step('build', { outputs: ['report.summary'] }), step('docs', { instruction: 'Document {{steps.build.outputs.report.summary}}' })],
};

test('a two-step workflow runs each step as one real execution, correlated by attemptId', { timeout: 120_000 }, () =>
  withProject(async (projectPath) => {
    const r = await WorkflowEngine.create(engineDeps(projectPath), DEF, {});
    assert.ok(r.ok);
    const engine = r.engine;
    await engine.start();
    await engine.idle();
    assert.equal(engine.instance.state, 'COMPLETED', JSON.stringify(engine.errors.map(String)));
    assert.equal(engine.instance.evidenceLevel, 'AI_ATTESTED');
    const attempts = engine.instance.steps.map((s) => s.attempts[0]);
    const sessions = (await readdir(path.join(projectPath, '.ai-bridge', 'sessions'))).sort();
    assert.deepEqual(attempts.map((a) => a.executionId), sessions, 'one session per step, linked to its attempt');
    const events = (await readFile(path.join(projectPath, '.ai-bridge', 'logs', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const starts = events.filter((e) => e.event === 'RUN_STARTED');
    assert.deepEqual(starts.map((e) => [e.runId, e.correlation]), attempts.map((a) => [a.executionId, a.attemptId]));
    const task = await readFile(path.join(engine.handle.paths.attempts, 'docs-1', 'task.md'), 'utf8');
    assert.match(task, /--- BEGIN STEP OUTPUT build report\.summary ---\nnone\n/, 'the fake report has NEXT_RECOMMENDATION "none"');
    await engine.close();
  }));

test('a real Execution Host crash mid-Claude is reconciled to WAITING_HUMAN — no duplicate execution', { timeout: 120_000 }, () =>
  withProject(async (projectPath) => {
    const r = await WorkflowEngine.create(engineDeps(projectPath, { AI_BRIDGE_CRASH_AT: 'AFTER_CLAUDE_STARTED' }), DEF, {});
    assert.ok(r.ok);
    const engine = r.engine;
    await engine.start();
    await engine.idle();
    assert.equal(engine.instance.state, 'WAITING_HUMAN');
    assert.ok(['EXECUTION_NOT_RECOVERABLE', 'ORPHANED_CLI_PROCESS_ALIVE'].includes(engine.instance.waitingFor?.reason ?? ''), engine.instance.waitingFor?.reason);
    assert.equal((await readdir(path.join(projectPath, '.ai-bridge', 'sessions'))).length, 1);
    assert.equal(engine.instance.steps[0].attempts.length, 1);
    await engine.close();
  }));
