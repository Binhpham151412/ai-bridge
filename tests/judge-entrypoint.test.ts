import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleRequest } from './judge-contract.test.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The real entry point (`node src/cli.ts judge ...`) with no codex anywhere: nothing real can be called. */
async function runCli(args: string[], stdin: string): Promise<Ran> {
  const empty = await mkdtemp(path.join(tmpdir(), 'ai-bridge-judge-entry-'));
  try {
    const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: empty, PATH: empty };
    const child = spawn(process.execPath, [CLI, 'judge', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(stdin);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { code, stdout, stderr };
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}

test('the judge command is reachable from the real CLI and reports a missing codex as exit 2 with nothing on stdout', async () => {
  const ran = await runCli(['--request', '-'], JSON.stringify(sampleRequest()));
  assert.equal(ran.code, 2);
  assert.match(ran.stderr, /^ERROR_CODEX_NOT_FOUND/);
  assert.equal(ran.stdout, '');
});

test('the real CLI prints the usage and exits 1 without --request', async () => {
  const ran = await runCli([], '');
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /Usage: ai-bridge judge --request/);
});

test('a request that is not valid is refused by the real CLI before codex is looked for... or after, but never runs', async () => {
  const ran = await runCli(['--request', '-'], '{"schema": "nope"}');
  assert.notEqual(ran.code, 0);
  assert.equal(ran.stdout, '');
});
