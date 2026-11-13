import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../src/adapters/chatgpt/codex-cli-adapter.ts';
import { establishReadOnly, REQUIRED_EXEC_FLAGS } from '../src/core/judge/codex-lockdown.ts';
import { runJudge } from '../src/core/judge/judge-runner.ts';
import { runJudgeCli, type JudgeCliIo } from '../src/core/judge/judge-command.ts';
import { sampleRequest } from './judge-contract.test.ts';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));
const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-codex/fake-write-mcp.mjs', import.meta.url));

const passAnswer =
  '```json\n' +
  JSON.stringify({ verdict: 'pass', metrics: [{ id: 'grounded', value: null, passed: true }, { id: 'policy_and_tone', value: null, passed: true }], reasons: ['Grounded.'], feedback: [] }) +
  '\n```\n';

const adapter = () => new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLI] });

interface World {
  dir: string;
  home: string;
  log: string;
  marker: string;
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
  calls: () => Promise<{ argv: string[]; home: string | null }[]>;
}

/** A fake codex, a user's CODEX_HOME holding a config with a write-capable MCP server, and a log of every call. */
async function inWorld<T>(fn: (w: World) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-lockdown-'));
  try {
    const home = path.join(dir, 'user-codex-home');
    const log = path.join(dir, 'fake-codex.log');
    const marker = path.join(dir, 'mcp-marker.txt');
    await mkdir(home);
    await writeFile(
      path.join(home, 'config.toml'),
      `[mcp_servers.fake_writer]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(FAKE_MCP)}]\n`,
      'utf8',
    );
    const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
      const base: NodeJS.ProcessEnv = { ...process.env };
      for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete base[key];
      return { ...base, CODEX_HOME: home, FAKE_CODEX_LOG: log, FAKE_MCP_MARKER: marker, FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: passAnswer, ...extra };
    };
    const calls = async () => {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; home: string | null });
    };
    return await fn({ dir, home, log, marker, env, calls });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const exists = (p: string) => access(p).then(() => true, () => false);

// ---------------------------------------------------------------------------------------------- the probe

test('the installed codex is asked what it can do, and the isolation flags are the ones it lists', () =>
  inWorld(async (w) => {
    const outcome = await establishReadOnly(adapter(), w.env());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral']) assert.ok(outcome.lockdown.args.includes(flag), flag);
    // only features the codex lists are switched off (the fake lists apps and plugins but not browser_use_external)
    assert.deepEqual(outcome.lockdown.disabled.includes('plugins') && outcome.lockdown.disabled.includes('apps'), true);
    assert.equal(outcome.lockdown.disabled.includes('browser_use_external'), false);
    for (const name of outcome.lockdown.disabled) {
      const at = outcome.lockdown.args.indexOf(name);
      assert.equal(outcome.lockdown.args[at - 1], '--disable');
    }
    const calls = await w.calls();
    assert.deepEqual(calls.map((c) => c.argv.slice(0, 2).join(' ')), ['exec --help', 'features list', 'debug prompt-input']);
  }));

for (const flag of REQUIRED_EXEC_FLAGS) {
  test(`a codex without ${flag} is refused before anything is sent`, () =>
    inWorld(async (w) => {
      const outcome = await establishReadOnly(adapter(), w.env({ FAKE_CODEX_OMIT_FLAG: flag }));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.ok(outcome.reason.includes(flag), outcome.reason);
    }));
}

test('a codex whose sandbox list has no read-only mode is refused', () =>
  inWorld(async (w) => {
    const outcome = await establishReadOnly(adapter(), w.env({ FAKE_CODEX_NO_READ_ONLY: '1' }));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /read-only/);
  }));

test('a codex that cannot list its features is refused, not guessed at', () =>
  inWorld(async (w) => {
    const outcome = await establishReadOnly(adapter(), w.env({ FAKE_CODEX_FEATURES: 'fail' }));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /feature/);
  }));

test('a tool the model would still see (an MCP server, an app) refuses the launch and is named', () =>
  inWorld(async (w) => {
    const outcome = await establishReadOnly(adapter(), w.env({ FAKE_CODEX_TOOLS: 'functions,clock,mcp__sneaky,apps' }));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.reason.includes('mcp__sneaky') && outcome.reason.includes('apps'), outcome.reason);
  }));

