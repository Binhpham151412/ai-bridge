import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../src/automation/process-runner.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/process/', import.meta.url));
const fixture = (name: string) => path.join(FIXTURES, name);
const node = process.execPath;

test('captures stdout and a zero exit code for a simple command', async () => {
  const r = await runProcess({ command: node, args: [fixture('stdout-stderr.mjs')], timeoutMs: 5000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'out');
  assert.equal(r.timedOut, false);
});

test('captures stderr separately from stdout', async () => {
  const r = await runProcess({ command: node, args: [fixture('stdout-stderr.mjs')], timeoutMs: 5000 });
  assert.equal(r.stderr, 'err');
});

test('writes the given input to the child process stdin as UTF-8', async () => {
  const r = await runProcess({ command: node, args: [fixture('echo-stdin.mjs')], input: 'Xin chào, thế giới!', timeoutMs: 5000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'got:Xin chào, thế giới!');
});

test('runs with no stdin when input is omitted', async () => {
  const r = await runProcess({ command: node, args: [fixture('echo-stdin.mjs')], timeoutMs: 5000 });
  assert.equal(r.stdout, 'got:');
});

test('captures a non-zero exit code without throwing', async () => {
  const r = await runProcess({ command: node, args: [fixture('exit-code.mjs'), '3'], timeoutMs: 5000 });
  assert.equal(r.exitCode, 3);
});

test('passes the exact env provided to the child process', async () => {
  const r = await runProcess({ command: node, args: [fixture('env-echo.mjs')], env: { FOO: 'bar' }, timeoutMs: 5000 });
  assert.equal(r.stdout, 'bar');
});

test('the child does not see FOO when it is omitted from env', async () => {
  const r = await runProcess({ command: node, args: [fixture('env-echo.mjs')], env: {}, timeoutMs: 5000 });
  assert.equal(r.stdout, 'undef');
});

test('reports a duration close to how long the process actually ran', async () => {
  const r = await runProcess({ command: node, args: ['-e', 'setTimeout(() => process.exit(0), 150)'], timeoutMs: 5000 });
  assert.ok(r.durationMs >= 100, `durationMs was ${r.durationMs}`);
});

test('kills a process that exceeds timeoutMs and reports timedOut', async () => {
  const start = Date.now();
  const r = await runProcess({ command: node, args: [fixture('sleep-forever.mjs')], timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - start < 5000, 'runProcess should resolve promptly after killing, not hang');
});

test('kills the entire process tree on timeout, not just the direct child', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-tree-kill-'));
  const heartbeatFile = path.join(dir, 'heartbeat.txt');
  try {
    await runProcess({ command: node, args: [fixture('tree-parent.mjs'), heartbeatFile], timeoutMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const v1 = await readFile(heartbeatFile, 'utf8').catch(() => 'never-written');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const v2 = await readFile(heartbeatFile, 'utf8').catch(() => 'never-written');
    assert.equal(v2, v1, `heartbeat file kept growing after timeout kill (v1=${v1}, v2=${v2}); the grandchild process survived`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('calls onSpawn with the real child pid as soon as the process starts', async () => {
  let reportedPid: number | undefined;
  const r = await runProcess({ command: node, args: [fixture('exit-code.mjs'), '0'], timeoutMs: 5000, onSpawn: (pid) => { reportedPid = pid; } });
  assert.equal(r.exitCode, 0);
  assert.equal(typeof reportedPid, 'number');
  assert.ok(reportedPid! > 0);
});

test('does not time out a process that finishes well within timeoutMs', async () => {
  const r = await runProcess({ command: node, args: [fixture('exit-code.mjs'), '0'], timeoutMs: 5000 });
  assert.equal(r.timedOut, false);
});

test('captures full stdout when it is well under maxBufferBytes', async () => {
  const r = await runProcess({ command: node, args: [fixture('flood-stdout.mjs'), '50'], timeoutMs: 5000, maxBufferBytes: 1_000_000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.length, 50 * 101);
  assert.equal(r.stdoutTruncated, false);
});

test('caps stdout accumulation at maxBufferBytes instead of growing unboundedly, and reports stdoutTruncated', async () => {
  // 5000 lines * 101 bytes = ~505,000 bytes of real output; the cap only checks between
  // discrete 'data' events (it can't split a single OS-delivered chunk), so under load a
  // chunk can carry noticeably more than the cap before the check fires next — the
  // tolerance here is "nowhere near unbounded," not "byte-precise."
  const r = await runProcess({ command: node, args: [fixture('flood-stdout.mjs'), '5000'], timeoutMs: 5000, maxBufferBytes: 1000 });
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout.length < 50_000, `expected stdout to be capped well short of the full ~505,000 bytes, got ${r.stdout.length}`);
  assert.equal(r.stdoutTruncated, true);
});

test('a real timeout kill still works when maxBufferBytes is set', async () => {
  const r = await runProcess({ command: node, args: [fixture('sleep-forever.mjs')], timeoutMs: 300, maxBufferBytes: 1000 });
  assert.equal(r.timedOut, true);
});

test('defaults to a generous maxBufferBytes when not specified, so normal-sized real output is never truncated', async () => {
  const r = await runProcess({ command: node, args: [fixture('flood-stdout.mjs'), '1000'], timeoutMs: 5000 });
  assert.equal(r.stdoutTruncated, false);
  assert.equal(r.stdout.length, 1000 * 101);
});
