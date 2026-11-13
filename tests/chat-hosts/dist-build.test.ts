import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installPlugin, pluginsFolder } from '../../scripts/chat-hosts/install.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUILD = path.join(ROOT, 'scripts', 'chat-hosts', 'build.ts');
const lf = (s: string) => s.replace(/\r\n/g, '\n');

for (const [host, dist, file] of [
  ['opencode', 'opencode', 'ai-bridge.js'],
  ['antigravity', 'antigravity', 'hook.mjs'],
] as const) {
  test(`the committed ${host} bundle is the build of the current source (run \`pnpm build:chat-hosts\` after changing src/chat-hosts or what it imports)`, async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'ai-bridge-chat-dist-'));
    try {
      await promisify(execFile)(process.execPath, [BUILD, host, '--out', out], { cwd: tmpdir() });
      const fresh = lf(await readFile(path.join(out, file), 'utf8'));
      const committed = lf(await readFile(path.join(ROOT, 'plugins', dist, 'dist', file), 'utf8'));
      assert.ok(fresh === committed, `plugins/${dist}/dist/${file} is out of date: run \`pnpm build:chat-hosts\` and commit it`);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
}

test('install: OpenCode gets the one bundle file, Antigravity the plugin folder without sources, each in the scope asked for', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-chat-install-'));
  try {
    const home = path.join(dir, 'home');
    assert.equal(pluginsFolder('opencode', { project: '/p' }, home), path.join('/p', '.opencode', 'plugins'));
    assert.equal(pluginsFolder('opencode', { global: true }, home), path.join(home, '.config', 'opencode', 'plugins'));
    assert.equal(pluginsFolder('antigravity', { project: '/p' }, home), path.join('/p', '.agents', 'plugins'));
    assert.equal(pluginsFolder('antigravity', { global: true }, home), path.join(home, '.gemini', 'config', 'plugins'));

    const oc = await installPlugin('opencode', pluginsFolder('opencode', { project: path.join(dir, 'proj') }, home));
    assert.equal(oc, path.join(dir, 'proj', '.opencode', 'plugins', 'ai-bridge.js'));
    assert.equal(lf(await readFile(oc, 'utf8')), lf(await readFile(path.join(ROOT, 'plugins', 'opencode', 'dist', 'ai-bridge.js'), 'utf8')));

    const folder = pluginsFolder('antigravity', { project: path.join(dir, 'proj') }, home);
    const agy = await installPlugin('antigravity', folder);
    await installPlugin('antigravity', folder); // a second install replaces the first
    assert.equal(agy, path.join(folder, 'ai-bridge'));
    assert.deepEqual((await readdir(agy)).sort(), ['dist', 'hooks.json', 'plugin.json', 'skills']);
    assert.deepEqual(await readdir(path.join(agy, 'dist')), ['hook.mjs']);
    assert.deepEqual(await readdir(path.join(agy, 'skills')), ['bridge']);
    await assert.rejects(readFile(path.join(home, 'x')), 'nothing was written outside the folders named');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
