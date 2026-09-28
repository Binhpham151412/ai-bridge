#!/usr/bin/env node
// Real desktop smoke test: launches the actual Electron app (dev build, or a packaged
// exe via --exe <path>) and verifies from inside the real sandboxed renderer:
// no Node access, the exact preload surface, IPC validation, navigation/popup denial,
// a Core snapshot for the configured project, the real doctor(), and screenshots.
// Uses no Claude/Codex quota (doctor only runs `claude auth status`/`codex login status`).
//
// Usage: node scripts/desktop/smoke.ts <projectPath> [--exe <path>] [--shots <dir>]
import path from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { CdpPage, closeApp, launchApp, ui, waitFor } from './cdp.ts';

const args = process.argv.slice(2);
const projectPath = path.resolve(args[0] ?? '');
const exe = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined;
const shots = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
const userDataDir = path.join(tmpdir(), `ai-bridge-smoke-${Date.now()}`);
const port = 9300 + Math.floor(Math.random() * 500);

const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => results.push({ check: name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = await launchApp({ userDataDir, defaultProjectPath: projectPath, port, exe });
let cdp: CdpPage | null = null;
try {
  const page = await CdpPage.connect(port);
  cdp = page;
  await waitFor('header', () => page.eval<string | null>(ui.text('header')), (t) => t !== null && t.includes(path.basename(projectPath)), 20_000, 250);
  if (shots) {
    await sleep(1500);
    await page.screenshot(path.join(shots, 'dashboard.png'));
  }

  // --- renderer isolation -------------------------------------------------
  const isolation = await page.eval<Record<string, string>>(
    `({ require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer, global: typeof global, electron: typeof electron, ipcRenderer: typeof ipcRenderer })`,
  );
  check('renderer has no Node/Electron globals', Object.values(isolation).every((t) => t === 'undefined'), isolation);

  const surface = await page.eval<{ keys: string[]; frozen: boolean; hasInvoke: boolean }>(
    `({ keys: Object.keys(window.aiBridge).sort(), frozen: Object.isFrozen(window.aiBridge), hasInvoke: 'invoke' in window.aiBridge || 'send' in window.aiBridge })`,
  );
  check('preload exposes only the fixed aiBridge API (19 functions, frozen, no invoke/send)', surface.keys.length === 19 && surface.frozen && !surface.hasInvoke, surface);

  const escape = await page.eval<string>(`(() => { try { return typeof window.aiBridge.start.constructor('return process')(); } catch (e) { return 'blocked: ' + e.message; } })()`);
  check('CSP blocks eval-style escape (Function constructor)', escape.startsWith('blocked'), escape);

  // --- IPC validation from the real renderer --------------------------------
  const invalidStart = await page.eval<{ ok: boolean; error?: { code: string } }>(`window.aiBridge.start({ task: '' })`);
  check('empty task rejected by Main (INVALID_REQUEST)', !invalidStart.ok && invalidStart.error?.code === 'INVALID_REQUEST', invalidStart);
  const smuggled = await page.eval<{ ok: boolean; error?: { code: string } }>(`window.aiBridge.start({ task: 'x', command: 'calc.exe' })`);
  check('extra fields (command) rejected', !smuggled.ok && smuggled.error?.code === 'INVALID_REQUEST', smuggled);
  const traversal = await page.eval<{ ok: boolean; error?: { code: string } }>(`window.aiBridge.getSessionArtifacts({ runId: '../../state' })`);
  check('path traversal runId rejected', !traversal.ok && traversal.error?.code === 'INVALID_REQUEST', traversal);

  // --- navigation / popups ---------------------------------------------------
  const before = await page.eval<string>('location.href');
  await page.eval(`(location.href = 'https://example.com/', true)`).catch(() => undefined);
  await sleep(800);
  const after = await page.eval<string>('location.href');
  check('navigation away from the app is blocked', before === after, { before, after });
  const popup = await page.eval<string>(`String(window.open('https://example.com/'))`);
  check('window.open is denied', popup === 'null', popup);

  // --- Core via IPC ------------------------------------------------------------
  const snap = await page.eval<{ ok: boolean; data: { project: { path: string } | null; status: { status: string } | null } }>(`window.aiBridge.getSnapshot()`);
  check('snapshot comes from Core for the configured project', snap.ok && snap.data.project?.path.toLowerCase() === projectPath.toLowerCase(), snap.data?.status);

  const doctor = await page.eval<{ ok: boolean; data?: { overall: string; checks: { name: string; status: string }[] } }>(`window.aiBridge.doctor()`);
  check(
    'real doctor() runs through IPC → Main → BridgeEngine',
    doctor.ok && doctor.data !== undefined && doctor.data.checks.length >= 9,
    doctor.data?.checks.map((c) => `${c.name}:${c.status}`),
  );

  if (shots) {
    await page.eval(ui.click('nav-system'));
    await page.eval(ui.click('btn-doctor'));
    await waitFor('doctor table', () => page.eval<boolean>(`!!document.querySelector('[data-testid="doctor-table"]')`), (v) => v, 60_000, 500);
    await page.screenshot(path.join(shots, 'system-check.png'));
    await page.eval(ui.click('nav-journal'));
    await sleep(800);
    await page.screenshot(path.join(shots, 'journal.png'));
    // ARTIFACTS opens on the project's current session by default.
    await page.eval(ui.click('nav-artifacts'));
    await sleep(800);
    await page.screenshot(path.join(shots, 'artifacts.png'));
    await page.eval(ui.click('nav-settings'));
    await sleep(600);
    await page.screenshot(path.join(shots, 'settings.png'));
    await page.eval(ui.click('nav-run'));
  }
} catch (err) {
  check('smoke run completed', false, err instanceof Error ? err.message : String(err));
} finally {
  cdp?.close();
  await closeApp(app);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? `  ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} smoke checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
