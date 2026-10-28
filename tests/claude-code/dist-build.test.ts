import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COMMITTED = path.join(ROOT, 'plugins', 'claude-code', 'dist', 'hook.mjs');

test('the committed plugin hook is the build of the current source (run `pnpm build:claude-plugin` after changing it)', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'ai-bridge-dist-'));
  try {
    await promisify(execFile)(process.execPath, [path.join(ROOT, 'scripts', 'claude-plugin', 'build.ts'), '--out', out], { cwd: tmpdir() });
    const fresh = await readFile(path.join(out, 'hook.mjs'), 'utf8');
    const committed = await readFile(COMMITTED, 'utf8');
    assert.ok(fresh === committed, 'plugins/claude-code/dist/hook.mjs is out of date: run `pnpm build:claude-plugin` and commit it');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
