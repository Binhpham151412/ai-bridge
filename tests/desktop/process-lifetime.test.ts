import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSpawnOptions } from '../../src/desktop/main/process-lifetime.ts';
import { EXECUTION_HOST_LIFETIME } from '../../src/hosts/execution-host-spawn.ts';

// M5.8.1: the process-lifetime contract, on every platform. The real Windows behaviour behind it
// is asserted in tests/workflow/process-lifetime.windows.test.ts.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('with-parent (the default) is exactly the M4 fork: not detached, stderr piped to the parent', () => {
  assert.deepEqual(hostSpawnOptions('with-parent'), { detached: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], capturesStderr: true });
});

test('independent: detached, and nothing but the IPC channel ties the child to its parent', () => {
  assert.deepEqual(hostSpawnOptions('independent'), { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], capturesStderr: false });
});

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('one deliberate boundary: only Execution Hosts forked by a Workflow Host are independent; nothing else picks a lifetime or detaches', async () => {
  assert.equal(EXECUTION_HOST_LIFETIME, 'independent');
  const choosers: string[] = [];
  const detachers: string[] = [];
  for (const file of await tsFiles(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (/'independent'/.test(text) || /\blifetime:\s*[A-Za-z_'"]/.test(text)) choosers.push(rel);
    if (/\bdetached\s*:/.test(text)) detachers.push(rel);
  }
  assert.deepEqual(choosers.sort(), ['src/desktop/main/process-lifetime.ts', 'src/hosts/execution-host-spawn.ts']);
  assert.deepEqual(detachers.sort(), ['src/desktop/main/fork-run-host.ts', 'src/desktop/main/process-lifetime.ts'], 'process-lifetime.ts decides `detached`; fork-run-host.ts applies it; nothing else');
  const main = (await readFile(path.join(ROOT, 'src', 'desktop', 'main', 'main.ts'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/\blifetime\s*:/.test(main), false, 'Main forks the run host and the Workflow Host with the default lifetime');
});
