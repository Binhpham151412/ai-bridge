import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine, type Preflight } from '../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG, validateConfig, isValidOpenCodeModelName, type AiBridgeConfig } from '../src/core/config/config.ts';
import { DEFAULT_EXECUTOR_PROVIDER, EXECUTOR_PROVIDER_INFO, EXECUTOR_PROVIDERS, isExecutorProviderId, type ExecutorProviderId } from '../src/core/executor/executor-adapter.ts';
import { resolvePermissionPolicy } from '../src/core/permissions/permission-policy.ts';
import { ClaudeCodeCliAdapter } from '../src/adapters/claude/claude-code-cli-adapter.ts';
import { OpenCodeCliAdapter } from '../src/adapters/opencode/opencode-cli-adapter.ts';
import type { ExecutionRecord } from '../src/core/execution/execution-record.ts';

// docs/64 — the pluggable executor. Fake CLIs only: no real provider, no quota.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_OPENCODE = fileURLToPath(new URL('./fixtures/fake-opencode/fake-opencode.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

const withExecutor = (provider: ExecutorProviderId, extra: Partial<AiBridgeConfig> = {}): AiBridgeConfig => ({
  ...DEFAULT_CONFIG,
  permissions: { ...DEFAULT_CONFIG.permissions },
  models: { ...DEFAULT_CONFIG.models },
  executor: { provider },
  ...extra,
});

/** A fake doctor that behaves like the real one about the executor: an explicit option wins over the config. */
function doctorWith(config: AiBridgeConfig, seen: Array<ExecutorProviderId | undefined> = []): (p: string, o?: { executor?: ExecutorProviderId }) => Promise<Preflight> {
  return async (_p, options) => {
    seen.push(options?.executor);
    return {
      report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
      claudeExe: process.execPath,
      executor: options?.executor ?? config.executor.provider,
      codexExe: process.execPath,
      config,
      configErrors: [],
      gitWarning: null,
    };
  };
}

function engine(projectPath: string, config: AiBridgeConfig, opts: { prefix?: string; codexDoneAt?: string; claudeEnv?: NodeJS.ProcessEnv; seen?: Array<ExecutorProviderId | undefined> } = {}): BridgeEngine {
  return new BridgeEngine(projectPath, {
    runDoctor: doctorWith(config, opts.seen),
    claudeCommandArgsPrefix: [opts.prefix ?? FAKE_OPENCODE],
    codexCommandArgsPrefix: [FAKE_CODEX],
    claudeEnv: opts.claudeEnv ?? { FAKE_OPENCODE_MODE: 'ok' },
    codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: opts.codexDoneAt ?? '1' },
  });
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-executor-'));
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

const stateFile = (projectPath: string): string => path.join(projectPath, '.ai-bridge', 'state', 'current-session.json');

/** A crash injected without process.exit() ends the run as ERROR; a real crash leaves the last
 * checkpoint behind. This puts the state back to that checkpoint (and optionally drops fields). */
async function leaveCrashCheckpoint(projectPath: string, drop: string[] = []): Promise<void> {
  const state = JSON.parse(await readFile(stateFile(projectPath), 'utf8'));
  state.status = 'RESPONSE_PARSED';
  for (const k of drop) delete state[k];
  await writeFile(stateFile(projectPath), JSON.stringify(state), 'utf8');
}

