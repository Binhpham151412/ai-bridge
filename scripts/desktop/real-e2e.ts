#!/usr/bin/env node
// REAL integration tests through the real Electron app (M4 §26): real renderer UI
// (buttons clicked in the page via CDP) → preload → IPC → Main → run host →
// BridgeEngine → real `claude` CLI → report → real `codex` CLI → prompt → ...
// Consumes real Claude/Codex subscription quota ($0 extra). NEVER run by `pnpm test`.
// Only ever point it at a disposable sandbox/* project.
//
// Usage: node scripts/desktop/real-e2e.ts <normal|multi|pause|recovery|stop> <projectPath> [--exe <packaged exe>]
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { CdpPage, closeApp, isPidAlive, launchApp, ROOT, ui, waitFor } from './cdp.ts';

const execFileAsync = promisify(execFile);
const [scenario, projectArg] = process.argv.slice(2);
if (!scenario || !projectArg) {
  console.error('Usage: real-e2e.ts <normal|multi|pause|recovery|stop> <projectPath>');
  process.exit(1);
}
const projectPath = path.resolve(projectArg);
const exeIndex = process.argv.indexOf('--exe');
const exe = exeIndex !== -1 ? path.resolve(process.argv[exeIndex + 1]) : undefined;
const shotsDir = path.join(ROOT, 'sandbox', 'm4-real-results', exe ? `${scenario}-packaged` : scenario);
const userDataDir = path.join(tmpdir(), `ai-bridge-real-${scenario}-${Date.now()}`);
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The reviewer only ever sees the report, so the report itself must make the unfinished
// goal explicit — otherwise real Codex (correctly) judges the visible work DONE.
const TWO_PART_TASK = [
  'GOAL: src/calc.js must export BOTH add(a, b) returning a + b AND subtract(a, b) returning a - b (CommonJS module.exports). The GOAL is complete only when both exist.',
  'CONSTRAINT FOR THIS ITERATION: implement ONLY add(a, b). Do NOT implement subtract yet — it is reserved for the next iteration.',
  'In your report: the TASK section must restate the full GOAL; the ISSUES section must say that subtract(a, b) is still missing so the GOAL is NOT complete; set NEXT_ACTION: CONTINUE.',
].join('\n');
const SINGLE_TASK = 'Create a file hello.txt in the project root containing exactly one line: Hello from AI Bridge desktop. Do nothing else.';
const LONG_TASK = [
  'Create a folder notes/ with 8 separate markdown files, notes/01.md through notes/08.md.',
  'Each file must contain a heading and a thoughtful 300-word essay on a different software-engineering topic of your choice.',
  'Write the files one at a time and re-read each one after writing it.',
].join('\n');

interface Snap {
  project: { path: string } | null;
  status: {
    runId: string | null;
    status: string;
    iteration: number;
    maxIterations: number | null;
    currentPhase: string | null;
    claude: { pid: number | null };
    codex: { pid: number | null };
  } | null;
  recovery: { kind: string; strategy?: string; runId?: string };
  controls: { canStart: boolean; canPause: boolean; canResume: boolean; stopMode: string | null };
  pendingAction: string | null;
  runAttached: boolean;
  lastError: { code: string; title: string; details?: string } | null;
}

async function snapshot(page: CdpPage): Promise<Snap> {
  const res = await page.eval<{ ok: boolean; data: Snap }>('window.aiBridge.getSnapshot()');
  return res.data;
}

async function startViaUi(page: CdpPage, task: string, maxIterations: number): Promise<void> {
  await waitFor('START enabled in the UI', () => page.eval<boolean | null>(ui.disabled('btn-start')), (d) => d === false, 20_000, 200);
  await page.eval(ui.click('btn-start'));
  await waitFor('start dialog', () => page.eval<boolean>(`!!document.querySelector('[data-testid="start-task"]')`), (v) => v, 5000, 100);
  await sleep(500); // the dialog loads the project's config (default max iterations)
  await page.eval(ui.type('start-task', task));
  await page.eval(ui.type('start-max', String(maxIterations)));
  await sleep(200);
  await page.eval(ui.click('start-submit'));
}

async function processTree(rootPid: number): Promise<{ pid: number; name: string }[]> {
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const all = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; Name: string }[];
  const out: { pid: number; name: string }[] = [];
  const walk = (pid: number) => {
    for (const p of all.filter((x) => x.ParentProcessId === pid)) {
      out.push({ pid: p.ProcessId, name: p.Name });
      walk(p.ProcessId);
    }
  };
  const root = all.find((p) => p.ProcessId === rootPid);
  if (root) out.push({ pid: root.ProcessId, name: root.Name });
  walk(rootPid);
  return out;
}

async function sessionFile(runId: string, name: string): Promise<string> {
  return readFile(path.join(projectPath, '.ai-bridge', 'sessions', runId, name), 'utf8');
}

