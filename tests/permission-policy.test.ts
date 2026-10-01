import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine, type BridgeEngineDeps, type Preflight } from '../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG, validateConfig, type AiBridgeConfig } from '../src/core/config/config.ts';
import { resolvePermissionPolicy, DEFAULT_PERMISSION_POLICY } from '../src/core/permissions/permission-policy.ts';
import { CLAUDE_PERMISSION_CAPABILITY, claudePermissionArgs } from '../src/adapters/claude/claude-code-cli-adapter.ts';
import { CODEX_PERMISSION_CAPABILITY, CodexCliAdapter, codexPermissionArgs } from '../src/adapters/chatgpt/codex-cli-adapter.ts';
import type { ExecutionRecord } from '../src/core/execution/execution-record.ts';
import { isHostCommand, type HostCommand } from '../src/desktop/main/run-host-protocol.ts';
import { ForkedExecutionPort } from '../src/hosts/forked-execution-port.ts';

// M5.10.1 — provider permission policy (docs/61). Fake Claude/Codex CLIs only: no real
// provider is ever started and no quota is used.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const doctorWith = (config: AiBridgeConfig): ((p: string) => Promise<Preflight>) => async () => ({
  report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
  claudeExe: process.execPath,
  codexExe: process.execPath,
  config,
  configErrors: [],
  gitWarning: null,
});