const record = async (dir: string, name: string): Promise<ExecutionRecord> => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
const events = async (projectPath: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(path.join(projectPath, '.ai-bridge', 'logs', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------
// The provider table and the config
// ---------------------------------------------------------------------------

test('providers: Claude Code is the default and the only caller-assigned CLI; ids are validated', () => {
  assert.equal(DEFAULT_EXECUTOR_PROVIDER, 'claude-code');
  assert.deepEqual([...EXECUTOR_PROVIDERS], ['claude-code', 'opencode']);
  assert.equal(EXECUTOR_PROVIDER_INFO['claude-code'].sessionIdAssignment, 'caller');
  assert.equal(EXECUTOR_PROVIDER_INFO.opencode.sessionIdAssignment, 'cli');
  assert.equal(isExecutorProviderId('opencode'), true);
  assert.equal(isExecutorProviderId('codex'), false, 'the reviewer is not an executor');
  assert.equal(isExecutorProviderId(undefined), false);
  assert.equal(new ClaudeCodeCliAdapter({ executable: 'x' }).sessionIdAssignment, 'caller');
  assert.equal(new OpenCodeCliAdapter({ executable: 'x' }).sessionIdAssignment, 'cli');
});

test('config: executor defaults to Claude Code; old files stay valid; a project can pick OpenCode', () => {
  assert.deepEqual(DEFAULT_CONFIG.executor, { provider: 'claude-code' });
  assert.deepEqual(validateConfig({ maxIterations: 3 }).config.executor, { provider: 'claude-code' });
  const r = validateConfig({ executor: { provider: 'opencode' }, models: { opencode: 'anthropic/claude-opus-5-5' }, permissions: { opencode: 'ask' } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config.executor, { provider: 'opencode' });
  assert.deepEqual(r.config.models, { claude: null, opencode: 'anthropic/claude-opus-5-5' });
  assert.equal(r.config.permissions.opencode, 'ask');
  assert.equal(r.config.permissions.claude, 'bypass', 'the other providers keep their defaults');
});

test('config: a bad executor is reported specifically, never coerced', () => {
  assert.match(validateConfig({ executor: { provider: 'codex' } }).errors.join(' '), /executor\.provider must be one of claude-code, opencode/);
  assert.match(validateConfig({ executor: 'opencode' }).errors.join(' '), /executor must be an object/);
  assert.match(validateConfig({ executor: { provider: 'opencode', model: 'x' } }).errors.join(' '), /Unknown executor field: "model"/);
  assert.deepEqual(validateConfig({ executor: { provider: 'codex' } }).config.executor, { provider: 'claude-code' });
});

test('config: an OpenCode model is provider/model and may not look like a flag', () => {
  for (const ok of ['anthropic/claude-opus-5-5', '9router-opencode-1/oc/deepseek-v4-flash-free', 'opencode/big-pickle']) assert.equal(isValidOpenCodeModelName(ok), true, ok);
  for (const bad of ['--model', '-m', 'a b', '', '/x', 5, null]) assert.equal(isValidOpenCodeModelName(bad), false, String(bad));
  assert.match(validateConfig({ models: { opencode: '--evil' } }).errors.join(' '), /models\.opencode must be null/);
  assert.deepEqual(validateConfig({ models: { opencode: null } }).errors, []);
});

test('permissions: OpenCode resolves its own setting, separate from Claude and Codex', () => {
  const r = resolvePermissionPolicy({ provider: 'opencode', settings: { opencode: 'ask', claude: 'bypass' } });
  assert.ok(r.ok);
  assert.equal(r.policy.resolved, 'ask');
  assert.equal(r.policy.provider, 'opencode');
});

// ---------------------------------------------------------------------------
// A full run
// ---------------------------------------------------------------------------

test('run with OpenCode: NEW session in round 1, --session resume in round 2, recorded as provider opencode', () =>
  withProject(async (projectPath) => {
    const config = withExecutor('opencode', { models: { claude: null, opencode: 'anthropic/claude-opus-5-5' } });
    const outcome = await engine(projectPath, config, { codexDoneAt: '2' }).start({ task: 'do it', maxIterations: 3 });
    assert.equal(outcome.kind, 'COMPLETED');
    assert.equal(outcome.kind === 'COMPLETED' && outcome.finalStatus, 'DONE');
    assert.equal(outcome.kind === 'COMPLETED' && outcome.claudeSessionId, 'ses_fake0001', 'the id the CLI created is the one tracked');

    const dir = await sessionDir(projectPath);
    const one = await record(dir, '001-claude-execution.json');
    assert.equal(one.provider, 'opencode');
    assert.equal(one.mode, 'NEW');
    assert.deepEqual(one.cliSessionId, { requested: null, reported: 'ses_fake0001', evidence: 'CONFIRMED_BY_CLI' });
    assert.ok(!one.command.args.includes('--session'));
    assert.deepEqual(one.permission?.cliArgs, ['--dangerously-skip-permissions']);
    assert.equal(one.permission?.provider, 'opencode');
    assert.deepEqual(one.model, { requested: 'anthropic/claude-opus-5-5', reported: null });
    assert.ok(one.command.args.includes('anthropic/claude-opus-5-5'));

    const two = await record(dir, '002-claude-execution.json');
    assert.equal(two.mode, 'RESUME');
    assert.equal(two.continuity.verdict, 'VERIFIED');
    assert.equal(two.cliSessionId.requested, 'ses_fake0001');
    assert.equal(two.command.args[two.command.args.indexOf('--session') + 1], 'ses_fake0001');

    const started = (await events(projectPath)).find((e) => e.event === 'RUN_STARTED');
    assert.equal(started?.executor, 'opencode');
    const state = JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'state', 'current-session.json'), 'utf8'));
    assert.equal(state.executor, 'opencode');
    assert.equal(state.claudeSessionId, 'ses_fake0001');
    assert.match(await readFile(path.join(dir, '001-claude-report.md'), 'utf8'), /OpenCode|opencode/);
  }));

test('run with the default executor is unchanged: Claude Code, caller-made session id, provider claude-code', () =>
  withProject(async (projectPath) => {
    await engine(projectPath, withExecutor('claude-code'), { prefix: FAKE_CLAUDE, claudeEnv: { FAKE_CLAUDE_MODE: 'ok' } }).start({ task: 'do it', maxIterations: 1 });
    const dir = await sessionDir(projectPath);
    const rec = await record(dir, '001-claude-execution.json');
    assert.equal(rec.provider, 'claude-code');
    assert.ok(rec.cliSessionId.requested, 'Claude gets an id made by AI Bridge');
    assert.deepEqual(rec.permission?.cliArgs, ['--permission-mode', 'bypassPermissions']);
    assert.equal((await record(dir, '001-codex-execution.json')).provider, undefined, 'the reviewer record is untouched');
    const state = JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'state', 'current-session.json'), 'utf8'));
    assert.equal(state.executor, 'claude-code');
  }));