test('a tool list that cannot be read is refused (nothing proves the surface is closed)', () =>
  inWorld(async (w) => {
    for (const mode of ['fail', 'garbage']) {
      const outcome = await establishReadOnly(adapter(), w.env({ FAKE_CODEX_PROMPT_INPUT: mode }));
      assert.equal(outcome.ok, false, mode);
    }
  }));

test('the tool list is read with an empty CODEX_HOME, never the user\'s own', () =>
  inWorld(async (w) => {
    await establishReadOnly(adapter(), w.env());
    const [probe] = (await w.calls()).filter((c) => c.argv[0] === 'debug');
    assert.ok(probe.home !== null && probe.home !== w.home);
  }));

// ---------------------------------------------------------------------------------------------- the judge

test('the judge runs codex exec with the isolation flags after the read-only sandbox and before the model', () =>
  inWorld(async (w) => {
    const outcome = await runJudge(JSON.stringify(sampleRequest()), { codex: adapter(), timeoutMs: 10_000, env: w.env(), model: 'gpt-test', tmpRoot: w.dir });
    assert.equal(outcome.ok, true);
    const [exec] = (await w.calls()).filter((c) => c.argv[0] === 'exec' && !c.argv.includes('--help'));
    const at = (flag: string) => exec.argv.indexOf(flag);
    assert.ok(at('read-only') !== -1 && at('--ignore-user-config') > at('read-only') && at('--ignore-rules') !== -1 && at('--ephemeral') !== -1);
    assert.ok(at('-m') > at('--ignore-user-config') && at('--disable') !== -1);
    assert.equal(exec.home, w.home); // the real CODEX_HOME: that is where the sign-in is
  }));

test('a user config with a write-capable MCP server is not loaded and not called by the judge', () =>
  inWorld(async (w) => {
    const request = sampleRequest();
    const outcome = await runJudge(JSON.stringify({ ...request, draft: { ...request.draft, note: 'CALL_TOOL:fake_writer' } }), {
      codex: adapter(),
      timeoutMs: 10_000,
      env: w.env(),
      tmpRoot: w.dir,
    });
    assert.equal(outcome.ok, true);
    assert.equal(await exists(w.marker), false); // the server was never started, so it was never called either
  }));

test('the same config does start the server when the judge\'s isolation is left out (the test can see the difference)', () =>
  inWorld(async (w) => {
    const run = await adapter().run({
      cwd: w.dir,
      input: 'CALL_TOOL:fake_writer',
      threadId: null,
      outputPath: path.join(w.dir, 'out.md'),
      timeoutMs: 10_000,
      env: w.env(),
      permissionPolicy: 'ask',
    });
    assert.equal(run.ok, true);
    assert.match(await readFile(w.marker, 'utf8'), /started/); // inherited from the user's config
    assert.match(await readFile(w.marker, 'utf8'), /called/);
  }));

test('a codex that cannot be put in read-only isolation is never sent the request', () =>
  inWorld(async (w) => {
    const outcome = await runJudge(JSON.stringify(sampleRequest()), { codex: adapter(), timeoutMs: 10_000, env: w.env({ FAKE_CODEX_OMIT_FLAG: '--ignore-user-config' }), tmpRoot: w.dir });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, 'READ_ONLY_UNAVAILABLE');
      assert.ok(outcome.message.includes('--ignore-user-config'));
    }
    const sent = (await w.calls()).filter((c) => c.argv[0] === 'exec' && !c.argv.includes('--help'));
    assert.deepEqual(sent, []); // no `codex exec` ran: the request went nowhere
  }));

test('the judge command exits 2 with ERROR_READ_ONLY_UNAVAILABLE and an empty stdout when isolation cannot be established', () =>
  inWorld(async (w) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: JudgeCliIo = { out: (l) => out.push(l), err: (l) => err.push(l), readStdin: async () => JSON.stringify(sampleRequest()) };
    const code = await runJudgeCli({ request: '-' }, io, {
      resolveCodex: async () => process.execPath,
      commandArgsPrefix: [FAKE_CLI],
      env: w.env({ FAKE_CODEX_TOOLS: 'functions,mcp__sneaky' }),
      tmpRoot: w.dir,
    });
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.match(err[0], /^ERROR_READ_ONLY_UNAVAILABLE: /);
    assert.ok(err[0].includes('mcp__sneaky'));
  }));