function makeEngine(projectPath: string, config: AiBridgeConfig = DEFAULT_CONFIG, overrides: Partial<BridgeEngineDeps> = {}): BridgeEngine {
  return new BridgeEngine(projectPath, {
    runDoctor: doctorWith(config),
    claudeCommandArgsPrefix: [FAKE_CLAUDE],
    codexCommandArgsPrefix: [FAKE_CODEX],
    claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
    codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' },
    ...overrides,
  });
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-perm-'));
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
const withPermissions = (claude: 'ask' | 'bypass', codex: 'ask' | 'bypass'): AiBridgeConfig => ({ ...DEFAULT_CONFIG, permissions: { claude, codex } });

/** The value the fake Claude CLI echoes for `--permission-mode` (debug_permission_mode). */
async function claudeReceivedMode(dir: string, nnn: string): Promise<string | null> {
  for (const line of (await readFile(path.join(dir, `${nnn}-claude-stdout.jsonl`), 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { type?: string; text?: string };
    if (e.type === 'debug_permission_mode') return e.text ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1–4: resolution
// ---------------------------------------------------------------------------

test('1. the default policy resolves to bypass — no setting, an empty config.json, a pre-M5.10.1 config.json', () => {
  assert.equal(DEFAULT_PERMISSION_POLICY, 'bypass');
  assert.deepEqual(DEFAULT_CONFIG.permissions, { claude: 'bypass', codex: 'bypass' });
  for (const provider of ['claude', 'codex']) {
    const r = resolvePermissionPolicy({ provider });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual([r.policy.resolved, r.policy.requested, r.policy.source], ['bypass', 'inherit', 'provider-setting']);
  }
  // Backward compatibility: a config written before M5.10.1 stays valid and means bypass.
  const old = validateConfig({ maxIterations: 4, stopOnUncommittedChanges: true });
  assert.deepEqual(old.errors, []);
  assert.deepEqual(old.config.permissions, { claude: 'bypass', codex: 'bypass' });
  // A partial permissions object keeps the default for the provider it omits.
  assert.deepEqual(validateConfig({ permissions: { codex: 'ask' } }).config.permissions, { claude: 'bypass', codex: 'ask' });
});

test('2./3. an explicit provider setting resolves to exactly that value (ask / bypass)', () => {
  for (const policy of ['ask', 'bypass'] as const) {
    const r = resolvePermissionPolicy({ provider: 'claude', requested: 'inherit', settings: { claude: policy, codex: 'bypass' } });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.policy.resolved, policy);
      assert.equal(r.policy.reason, `Global provider permission policy (claude) = ${policy}`);
    }
  }
});

test('4. inherit resolves from the provider setting; an execution override wins over it', () => {
  const settings = { claude: 'ask', codex: 'bypass' };
  const inherit = resolvePermissionPolicy({ provider: 'claude', settings });
  assert.ok(inherit.ok && inherit.policy.resolved === 'ask' && inherit.policy.source === 'provider-setting');
  const override = resolvePermissionPolicy({ provider: 'claude', requested: 'bypass', settings });
  assert.ok(override.ok && override.policy.resolved === 'bypass' && override.policy.source === 'execution-override');
  assert.ok(override.ok && override.policy.reason === 'Execution-level permission override = bypass');
});

// ---------------------------------------------------------------------------
// 5: execution audit (records + journal), end to end through BridgeEngine
// ---------------------------------------------------------------------------

test('5. every execution records the resolved policy and the CLI flags it became (default: bypass), and the journal shows it', () =>
  withProject(async (projectPath) => {
    const outcome = await makeEngine(projectPath).start({ task: 'do it', maxIterations: 1 });
    assert.equal(outcome.kind, 'COMPLETED');
    const dir = await sessionDir(projectPath);

    const claude = await record(dir, '001-claude-execution.json');
    assert.deepEqual(claude.permission, {
      provider: 'claude',
      requested: 'inherit',
      resolved: 'bypass',
      source: 'provider-setting',
      reason: 'Global provider permission policy (claude) = bypass',
      cliArgs: ['--permission-mode', 'bypassPermissions'],
    });
    assert.equal(await claudeReceivedMode(dir, '001'), 'bypassPermissions', 'the fake CLI received exactly the recorded flag');

    const codex = await record(dir, '001-codex-execution.json');
    assert.equal(codex.permission?.resolved, 'bypass');
    assert.deepEqual(codex.permission?.cliArgs, ['--dangerously-bypass-approvals-and-sandbox']);
    assert.ok(codex.command.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!codex.command.args.includes('read-only'), 'bypass replaces the read-only sandbox, never both');

    const journal = await readFile(path.join(dir, '001-claude-report.md'), 'utf8');
    assert.match(journal, /- Permission policy: bypass — Global provider permission policy \(claude\) = bypass; CLI: --permission-mode bypassPermissions/);
    assert.match(await readFile(path.join(dir, '001-review.md'), 'utf8'), /- Codex permission policy: bypass — /);

    const started = (await readFile(path.join(projectPath, '.ai-bridge', 'logs', 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; permissions?: unknown })
      .find((e) => e.event === 'RUN_STARTED');
    assert.deepEqual(started?.permissions, { claude: 'bypass', codex: 'bypass' });
  }));

test('5b. ask in config.json → acceptEdits for Claude and the read-only sandbox for Codex (pre-M5.10.1 behaviour), recorded as such', () =>
  withProject(async (projectPath) => {
    await makeEngine(projectPath, withPermissions('ask', 'ask')).start({ task: 'do it', maxIterations: 1 });
    const dir = await sessionDir(projectPath);
    const claude = await record(dir, '001-claude-execution.json');
    assert.equal(claude.permission?.resolved, 'ask');
    assert.deepEqual(claude.permission?.cliArgs, ['--permission-mode', 'acceptEdits']);
    assert.equal(await claudeReceivedMode(dir, '001'), 'acceptEdits');
    const codex = await record(dir, '001-codex-execution.json');
    assert.deepEqual(codex.permission?.cliArgs, ['-s', 'read-only']);
    assert.ok(!codex.command.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  }));

test('5c. an execution override is recorded as such, persisted with the run, and kept by resume', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath, DEFAULT_CONFIG, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' } });
    await engine.start({ task: 'do it', maxIterations: 2, permissionPolicy: 'ask' });
    const dir = await sessionDir(projectPath);
    const first = await record(dir, '001-claude-execution.json');
    assert.deepEqual([first.permission?.requested, first.permission?.resolved, first.permission?.source], ['ask', 'ask', 'execution-override']);

    const stateFile = path.join(projectPath, '.ai-bridge', 'state', 'current-session.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.permissionPolicy, 'ask');
    // Back to "iteration 1 answered, iteration 2 not started" and resume.
    await writeFile(stateFile, JSON.stringify({ ...state, status: 'RESPONSE_PARSED', iteration: 1 }), 'utf8');
    const resumed = await makeEngine(projectPath, DEFAULT_CONFIG, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' } }).resume();
    assert.equal(resumed.kind, 'COMPLETED');
    const second = await record(dir, '002-claude-execution.json');
    assert.equal(second.mode, 'RESUME', 'session/resume behaviour unchanged');
    assert.deepEqual([second.permission?.requested, second.permission?.resolved, second.permission?.source], ['ask', 'ask', 'execution-override']);
    assert.equal(await claudeReceivedMode(dir, '002'), 'acceptEdits');
  }));

test('5d. a CLI/desktop run that gives no override inherits (requested = inherit) — the workflow default', () =>
  withProject(async (projectPath) => {
    await makeEngine(projectPath, withPermissions('ask', 'bypass')).start({ task: 'do it', maxIterations: 1 });
    const dir = await sessionDir(projectPath);
    const claude = await record(dir, '001-claude-execution.json');
    assert.deepEqual([claude.permission?.requested, claude.permission?.resolved], ['inherit', 'ask']);
    const codex = await record(dir, '001-codex-execution.json');
    assert.deepEqual([codex.permission?.requested, codex.permission?.resolved], ['inherit', 'bypass']);
  }));

test('4b. ExecutionPort carries the override to the Execution Host; omitted means inherit (nothing sent)', async () => {
  const sent: HostCommand[] = [];
  const port = new ForkedExecutionPort({
    projectPath: tmpdir(),
    engine: new BridgeEngine(tmpdir()),
    spawnHost: () => {
      const exitListeners: ((e: { code: number | null; signal: string | null; stderrTail: string }) => void)[] = [];
      return {
        pid: undefined,
        send: (command: HostCommand) => {
          sent.push(command);
          setImmediate(() => exitListeners.forEach((l) => l({ code: null, signal: null, stderrTail: '' })));
        },
        onMessage: () => {},
        onExit: (l) => exitListeners.push(l),
      };
    },
  });
  await port.start({ attemptId: 'wf/s/1', task: 't', maxIterations: 1 });
  await port.start({ attemptId: 'wf/s/2', task: 't', maxIterations: 1, permissionPolicy: 'ask' });
  assert.equal(sent.length, 2);
  assert.equal('permissionPolicy' in sent[0], false);
  assert.equal(sent[1].type === 'start' ? sent[1].permissionPolicy : null, 'ask');
});

// ---------------------------------------------------------------------------
// 6–8: provider mappings (only what the installed CLIs' --help declares)
// ---------------------------------------------------------------------------

test('6./7. Claude mapping: bypass → --permission-mode bypassPermissions, ask → --permission-mode acceptEdits', () => {
  assert.deepEqual(claudePermissionArgs('bypass'), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(claudePermissionArgs('ask'), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(
    CLAUDE_PERMISSION_CAPABILITY.modes.map((m) => [m.policy, m.cliMechanism]),
    [
      ['ask', '--permission-mode acceptEdits'],
      ['bypass', '--permission-mode bypassPermissions'],
    ],
  );
});

test('8. Codex mapping: bypass → --dangerously-bypass-approvals-and-sandbox on exec and exec resume; ask → read-only sandbox', async () => {
  assert.deepEqual(codexPermissionArgs('bypass', false), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(codexPermissionArgs('bypass', true), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(codexPermissionArgs('ask', false), ['-s', 'read-only']);
  assert.deepEqual(codexPermissionArgs('ask', true), ['-c', 'sandbox_mode="read-only"']);
  assert.deepEqual(
    CODEX_PERMISSION_CAPABILITY.modes.map((m) => m.policy),
    ['ask', 'bypass'],
  );

  // Through the real adapter + fake CLI, on a resumed thread (where `-s` is not accepted).
  const out = await mkdtemp(path.join(tmpdir(), 'ai-bridge-perm-codex-'));
  try {
    const adapter = new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] });
    const r = await adapter.run({ cwd: out, input: 'x', threadId: '11111111-1111-1111-1111-111111111111', outputPath: path.join(out, 'o.md'), timeoutMs: 10_000, env: { FAKE_CODEX_MODE: 'ok' }, permissionPolicy: 'bypass' });
    assert.equal(r.ok, true);
    assert.ok(r.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!r.args.includes('-s') && !r.args.some((a) => a.includes('sandbox_mode')));
    // Omitted → the pre-M5.10.1 read-only sandbox (direct adapter callers are unchanged).
    const legacy = await adapter.run({ cwd: out, input: 'x', threadId: null, outputPath: path.join(out, 'o2.md'), timeoutMs: 10_000, env: { FAKE_CODEX_MODE: 'ok' } });
    assert.ok(legacy.args.join(' ').includes('-s read-only'));
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9: fail closed
// ---------------------------------------------------------------------------

test('9. unsupported providers, policies and settings fail closed — never guessed, never silently downgraded', () =>
  withProject(async (projectPath) => {
    for (const bad of [
      resolvePermissionPolicy({ provider: 'gemini' }),
      resolvePermissionPolicy({ provider: 'claude', requested: 'yolo' }),
      resolvePermissionPolicy({ provider: 'claude', settings: { claude: 'dontAsk' } }),
    ]) {
      assert.equal(bad.ok, false);
      if (!bad.ok) assert.equal(bad.code, 'UNSUPPORTED_PERMISSION_POLICY');
    }
    assert.throws(() => claudePermissionArgs('yolo' as never), /Unsupported Claude permission policy/);
    assert.throws(() => codexPermissionArgs('yolo' as never, false), /Unsupported Codex permission policy/);

    const cfg = validateConfig({ permissions: { claude: 'dontAsk', gemini: 'bypass' } });
    assert.equal(cfg.errors.length, 2);
    assert.match(cfg.errors.join(' | '), /permissions\.claude must be one of ask, bypass/);
    assert.match(cfg.errors.join(' | '), /Unknown permissions provider: "gemini"/);
    assert.equal(validateConfig({ permissions: 'bypass' }).errors.length, 1);

    // start() refuses an unknown override before any lock or session exists.
    const outcome = await makeEngine(projectPath).start({ task: 'do it', permissionPolicy: 'yolo' as never });
    assert.equal(outcome.kind, 'INVALID_OPTIONS');
    assert.deepEqual(await readdir(path.join(projectPath, '.ai-bridge', 'sessions')).catch(() => []), []);

    // The host protocol drops a malformed override instead of forwarding it.
    assert.equal(isHostCommand({ type: 'start', projectPath: 'p', task: 't', permissionPolicy: 'yolo' }), false);
    assert.equal(isHostCommand({ type: 'start', projectPath: 'p', task: 't', permissionPolicy: 'bypass' }), true);
  }));

// ---------------------------------------------------------------------------
// 12–13: no secrets, no provider execution from the renderer
// ---------------------------------------------------------------------------

test('12. the recorded policy holds only the policy fields — no environment, credentials or provider output', () =>
  withProject(async (projectPath) => {
    const secret = 'sk-ant-api03-THIS-IS-A-FAKE-TEST-SECRET-0000000000';
    await makeEngine(projectPath, DEFAULT_CONFIG, { claudeEnv: { FAKE_CLAUDE_MODE: 'ok', AI_BRIDGE_TEST_ONLY_SECRET: secret } }).start({ task: 'do it', maxIterations: 1 });
    const dir = await sessionDir(projectPath);
    for (const name of ['001-claude-execution.json', '001-codex-execution.json']) {
      const rec = await record(dir, name);
      assert.deepEqual(Object.keys(rec.permission ?? {}).sort(), ['cliArgs', 'provider', 'reason', 'requested', 'resolved', 'source']);
      assert.ok(!JSON.stringify(rec).includes(secret));
    }
    assert.ok(!(await readFile(path.join(dir, '001-claude-report.md'), 'utf8')).includes(secret));
  }));

test('13. the renderer cannot execute providers: no adapter, process-runner or child_process import anywhere in it', async () => {
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const text = await readFile(full, 'utf8');
        if (/from\s+['"][^'"]*(\/adapters\/|process-runner|child_process|node:)/.test(text)) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  await walk(path.join(ROOT, 'src', 'desktop', 'renderer'));
  assert.deepEqual(offenders, []);
});

test('getConfig() exposes the per-provider policy and what each installed CLI supports (for Settings)', () =>
  withProject(async (projectPath) => {
    const engine = new BridgeEngine(projectPath);
    let view = await engine.getConfig();
    assert.deepEqual(view.config.permissions, { claude: 'bypass', codex: 'bypass' });
    assert.deepEqual(view.permissionCapabilities.map((c) => c.provider), ['claude', 'codex']);
    await mkdir(path.join(projectPath, '.ai-bridge'), { recursive: true });
    await writeFile(path.join(projectPath, '.ai-bridge', 'config.json'), JSON.stringify({ permissions: { claude: 'ask' } }), 'utf8');
    view = await engine.getConfig();
    assert.deepEqual(view.errors, []);
    assert.deepEqual(view.config.permissions, { claude: 'ask', codex: 'bypass' });
    const saved = await engine.saveConfig({ permissions: { claude: 'bypass', codex: 'ask' } });
    assert.equal(saved.kind, 'SAVED');
    assert.deepEqual(JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'config.json'), 'utf8')).permissions, { claude: 'bypass', codex: 'ask' });
    assert.equal((await engine.saveConfig({ permissions: { claude: 'dangerous' } })).kind, 'INVALID');
  }));