test('the OpenCode permission setting is what the run uses (ask → no bypass flag)', () =>
  withProject(async (projectPath) => {
    const config = withExecutor('opencode');
    config.permissions = { ...config.permissions, opencode: 'ask', claude: 'bypass' };
    await engine(projectPath, config).start({ task: 'do it', maxIterations: 1 });
    const rec = await record(await sessionDir(projectPath), '001-claude-execution.json');
    assert.deepEqual(rec.permission?.cliArgs, []);
    assert.equal(rec.permission?.resolved, 'ask');
    assert.ok(!rec.command.args.includes('--dangerously-skip-permissions'));
  }));

test('an OpenCode failure that exits 0 stops the run with the CLI message, not a silent success', () =>
  withProject(async (projectPath) => {
    const outcome = await engine(projectPath, withExecutor('opencode'), { claudeEnv: { FAKE_OPENCODE_MODE: 'error-event' } }).start({ task: 'do it', maxIterations: 2 });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') return;
    assert.equal(outcome.finalStatus, 'ERROR');
    assert.equal(outcome.errorCode, 'CLAUDE_RUN_FAILED:CLI_REPORTED_ERROR');
    assert.match(outcome.errorMessage ?? '', /APIError: Not Found/);
    const rec = await record(await sessionDir(projectPath), '001-claude-execution.json');
    assert.equal(rec.status, 'FAILED');
    assert.equal(rec.errorCode, 'CLI_REPORTED_ERROR');
    assert.equal(rec.provider, 'opencode');
  }));

test('answering in chat without writing the report is REPORT_INVALID for OpenCode too (no stale or invented report)', () =>
  withProject(async (projectPath) => {
    const outcome = await engine(projectPath, withExecutor('opencode'), { claudeEnv: { FAKE_OPENCODE_MODE: 'answer-in-chat' } }).start({ task: 'do it', maxIterations: 1 });
    assert.equal(outcome.kind === 'COMPLETED' && outcome.errorCode, 'REPORT_INVALID');
  }));

// ---------------------------------------------------------------------------
// Resume keeps the executor the run started with
// ---------------------------------------------------------------------------

test('resume uses the run\'s own executor even when the project setting changed in between', () =>
  withProject(async (projectPath) => {
    const seen: Array<ExecutorProviderId | undefined> = [];
    const first = await engine(projectPath, withExecutor('opencode'), { codexDoneAt: '2', seen }).start({
      task: 'do it',
      maxIterations: 3,
      crashInjection: { at: 'AFTER_PROMPT_PERSISTED', onTrigger: () => {} },
    });
    assert.equal(first.kind === 'COMPLETED' && first.errorCode, 'CRASH_INJECTED:AFTER_PROMPT_PERSISTED');
    await leaveCrashCheckpoint(projectPath);

    // The project now says Claude Code — but the interrupted run's session ids belong to OpenCode.
    const resumed = await engine(projectPath, withExecutor('claude-code'), { codexDoneAt: '2', seen }).resume();
    assert.equal(resumed.kind, 'COMPLETED');
    assert.equal(resumed.kind === 'COMPLETED' && resumed.finalStatus, 'DONE');
    assert.deepEqual(seen, [undefined, 'opencode'], 'start follows the config; resume asks the doctor for the run\'s executor');

    const two = await record(await sessionDir(projectPath), '002-claude-execution.json');
    assert.equal(two.provider, 'opencode');
    assert.equal(two.mode, 'RESUME');
    assert.equal(two.continuity.verdict, 'VERIFIED');
  }));

test('a state file written before this feature (no executor field) resumes as Claude Code', () =>
  withProject(async (projectPath) => {
    const seen: Array<ExecutorProviderId | undefined> = [];
    // Claude Code run that stops after its first Claude call…
    await engine(projectPath, withExecutor('claude-code'), { prefix: FAKE_CLAUDE, claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexDoneAt: '2', seen }).start({
      task: 'do it',
      maxIterations: 3,
      crashInjection: { at: 'AFTER_PROMPT_PERSISTED', onTrigger: () => {} },
    });
    // …whose state is then rewritten the way an older version wrote it: no `executor`.
    await leaveCrashCheckpoint(projectPath, ['executor']);

    // The project now says OpenCode; the old run must still resume with Claude Code.
    const resumed = await engine(projectPath, withExecutor('opencode'), { prefix: FAKE_CLAUDE, claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexDoneAt: '2', seen }).resume();
    assert.equal(resumed.kind === 'COMPLETED' && resumed.finalStatus, 'DONE');
    assert.deepEqual(seen, [undefined, 'claude-code']);
    assert.equal((await record(await sessionDir(projectPath), '002-claude-execution.json')).provider, 'claude-code');
  }));
