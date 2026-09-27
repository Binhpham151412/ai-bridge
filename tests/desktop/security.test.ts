import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guarantees about the desktop layer (M4 §3, §4, §29): verified on the source
// itself so a future edit cannot quietly weaken them. Runtime checks of the same
// properties (in real Electron) are in scripts/desktop/smoke.ts.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DESKTOP = path.join(ROOT, 'src', 'desktop');

async function filesUnder(dir: string, exts = ['.ts', '.tsx']): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full, exts)));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const rel = (f: string) => path.relative(ROOT, f);

test('BrowserWindow: contextIsolation on, nodeIntegration off, sandbox on, no webview, navigation/new windows denied', async () => {
  const main = stripComments(await readFile(path.join(DESKTOP, 'main', 'main.ts'), 'utf8'));
  for (const required of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true', 'webviewTag: false', 'allowRunningInsecureContent: false', 'app.enableSandbox()']) {
    assert.ok(main.includes(required), `missing: ${required}`);
  }
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /'will-navigate', \(event\) => event\.preventDefault\(\)/);
  assert.match(main, /setPermissionRequestHandler\(\([^)]*\) => callback\(false\)\)/);
  for (const forbidden of ['sandbox: false', 'contextIsolation: false', 'nodeIntegration: true', 'webSecurity: false', 'nodeIntegrationInWorker: true', 'enableRemoteModule']) {
    assert.ok(!main.includes(forbidden), `forbidden: ${forbidden}`);
  }
});

test('IPC: Main registers handlers only by looping over the allowlist; no ipcMain.on / catch-all', async () => {
  const main = stripComments(await readFile(path.join(DESKTOP, 'main', 'main.ts'), 'utf8'));
  assert.match(main, /for \(const channel of INVOKE_CHANNELS\) \{\s*ipcMain\.handle\(channel,/);
  assert.equal((main.match(/ipcMain\.handle\(/g) ?? []).length, 1);
  assert.ok(!/ipcMain\.on\(|ipcMain\.handleOnce\(|ipcMain\.addListener\(/.test(main));
});

test('preload exposes exactly one object (window.aiBridge) and imports nothing but electron + the typed API', async () => {
  const preload = stripComments(await readFile(path.join(DESKTOP, 'preload', 'preload.ts'), 'utf8'));
  const imports = [...preload.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./bridge-api.ts', 'electron']);
  assert.deepEqual([...preload.matchAll(/exposeInMainWorld\(\s*'([^']+)'/g)].map((m) => m[1]), ['aiBridge']);
  const api = stripComments(await readFile(path.join(DESKTOP, 'preload', 'bridge-api.ts'), 'utf8'));
  assert.ok(!/from\s+['"](electron|node:[^'"]+)['"]/.test(api), 'bridge-api has no Electron/Node runtime imports');
});

test('renderer: no Node/Electron access, no require/process/fs/child_process, only type imports from Core', async () => {
  const offenders: string[] = [];
  for (const file of await filesUnder(path.join(DESKTOP, 'renderer'))) {
    const text = stripComments(await readFile(file, 'utf8'));
    if (/from\s+['"](node:[^'"]+|electron|fs|child_process|path|os|process)['"]/.test(text)) offenders.push(`${rel(file)}: node/electron import`);
    if (/\brequire\s*\(/.test(text)) offenders.push(`${rel(file)}: require()`);
    // The Node global only — not a `.process` property of a record (e.g. record.process.pid).
    if (/(?<![.\w])process\./.test(text)) offenders.push(`${rel(file)}: process.*`);
    for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (/\/core\//.test(m[1]) || /\/main\//.test(m[1])) offenders.push(`${rel(file)}: runtime import of ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('desktop code: no eval/new Function, no raw HTML injection, no remote module, no shell/openExternal', async () => {
  const offenders: string[] = [];
  for (const file of await filesUnder(DESKTOP)) {
    const text = stripComments(await readFile(file, 'utf8'));
    for (const [pattern, label] of [
      [/\beval\s*\(/, 'eval'],
      [/new\s+Function\s*\(/, 'new Function'],
      [/dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML'],
      [/innerHTML\s*=/, 'innerHTML'],
      [/@electron\/remote|\bremote\./, 'remote module'],
      [/\bshell\.(openExternal|openPath)/, 'shell'],
      [/dangerouslySkipPermissions|bypassPermissions/, 'permission bypass'],
    ] as const) {
      if (pattern.test(text)) offenders.push(`${rel(file)}: ${label}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no network, telemetry or paid API anywhere in the desktop layer; renderer CSP forbids connections', async () => {
  const offenders: string[] = [];
  for (const file of await filesUnder(DESKTOP)) {
    const text = stripComments(await readFile(file, 'utf8'));
    if (/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|navigator\.sendBeacon|node:https?\b|['"]https?:\/\//.test(text)) offenders.push(rel(file));
    if (/api\.openai\.com|api\.anthropic\.com|OPENAI_API_KEY|ANTHROPIC_API_KEY/.test(text)) offenders.push(`${rel(file)}: paid API reference`);
  }
  assert.deepEqual(offenders, []);
  const html = await readFile(path.join(DESKTOP, 'renderer', 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /unsafe-eval|unsafe-inline/);
});

test('Core never depends on the desktop layer (dependency points one way: desktop → Core)', async () => {
  const offenders: string[] = [];
  for (const dir of ['core', 'adapters', 'reports', 'prompts', 'automation']) {
    for (const file of await filesUnder(path.join(ROOT, 'src', dir))) {
      if (/from\s+['"][^'"]*\/desktop\//.test(await readFile(file, 'utf8'))) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('no orchestration/recovery/process-kill logic is duplicated in the desktop layer — it only calls BridgeEngine', async () => {
  const offenders: string[] = [];
  for (const file of await filesUnder(DESKTOP)) {
    const text = stripComments(await readFile(file, 'utf8'));
    if (/\bnew\s+Orchestrator\b|decideRecoveryStrategy|requestStop\(|killProcessTree|acquireLock\(|taskkill/.test(text)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], 'orchestration/recovery/process logic must stay in Core');
});
