import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../src/adapters/chatgpt/codex-cli-adapter.ts';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-codex-adapter-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeAdapter() {
  return new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLI] });
}

test('starts a fresh thread and reports back a thread id', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const r = await adapter.run({ cwd: process.cwd(), input: 'Review this.', threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
    assert.equal(r.errorCode, null);
    assert.equal(r.threadId, '11111111-1111-1111-1111-111111111111');
  }));

test('resumes an existing thread and reports back the same thread id', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const threadId = '33333333-3333-3333-3333-333333333333';
    const r = await adapter.run({ cwd: process.cwd(), input: 'Continue reviewing.', threadId, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.threadId, threadId);
  }));

test('reads the response text from the -o output file, not from stdout', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const response = '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>All good.</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
    const r = await adapter.run({
      cwd: process.cwd(),
      input: 'Review this.',
      threadId: null,
      outputPath: path.join(dir, 'out.md'),
      timeoutMs: 5000,
      env: { FAKE_CODEX_RESPONSE: response },
    });
    assert.equal(r.ok, true);
    assert.equal(r.responseText, response);
  }));

test('sends the input to the CLI verbatim over stdin', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const input = 'CLAUDE REPORT:\n--------------------------------\nVietnamese: Xin chào\n--------------------------------\n';
    const r = await adapter.run({ cwd: process.cwd(), input, threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.stderr, `received:${Buffer.byteLength(input, 'utf8')}\n`);
  }));

test('forwards onSpawn with the real spawned pid', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    let pid: number | undefined;
    const r = await adapter.run({ cwd: process.cwd(), input: 'x', threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000, onSpawn: (p) => { pid = p; } });
    assert.equal(r.ok, true);
    assert.ok(typeof pid === 'number' && pid > 0);
  }));

test('reports a non-zero exit code as NON_ZERO_EXIT', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const r = await adapter.run({ cwd: process.cwd(), input: 'x', threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000, env: { FAKE_CODEX_MODE: 'error-exit' } });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.equal(r.errorCode, 'NON_ZERO_EXIT');
    assert.match(r.stderr, /simulated crash/);
  }));

test('reports malformed stdout JSON as BAD_JSON', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const r = await adapter.run({ cwd: process.cwd(), input: 'x', threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000, env: { FAKE_CODEX_MODE: 'bad-json' } });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'BAD_JSON');
  }));

test('reports a missing thread id as THREAD_MISMATCH', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const r = await adapter.run({ cwd: process.cwd(), input: 'x', threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000, env: { FAKE_CODEX_MODE: 'no-thread-id' } });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'THREAD_MISMATCH');
  }));

test('reports a resumed thread id that does not match the one requested as THREAD_MISMATCH', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const r = await adapter.run({
      cwd: process.cwd(),
      input: 'x',
      threadId: '44444444-4444-4444-4444-444444444444',
      outputPath: path.join(dir, 'out.md'),
      timeoutMs: 5000,
      env: { FAKE_CODEX_MODE: 'wrong-thread-id' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'THREAD_MISMATCH');
  }));

test('reports a missing -o output file as OUTPUT_FILE_MISSING', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const r = await adapter.run({ cwd: process.cwd(), input: 'x', threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000, env: { FAKE_CODEX_MODE: 'no-output-file' } });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'OUTPUT_FILE_MISSING');
  }));

test('kills a hanging CLI at timeoutMs and reports TIMEOUT', () =>
  withTmpDir(async (dir) => {
    const adapter = makeAdapter();
    const start = Date.now();
    const r = await adapter.run({ cwd: process.cwd(), input: 'x', threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 300, env: { FAKE_CODEX_MODE: 'hang' } });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.errorCode, 'TIMEOUT');
    assert.ok(Date.now() - start < 5000);
  }));

test('reports SPAWN_FAILED when the executable does not exist', () =>
  withTmpDir(async (dir) => {
    const adapter = new CodexCliAdapter({ executable: 'this-binary-does-not-exist-ai-bridge' });
    const r = await adapter.run({ cwd: process.cwd(), input: 'x', threadId: null, outputPath: path.join(dir, 'out.md'), timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'SPAWN_FAILED');
  }));
