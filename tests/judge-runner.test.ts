import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../src/adapters/chatgpt/codex-cli-adapter.ts';
import { runJudge } from '../src/core/judge/judge-runner.ts';
import { sampleRequest } from './judge-contract.test.ts';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

/** The developer's own environment minus anything that would trip the cost guard. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
  return { ...env, ...extra };
}

const verdictBlock = (body: unknown): string => '```json\n' + JSON.stringify(body) + '\n```\n';
const passAnswer = verdictBlock({
  verdict: 'pass',
  metrics: [{ id: 'grounded', value: null, passed: true }, { id: 'policy_and_tone', value: null, passed: true }],
  reasons: ['Grounded.'],
  feedback: [],
});

const adapter = () => new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLI] });

async function withScratchRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-judge-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a verdict comes back for the draft version and iteration that were asked about', () =>
  withScratchRoot(async (tmpRoot) => {
    const outcome = await runJudge(JSON.stringify(sampleRequest()), {
      codex: adapter(),
      timeoutMs: 10_000,
      env: cleanEnv({ FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: passAnswer }),
      model: 'gpt-test',
      tmpRoot,
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual([outcome.verdict.verdict, outcome.verdict.draft_version, outcome.verdict.iteration, outcome.verdict.model], ['pass', 2, 3, 'gpt-test']);
    }
    assert.deepEqual(await readdir(tmpRoot), []); // the scratch directory is gone
  }));

test('without --model the verdict says the model is unknown (the CLI does not report it)', () =>
  withScratchRoot(async (tmpRoot) => {
    const outcome = await runJudge(JSON.stringify(sampleRequest()), { codex: adapter(), timeoutMs: 10_000, env: cleanEnv({ FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: passAnswer }), tmpRoot });
    assert.equal(outcome.ok && outcome.verdict.model, 'unknown');
  }));

test('the model is passed to codex exec with -m, after the read-only sandbox flags', () =>
  withScratchRoot(async (dir) => {
    const run = await adapter().run({
      cwd: dir,
      input: 'x',
      threadId: null,
      outputPath: path.join(dir, 'out.md'),
      timeoutMs: 10_000,
      env: cleanEnv({ FAKE_CODEX_MODE: 'ok' }),
      permissionPolicy: 'ask',
      extraArgs: ['-m', 'gpt-test'],
    });
    const sandbox = run.args.indexOf('read-only');
    assert.ok(sandbox !== -1 && run.args.indexOf('-m') > sandbox && run.args[run.args.indexOf('-m') + 1] === 'gpt-test');
    assert.equal(run.args.includes('resume'), false); // a fresh thread, never a resumed one
  }));

test('a response that is not a verdict is BAD_RESPONSE, never a pass', () =>
  withScratchRoot(async (tmpRoot) => {
    const outcome = await runJudge(JSON.stringify(sampleRequest()), { codex: adapter(), timeoutMs: 10_000, env: cleanEnv({ FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: 'Looks fine to me.' }), tmpRoot });
    assert.deepEqual(outcome.ok ? null : outcome.code, 'BAD_RESPONSE');
  }));

test('a codex that exits with an error is CODEX_FAILED', () =>
  withScratchRoot(async (tmpRoot) => {
    const outcome = await runJudge(JSON.stringify(sampleRequest()), { codex: adapter(), timeoutMs: 10_000, env: cleanEnv({ FAKE_CODEX_MODE: 'error-exit' }), tmpRoot });
    assert.deepEqual(outcome.ok ? null : outcome.code, 'CODEX_FAILED');
  }));

test('a codex that never answers is cut off at the time limit: TIMEOUT', () =>
  withScratchRoot(async (tmpRoot) => {
    const started = Date.now();
    const outcome = await runJudge(JSON.stringify(sampleRequest()), { codex: adapter(), timeoutMs: 1_000, env: cleanEnv({ FAKE_CODEX_MODE: 'hang' }), tmpRoot });
    assert.deepEqual(outcome.ok ? null : outcome.code, 'TIMEOUT');
    assert.ok(Date.now() - started < 20_000);
    assert.deepEqual(await readdir(tmpRoot), []);
  }));

test('a request that does not parse is BAD_REQUEST and codex is never started', async () => {
  const neverStarted = new CodexCliAdapter({ executable: 'this-executable-does-not-exist' });
  const outcome = await runJudge('{"schema": "nope"}', { codex: neverStarted, timeoutMs: 1_000, env: cleanEnv() });
  assert.deepEqual(outcome.ok ? null : outcome.code, 'BAD_REQUEST');
});

test('an API key in the environment blocks the run before codex is started', async () => {
  const neverStarted = new CodexCliAdapter({ executable: 'this-executable-does-not-exist' });
  const outcome = await runJudge(JSON.stringify(sampleRequest()), { codex: neverStarted, timeoutMs: 1_000, env: cleanEnv({ OPENAI_API_KEY: 'sk-not-a-real-key' }) });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, 'BLOCKED_API_KEY');
    assert.ok(outcome.message.includes('OPENAI_API_KEY') && !outcome.message.includes('sk-not-a-real-key')); // names the key, never its value
  }
});
