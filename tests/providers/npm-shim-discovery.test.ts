import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverExecutable, findNativeExecutableNextToNpmShim } from '../../src/core/providers/executable-discovery.ts';

// docs/64 — OpenCode installed through npm: PATH lists only `opencode` / `opencode.cmd` shims, which a
// no-shell spawn cannot run; the native opencode.exe sits inside the npm package next to them.

async function npmDir<T>(layout: string[], fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-npm-'));
  try {
    for (const rel of layout) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), '', 'utf8');
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PKG = path.join('node_modules', 'opencode-ai', 'node_modules');

test('finds the platform package exe beside the shim, preferring a non-baseline build', () =>
  npmDir([path.join(PKG, 'opencode-windows-x64-baseline', 'bin', 'opencode.exe'), path.join(PKG, 'opencode-windows-x64', 'bin', 'opencode.exe')], async (dir) => {
    const found = await findNativeExecutableNextToNpmShim('opencode', [path.join(dir, 'opencode'), path.join(dir, 'opencode.cmd')]);
    assert.equal(found, path.join(dir, PKG, 'opencode-windows-x64', 'bin', 'opencode.exe'));
  }));

test('falls back to the baseline build, and to a bin/ directly inside the package', () =>
  npmDir([path.join(PKG, 'opencode-windows-x64-baseline', 'bin', 'opencode.exe')], async (dir) => {
    assert.equal(await findNativeExecutableNextToNpmShim('opencode', [path.join(dir, 'opencode.cmd')]), path.join(dir, PKG, 'opencode-windows-x64-baseline', 'bin', 'opencode.exe'));
  }).then(() =>
    npmDir([path.join('node_modules', 'some-cli', 'bin', 'tool.exe')], async (dir) => {
      assert.equal(await findNativeExecutableNextToNpmShim('tool', [path.join(dir, 'tool.cmd')]), path.join(dir, 'node_modules', 'some-cli', 'bin', 'tool.exe'));
    }),
  ));

test('null when the package ships no exe for that name (a shim-only install), or the folder does not exist', () =>
  npmDir([path.join(PKG, 'opencode-windows-x64', 'bin', 'something-else.exe')], async (dir) => {
    assert.equal(await findNativeExecutableNextToNpmShim('opencode', [path.join(dir, 'opencode.cmd')]), null);
    assert.equal(await findNativeExecutableNextToNpmShim('opencode', [path.join(dir, 'missing', 'opencode.cmd')]), null);
  }));

test('discoverExecutable: on Windows a shim-only PATH resolves to the native exe; a real .exe on PATH still wins; no resolver → unchanged', async () => {
  const where = async () => ['C:\\npm\\opencode', 'C:\\npm\\opencode.cmd'];
  const nativeFromShim = async () => 'C:\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe';
  assert.equal(await discoverExecutable('opencode', { where, nativeFromShim, platform: 'win32' }), 'C:\\npm\\node_modules\\opencode-ai\\node_modules\\opencode-windows-x64\\bin\\opencode.exe');
  assert.equal(await discoverExecutable('claude', { where: async () => ['C:\\bin\\claude', 'C:\\bin\\claude.exe'], nativeFromShim: async () => { throw new Error('must not be asked'); }, platform: 'win32' }), 'C:\\bin\\claude.exe');
  assert.equal(await discoverExecutable('opencode', { where, platform: 'win32' }), 'C:\\npm\\opencode', 'without a resolver the first hit is used, as before');
  assert.equal(await discoverExecutable('opencode', { where, nativeFromShim: async () => null, platform: 'win32' }), 'C:\\npm\\opencode', 'nothing found beside the shim → the first hit, as before');
  assert.equal(await discoverExecutable('opencode', { where, nativeFromShim: async () => { throw new Error('boom'); }, platform: 'win32' }), 'C:\\npm\\opencode', 'a resolver error never hides the PATH hit');
  assert.equal(await discoverExecutable('opencode', { where: async () => ['/usr/bin/opencode'], nativeFromShim: async () => { throw new Error('not on posix'); }, platform: 'linux' }), '/usr/bin/opencode');
});
