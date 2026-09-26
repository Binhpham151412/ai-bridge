import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateProjectPath } from '../../src/desktop/main/project-path.ts';
import { loadAppSettings, saveAppSettings } from '../../src/desktop/main/app-settings.ts';

test('validateProjectPath accepts an existing absolute directory and returns its real path + name', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-proj-'));
  try {
    const res = await validateProjectPath(dir);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.project.name, path.basename(res.project.path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateProjectPath rejects non-strings, relative paths, UNC shares, files, missing dirs and drive roots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-proj-'));
  const file = path.join(dir, 'file.txt');
  await writeFile(file, 'x');
  try {
    for (const bad of [undefined, 42, '', 'relative\\dir', '..\\..', '\\\\server\\share\\proj', '//server/share', file, path.join(dir, 'missing'), path.parse(dir).root, 'C:\\a\u0000b']) {
      const res = await validateProjectPath(bad);
      assert.equal(res.ok, false, String(bad));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('app settings: missing/corrupt file → defaults; only defaultProjectPath is ever persisted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-settings-'));
  const file = path.join(dir, 'settings.json');
  try {
    assert.deepEqual(await loadAppSettings(file), { defaultProjectPath: null });
    await writeFile(file, '{not json');
    assert.deepEqual(await loadAppSettings(file), { defaultProjectPath: null });
    await saveAppSettings(file, { defaultProjectPath: 'D:\\proj', apiKey: 'nope' } as never);
    assert.deepEqual(await loadAppSettings(file), { defaultProjectPath: 'D:\\proj' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
