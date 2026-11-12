import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from '../src/cli-args.ts';
import { runJudgeCli, type JudgeCliDeps, type JudgeCliIo } from '../src/core/judge/judge-command.ts';
import { sampleRequest } from './judge-contract.test.ts';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

const passBlock =
  '```json\n' +
  JSON.stringify({ verdict: 'pass', metrics: [{ id: 'grounded', value: null, passed: true }, { id: 'policy_and_tone', value: null, passed: true }], reasons: ['Grounded.'], feedback: [] }) +
  '\n```\n';
const failBlock =
  '```json\n' +
  JSON.stringify({ verdict: 'fail', metrics: [{ id: 'grounded', value: null, passed: false }, { id: 'policy_and_tone', value: null, passed: true }], reasons: ['C1 is unsupported.'], feedback: [{ claim_id: 'C1', message: 'Remove C1.', action: 'remove_or_replace_with_supported' }] }) +
  '\n```\n';

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
  return { ...env, ...extra };
}

function harness(stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: JudgeCliIo = { out: (l) => out.push(l), err: (l) => err.push(l), readStdin: async () => stdin };
  return { io, out, err };
}

const deps = (response: string, extra: Partial<JudgeCliDeps> = {}): JudgeCliDeps => ({
  resolveCodex: async () => process.execPath,
  commandArgsPrefix: [FAKE_CLI],
  env: cleanEnv({ FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: response }),
  ...extra,
});

async function withRequestFile<T>(fn: (file: string, dir: string) => Promise<T>, body: unknown = sampleRequest()): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-judge-cli-'));
  try {
    const file = path.join(dir, 'request.json');
    await writeFile(file, JSON.stringify(body), 'utf8');
    return await fn(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a request file gives one JSON verdict on stdout and exit 0', () =>
  withRequestFile(async (file, dir) => {
    const h = harness();
    const code = await runJudgeCli({ request: file, model: 'gpt-test' }, h.io, deps(passBlock, { tmpRoot: dir }));
    assert.equal(code, 0);
    assert.equal(h.err.length, 0);
    assert.equal(h.out.length, 1); // stdout carries the verdict and nothing else
    const verdict = JSON.parse(h.out[0]);
    assert.deepEqual([verdict.schema, verdict.verdict, verdict.draft_version, verdict.iteration, verdict.model], ['goalforge/judge-verdict@1', 'pass', 2, 3, 'gpt-test']);
    assert.deepEqual((await readdir(dir)).sort(), ['request.json']); // no scratch left behind
  }));

test('the request can come from stdin with "-"', async () => {
  const h = harness(JSON.stringify(sampleRequest()));
  const code = await runJudgeCli({ request: '-' }, h.io, deps(passBlock));
  assert.equal(code, 0);
  assert.equal(JSON.parse(h.out[0]).verdict, 'pass');
});

test('a fail verdict is still a verdict: exit 0, with its reasons and feedback', async () => {
  const h = harness(JSON.stringify(sampleRequest()));
  assert.equal(await runJudgeCli({ request: '-' }, h.io, deps(failBlock)), 0);
  const verdict = JSON.parse(h.out[0]);
  assert.deepEqual([verdict.verdict, verdict.reasons, verdict.feedback[0].claim_id], ['fail', ['C1 is unsupported.'], 'C1']);
});

test('without --request it prints the usage and exits 1', async () => {
  const h = harness();
  assert.equal(await runJudgeCli({}, h.io, deps(passBlock)), 1);
  assert.match(h.err[0], /Usage: ai-bridge judge --request/);
  assert.equal(h.out.length, 0);
});

for (const value of ['abc', '999', '0', '99999999']) {
  test(`--timeout-ms ${value} is refused`, async () => {
    const h = harness(JSON.stringify(sampleRequest()));
    assert.equal(await runJudgeCli({ request: '-', 'timeout-ms': value }, h.io, deps(passBlock)), 1);
    assert.match(h.err[0], /^ERROR_BAD_REQUEST: --timeout-ms/);
  });
}

test('a request file that does not exist exits 1 with ERROR_BAD_REQUEST', async () => {
  const h = harness();
  assert.equal(await runJudgeCli({ request: path.join(tmpdir(), 'no-such-judge-request.json') }, h.io, deps(passBlock)), 1);
  assert.match(h.err[0], /^ERROR_BAD_REQUEST: the request could not be read/);
  assert.equal(h.out.length, 0);
});

test('a request that is not valid exits 1 and prints no verdict', async () => {
  const h = harness('{"schema": "nope"}');
  assert.equal(await runJudgeCli({ request: '-' }, h.io, deps(passBlock)), 1);
  assert.match(h.err[0], /^ERROR_BAD_REQUEST: /);
  assert.equal(h.out.length, 0);
});

test('an answer that is not a verdict exits 1 and prints no verdict', async () => {
  const h = harness(JSON.stringify(sampleRequest()));
  assert.equal(await runJudgeCli({ request: '-' }, h.io, deps('I think it is fine.')), 1);
  assert.match(h.err[0], /^ERROR_BAD_RESPONSE: /);
  assert.equal(h.out.length, 0);
});

test('no codex installed exits 2', async () => {
  const h = harness(JSON.stringify(sampleRequest()));
  assert.equal(await runJudgeCli({ request: '-' }, h.io, deps(passBlock, { resolveCodex: async () => null })), 2);
  assert.match(h.err[0], /^ERROR_CODEX_NOT_FOUND/);
  assert.equal(h.out.length, 0);
});

test('an API key in the environment exits 2 and never starts codex', async () => {
  const h = harness(JSON.stringify(sampleRequest()));
  const code = await runJudgeCli({ request: '-' }, h.io, deps(passBlock, { resolveCodex: async () => 'this-executable-does-not-exist', env: cleanEnv({ CODEX_API_KEY: 'k' }) }));
  assert.equal(code, 2);
  assert.match(h.err[0], /^ERROR_BLOCKED_API_KEY: /);
  assert.equal(h.out.length, 0);
});

test('the judge is a command of the CLI', () => {
  const parsed = parseArgs(['judge', '--request', 'req.json', '--timeout-ms', '5000']);
  assert.deepEqual([parsed.command, parsed.flags.request, parsed.flags['timeout-ms'], parsed.error], ['judge', 'req.json', '5000', null]);
});