const result: Record<string, unknown> = { scenario, projectPath, exe: exe ?? 'dev electron', startedAt: new Date().toISOString() };
const checks: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ check: name, ok, detail });
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail));
};

async function withApp<T>(env: Record<string, string>, port: number, fn: (page: CdpPage) => Promise<T>): Promise<T> {
  const app = await launchApp({ userDataDir, defaultProjectPath: projectPath, port, env, exe });
  const page = await CdpPage.connect(port);
  page.autoAcceptDialogs();
  try {
    await waitFor('project loaded', () => snapshot(page), (s) => s.project !== null, 20_000, 300);
    return await fn(page);
  } finally {
    page.close();
    await closeApp(app);
  }
}

const TEN_MIN = 10 * 60_000;
const finished = (s: Snap) => !s.runAttached && s.pendingAction === null && s.status?.status !== 'RUNNING';

try {
  await mkdir(shotsDir, { recursive: true });
  const port = 9800 + Math.floor(Math.random() * 100);

  if (scenario === 'normal' || scenario === 'multi') {
    await withApp({}, port, async (page) => {
      await startViaUi(page, scenario === 'normal' ? SINGLE_TASK : TWO_PART_TASK, 3);
      const running = await waitFor('RUNNING', () => snapshot(page), (s) => s.status?.status === 'RUNNING', 120_000, 500);
      check('UI START → Core RUNNING', true, { runId: running.status?.runId, phase: running.status?.currentPhase });
      await sleep(3000);
      await page.screenshot(path.join(shotsDir, 'running.png'));
      const done = await waitFor('run end', () => snapshot(page), finished, TEN_MIN, 2000);
      await sleep(1500);
      await page.screenshot(path.join(shotsDir, 'done.png'));
      result.final = done.status;
      check('run reached DONE', done.status?.status === 'DONE', done.status?.status);
      if (scenario === 'multi') check('at least 2 real iterations (Claude→Codex→Claude)', (done.status?.iteration ?? 0) >= 2, done.status?.iteration);
      const events = await page.eval<{ ok: boolean; data: { event: string; runId: string }[] }>('window.aiBridge.getRecentEvents({ limit: 500 })');
      const own = events.data.filter((e) => e.runId === done.status?.runId).map((e) => e.event);
      check('event stream shows the full chain', ['RUN_STARTED', 'CLAUDE_STARTED', 'REPORT_VALIDATED', 'CODEX_STARTED', 'RESPONSE_PARSED', 'RUN_COMPLETED'].every((e) => own.includes(e)), own);
      const rows = await page.eval<number>(`document.querySelectorAll('[data-testid="activity-row"]').length`);
      check('activity log rendered live events', rows > 0, rows);
      if ((done.status?.iteration ?? 0) >= 2) {
        const runId = done.status!.runId!;
        const extracted = await sessionFile(runId, '001-extracted-prompt.md');
        const sent = await sessionFile(runId, '002-claude-prompt.md');
        check('iteration-2 prompt is byte-identical to Codex PROMPT', sha(extracted) === sha(sent), sha(sent));
      }
    });
  } else if (scenario === 'pause') {
    await withApp({}, port, async (page) => {
      await startViaUi(page, TWO_PART_TASK, 3);
      // PAUSE becomes available once Core reports iteration >= 1 (a resumable boundary).
      await waitFor('PAUSE enabled', () => page.eval<boolean | null>(ui.disabled('btn-pause')), (d) => d === false, 120_000, 200);
      await page.eval(ui.click('btn-pause'));
      log('PAUSE clicked while', (await snapshot(page)).status?.currentPhase);
      await sleep(1000);
      await page.screenshot(path.join(shotsDir, 'pause-requested.png'));
      const paused = await waitFor('PAUSED', () => snapshot(page), (s) => finished(s), TEN_MIN, 2000);
      check('Core reached PAUSED at a safe boundary', paused.status?.status === 'PAUSED', { status: paused.status?.status, iteration: paused.status?.iteration });
      check('RESUME offered only because Core says RECOVERABLE', paused.recovery.kind === 'RECOVERABLE' && paused.controls.canResume, paused.recovery);
      await sleep(800);
      await page.screenshot(path.join(shotsDir, 'paused.png'));
      const runId = paused.status!.runId!;
      const extractedBefore = await sessionFile(runId, `${String(paused.status!.iteration).padStart(3, '0')}-extracted-prompt.md`);
      await page.eval(ui.click('btn-resume'));
      const done = await waitFor('run end after resume', () => snapshot(page), (s) => finished(s) && s.status?.status !== 'PAUSED', TEN_MIN, 2000);
      await sleep(1500);
      await page.screenshot(path.join(shotsDir, 'resumed-done.png'));
      result.final = done.status;
      check('resumed run finished DONE', done.status?.status === 'DONE', done.status?.status);
      const nextN = String(paused.status!.iteration + 1).padStart(3, '0');
      const sentAfter = await sessionFile(runId, `${nextN}-claude-prompt.md`);
      check('prompt after resume == prompt persisted before pause (SHA-256)', sha(sentAfter) === sha(extractedBefore), sha(sentAfter));
    });
  } else if (scenario === 'recovery') {
    let runId = '';
    let promptHash = '';
    await withApp({ AI_BRIDGE_CRASH_AT: 'AFTER_PROMPT_PERSISTED' }, port, async (page) => {
      await startViaUi(page, TWO_PART_TASK, 3);
      const crashed = await waitFor('Core crash', () => snapshot(page), (s) => finished(s) && s.status?.status !== 'NOT_STARTED' && s.status?.runId !== null, TEN_MIN, 2000);
      await sleep(1000);
      await page.screenshot(path.join(shotsDir, 'crashed.png'));
      runId = crashed.status!.runId!;
      check('Core process crashed for real (exit 137) and the UI reported it', crashed.lastError?.code === 'CORE_PROCESS_EXITED' && /137/.test(crashed.lastError.details ?? ''), crashed.lastError);
      check('state is INTERRUPTED + RECOVERABLE', crashed.status?.status === 'INTERRUPTED' && crashed.recovery.kind === 'RECOVERABLE', { status: crashed.status?.status, recovery: crashed.recovery });
      const integrity = JSON.parse(await sessionFile(runId, '001-integrity.json')) as { promptHash: string };
      promptHash = integrity.promptHash;
      check('pre-crash prompt on disk matches integrity promptHash', sha(await sessionFile(runId, '001-extracted-prompt.md')) === promptHash, promptHash);
    });
    log('Electron app closed (simulated app restart) — relaunching without crash injection');
    await withApp({}, port + 1, async (page) => {
      await sleep(1500);
      const reopened = await snapshot(page);
      const bannerText = await page.eval<string | null>(ui.text('recovery-banner'));
      await page.screenshot(path.join(shotsDir, 'restart-recovery-banner.png'));
      check('after restart: recovery banner shows the unfinished session as RECOVERABLE', reopened.recovery.kind === 'RECOVERABLE' && (bannerText ?? '').includes(runId), bannerText);
      check('nothing resumed automatically', reopened.status?.status === 'INTERRUPTED' && !reopened.runAttached, reopened.status?.status);
      await page.eval(ui.click('banner-resume'));
      const done = await waitFor('run end after recovery', () => snapshot(page), (s) => finished(s) && s.status?.status !== 'INTERRUPTED', TEN_MIN, 2000);
      await sleep(1500);
      await page.screenshot(path.join(shotsDir, 'recovered-done.png'));
      result.final = done.status;
      check('recovered run finished DONE in the same session', done.status?.status === 'DONE' && done.status.runId === runId, { status: done.status?.status, runId: done.status?.runId });
      check('prompt sent after recovery == pre-crash promptHash (SHA-256)', sha(await sessionFile(runId, '002-claude-prompt.md')) === promptHash, promptHash);
    });
  } else if (scenario === 'stop') {
    await withApp({}, port, async (page) => {
      await startViaUi(page, LONG_TASK, 2);
      const executing = await waitFor('Claude executing', () => snapshot(page), (s) => s.status?.status === 'RUNNING' && s.status.claude.pid !== null, 120_000, 500);
      await sleep(8000); // let Claude get properly underway
      const lock = JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), 'utf8')) as { pid: number };
      const tree = await processTree(lock.pid);
      result.treeBeforeStop = tree;
      check('live process tree before STOP: run host → Claude', tree.length >= 2 && tree.some((p) => p.pid === executing.status!.claude.pid), tree);
      await page.screenshot(path.join(shotsDir, 'before-stop.png'));
      await page.eval(ui.click('btn-stop'));
      const stopped = await waitFor('STOPPED', () => snapshot(page), finished, 120_000, 1000);
      await sleep(1500);
      await page.screenshot(path.join(shotsDir, 'stopped.png'));
      result.final = stopped.status;
      check('session recorded as STOPPED (not a crash, not resumable)', stopped.status?.status === 'STOPPED' && stopped.recovery.kind === 'NONE' && stopped.lastError === null, {
        status: stopped.status?.status,
        recovery: stopped.recovery,
        lastError: stopped.lastError,
      });
      await sleep(3000);
      const survivors = tree.filter((p) => isPidAlive(p.pid));
      check('every process in the run tree is gone — no orphan', survivors.length === 0, survivors);
      const lockLeft = await readFile(path.join(projectPath, '.ai-bridge', 'state', 'lock'), 'utf8').then(
        () => true,
        () => false,
      );
      check('run lock released', !lockLeft);
    });
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
} catch (err) {
  check('scenario completed without harness error', false, err instanceof Error ? err.message : String(err));
} finally {
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}

result.checks = checks;
result.finishedAt = new Date().toISOString();
await writeFile(path.join(shotsDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
const failed = checks.filter((c) => !c.ok).length;
log(`${scenario}: ${checks.length - failed}/${checks.length} checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
