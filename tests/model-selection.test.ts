import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeEngine, type Preflight } from '../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG, validateConfig, isValidModelName, type AiBridgeConfig } from '../src/core/config/config.ts';
import { ClaudeCodeCliAdapter, findReportedClaudeModel } from '../src/adapters/claude/claude-code-cli-adapter.ts';
import type { ExecutionRecord } from '../src/core/execution/execution-record.ts';

// docs/62 — Claude model selection. Fake CLIs only: no real provider, no quota.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

const doctorWith = (config: AiBridgeConfig): ((p: string) => Promise<Preflight>) => async () => ({
  report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
  claudeExe: process.execPath,
  codexExe: process.execPath,
  config,
  configErrors: [],
  gitWarning: null,
});

function engine(projectPath: string, config: AiBridgeConfig, codexDoneAt = '1'): BridgeEngine {
  return new BridgeEngine(projectPath, {
    runDoctor: doctorWith(config),
    claudeCommandArgsPrefix: [FAKE_CLAUDE],
    codexCommandArgsPrefix: [FAKE_CODEX],
    claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
    codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: codexDoneAt },
  });
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-model-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sessionDir(projectPath: string): Promise<string> {
  const sessions = path.join(projectPath, '.ai-bridge', 'sessions');
  const [runId] = await readdir(sessions);
  return path.join(sessions, runId);
}

const record = async (dir: string, name: string): Promise<ExecutionRecord> => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
const withModel = (claude: string | null): AiBridgeConfig => ({ ...DEFAULT_CONFIG, models: { claude } });

test('config: default is null (no --model, the CLI decides); old config files stay valid', () => {
  assert.deepEqual(DEFAULT_CONFIG.models, { claude: null });
  const old = validateConfig({ maxIterations: 3 });
  assert.deepEqual(old.errors, []);
  assert.deepEqual(old.config.models, { claude: null });
  assert.deepEqual(validateConfig({ models: { claude: 'claude-opus-5-5' } }).config.models, { claude: 'claude-opus-5-5' });
  assert.deepEqual(validateConfig({ models: { claude: null } }).config.models, { claude: null });
});

test('config: model names are validated — never a flag, no spaces, bounded; codex is not configurable here', () => {
  for (const ok of ['opus', 'sonnet', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'opus[1m]', 'claude-3.7:latest']) assert.ok(isValidModelName(ok), ok);
  for (const bad of ['', '--dangerously-skip-permissions', '-m', 'opus 5', 'x'.repeat(101), 'claude;rm', 42]) assert.equal(isValidModelName(bad), false, String(bad));
  assert.match(validateConfig({ models: { claude: '--model' } }).errors.join(' '), /models\.claude must be null/);
  assert.match(validateConfig({ models: { codex: 'gpt-5' } }).errors.join(' '), /Unknown models provider: "codex"/);
  assert.match(validateConfig({ models: 'opus' }).errors.join(' '), /models must be an object/);
});

test('findReportedClaudeModel: the init event wins; else the first real assistant message; <synthetic> and garbage ignored', () => {
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' });
  const msg = (model: string) => JSON.stringify({ type: 'assistant', message: { model } });
  assert.equal(findReportedClaudeModel([msg('claude-sonnet-5'), init].join('\n')), 'claude-opus-5-5');
  assert.equal(findReportedClaudeModel(['{not json', msg('<synthetic>'), msg('claude-sonnet-4-6')].join('\n')), 'claude-sonnet-4-6');
  assert.equal(findReportedClaudeModel(JSON.stringify({ type: 'result', session_id: 's' })), null);
});

test('adapter: --model is sent only when a model is set', async () => {
  const adapter = new ClaudeCodeCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLAUDE] });
  const withM = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000, model: 'claude-opus-5-5' });
  assert.deepEqual(withM.args.slice(withM.args.indexOf('--model'), withM.args.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
  assert.equal(findReportedClaudeModel(withM.stdout), 'claude-opus-5-5');
  const without = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000 });
  assert.ok(!without.args.includes('--model'));
});

test('run: the configured model reaches every Claude call (also on --resume) and is recorded as requested + reported', () =>
  withProject(async (projectPath) => {
    await engine(projectPath, withModel('claude-opus-5-5'), '2').start({ task: 'do it', maxIterations: 3 });
    const dir = await sessionDir(projectPath);
    for (const nnn of ['001', '002']) {
      const rec = await record(dir, `${nnn}-claude-execution.json`);
      assert.deepEqual(rec.model, { requested: 'claude-opus-5-5', reported: 'claude-opus-5-5' });
      assert.ok(rec.command.args.includes('--model') && rec.command.args.includes('claude-opus-5-5'));
    }
    assert.equal((await record(dir, '002-claude-execution.json')).mode, 'RESUME');
    assert.equal((await record(dir, '001-codex-execution.json')).model, undefined, 'Codex is not affected');
    assert.match(await readFile(path.join(dir, '001-claude-report.md'), 'utf8'), /- Model: requested --model claude-opus-5-5; reported by the CLI: claude-opus-5-5/);
    const started = (await readFile(path.join(projectPath, '.ai-bridge', 'logs', 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; models?: unknown })
      .find((e) => e.event === 'RUN_STARTED');
    assert.deepEqual(started?.models, { claude: 'claude-opus-5-5' });
  }));

test('run: with no model set, no --model is sent and the record shows what the CLI itself reported', () =>
  withProject(async (projectPath) => {
    await engine(projectPath, DEFAULT_CONFIG).start({ task: 'do it', maxIterations: 1 });
    const rec = await record(await sessionDir(projectPath), '001-claude-execution.json');
    assert.deepEqual(rec.model, { requested: null, reported: 'fake-cli-default-model' });
    assert.ok(!rec.command.args.includes('--model'));
  }));

test('settings: getConfig/saveConfig round-trip the Claude model; invalid names are refused', () =>
  withProject(async (projectPath) => {
    const e = new BridgeEngine(projectPath);
    assert.deepEqual((await e.getConfig()).config.models, { claude: null });
    assert.equal((await e.saveConfig({ models: { claude: 'claude-sonnet-5' } })).kind, 'SAVED');
    assert.deepEqual(JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'config.json'), 'utf8')).models, { claude: 'claude-sonnet-5' });
    assert.deepEqual((await e.getConfig()).config.models, { claude: 'claude-sonnet-5' });
    assert.equal((await e.saveConfig({ models: { claude: '--evil' } })).kind, 'INVALID');
    await writeFile(path.join(projectPath, '.ai-bridge', 'config.json'), JSON.stringify({ models: { claude: null } }), 'utf8');
    assert.deepEqual((await e.getConfig()).config.models, { claude: null });
  }));
