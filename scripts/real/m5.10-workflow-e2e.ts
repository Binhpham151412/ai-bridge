#!/usr/bin/env node
// M5.10 — REAL end-to-end validation of the M5 workflow stack (docs/39 M5.10).
//
//   real renderer UI (CDP clicks) → preload → IPC → Electron Main (WorkflowController)
//   → Workflow Host (workflow-host.mjs) → Execution Host (run-host.mjs, 'independent')
//   → BridgeEngine → real `claude` CLI → report → real `codex` CLI → verdict
//
// Consumes real Claude/Codex subscription quota (except `preflight`). NEVER run by `pnpm test`.
// Every scenario gets its own fresh disposable project under sandbox/m5.10-<scenario>/.
//
// Test-harness rules (M5.8.1 lessons):
//  - process identity = (pid, CreationDate) from Win32_Process, so a recycled pid is never
//    mistaken for a process we saw earlier;
//  - a deliberate crash kills exactly ONE verified process (process.kill → TerminateProcess),
//    never a tree (`taskkill /T`);
//  - nothing polls BridgeEngine state faster than every 1000 ms; process sampling ≥ 1000 ms;
//  - the app is closed through its own window close, never by killing its tree.
//
// Usage: node scripts/real/m5.10-workflow-e2e.ts <definitions|preflight|A|B|C|D|E|F|G|J1|J1-zero|J2|J4> [--exe <packaged exe> | --app <crash app dir>]
//   definitions  zero quota, no app: validates the test definitions and checks their dry-run task text
//   preflight    zero quota: the real app up to the real preflight (+ the 1080×700 layout audit); on
//                the production app (no --app) it also arms the TEST-ONLY crash configuration and
//                proves it inert (no marker, no status line, the chain forks normally)
//   A … G, J4    real providers (quota) — run only after `claude auth status` reports loggedIn: true
//   J1, J2       real providers (quota), ONLY on the isolated crash app (--app sandbox/m5.10-crash-app,
//                built by scripts/real/m5.10-crash/build-crash-app.ts; B″, docs/59 §23): the Workflow
//                Host self-exits (137) at a TEST-ONLY crash point, a real RESUME recovers
//   J1-zero      zero quota, crash app, Claude NOT authenticated: J1's crash + recovery through the
//                production ≈ 5 min preflight grace; the relaunch is then refused by the real preflight
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { BridgeEngine } from '../../src/core/bridge-engine.ts';
import { extractSection } from '../../src/core/journal/journal.ts';
import { dryRunWorkflow } from '../../src/core/workflow/dry-run.ts';
import { reconcileAttempt, type ReconcileFacts, type ReconcileSession } from '../../src/core/workflow/reconciler.ts';
import { outputFromReport } from '../../src/core/workflow/step-planner.ts';
import { WorkflowStore } from '../../src/core/workflow/store.ts';
import type { WorkflowAttempt } from '../../src/core/workflow/types.ts';
import { loadWorkflowDefinition } from '../../src/hosts/workflow-read.ts';
import { CdpPage, DEV_ELECTRON, launchApp, ROOT, ui } from '../desktop/cdp.ts';
import { APP_MARKER, verifyCrashApp } from './m5.10-crash/build-crash-app.ts';
import { CRASH_ENV, MARKER_ENV, type CrashPoint } from './m5.10-crash/crash-config.ts';

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

// The app must see the environment a user-launched app sees — not the variables of the
// Claude desktop session this driver may itself run in (they would leak into the CLIs).
for (const key of Object.keys(process.env)) if (/^(CLAUDE|CLAUDECODE|ANTHROPIC|CODEX_COMPANION)/i.test(key)) delete process.env[key];

const SCENARIOS = ['definitions', 'preflight', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'J1', 'J1-zero', 'J2', 'J4'] as const;
type Scenario = (typeof SCENARIOS)[number];
const scenario = process.argv[2] as Scenario;
const exeIndex = process.argv.indexOf('--exe');
const exe = exeIndex !== -1 ? path.resolve(process.argv[exeIndex + 1]) : undefined;
const appIndex = process.argv.indexOf('--app');
const appDir = appIndex !== -1 ? path.resolve(process.argv[appIndex + 1]) : undefined;
if (!SCENARIOS.includes(scenario) || (exe && appDir)) {
  console.error(`Usage: m5.10-workflow-e2e.ts <${SCENARIOS.join('|')}> [--exe <packaged exe> | --app <crash app dir>]`);
  process.exit(1);
}
/** The TEST-ONLY crash point each J scenario arms (read only by the crash app's workflow-host.mjs). */
const CRASH_SCENARIOS: Partial<Record<Scenario, CrashPoint>> = { J1: 'BEFORE_EXECUTION_HOST_FORK', 'J1-zero': 'BEFORE_EXECUTION_HOST_FORK', J2: 'ON_RUN_STARTED_BEFORE_LINK' };
/** Zero-quota scenarios rely on the real preflight REFUSING (Claude not authenticated). */
const ZERO_QUOTA: readonly Scenario[] = ['preflight', 'J1-zero'];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const projectPath = path.join(ROOT, 'sandbox', `m5.10-${scenario}`);
const aiBridgeDir = path.join(projectPath, '.ai-bridge');
const resultsDir = path.join(ROOT, 'sandbox', 'm5.10-results', `${scenario}-${stamp}`);
const userDataDir = path.join(tmpdir(), `ai-bridge-m5.10-${scenario}-${Date.now()}`);
const MARKER = '.m5.10-sandbox';
let port = 9400 + Math.floor(Math.random() * 400);
/** The one-shot crash marker (crash-config.ts MARKER_NAME_PATTERN) — in this run's results dir. */
const crashMarker = path.join(resultsDir, `m510-crash-${scenario.toLowerCase()}.marker`);
/** Extra environment of the app processes this run launches (the TEST-ONLY crash configuration). */
let appEnv: Record<string, string> = {};

const logLines: string[] = [];
const log = (...a: unknown[]) => {
  const line = `${new Date().toISOString().slice(11, 23)} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  logLines.push(line);
  console.log(line);
};
const checks: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ check: name, ok, detail });
  log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : detail);
  return ok;
};
const result: Record<string, unknown> = { scenario, projectPath, exe: exe ?? (appDir ? `dev electron + crash app ${path.relative(ROOT, appDir)} (TEST-ONLY)` : 'dev electron + dist-desktop (pnpm build)'), startedAt: nowIso() };

// ---------------------------------------------------------------------------
// workflow definitions (tiny, harmless, deterministic tasks — M5.10 §6)
// ---------------------------------------------------------------------------

const step = (id: string, title: string, instruction: string, maxIterations: number) => ({
  id,
  title,
  instruction,
  executor: { role: 'executor', maxIterations },
  verification: { checks: [], acceptAiOnly: true },
  retry: { maxAttempts: 1 },
});
const ONLY_THIS_FILE = 'Do not create, modify or delete any other file. Do not run any shell command. Keep the report short.';

// Deterministic artifacts the driver checks after the run (content compared after CRLF → LF and
// trimming one trailing newline). They live only inside the disposable sandbox project.
const A_ARTIFACT = { path: 'notes/a.txt', content: 'm5.10-ok' };
const B_STEP1 = { path: 'notes/step1.txt', content: 'alpha-token' };                   // "alpha" = first word of fixtures/sample.txt
const B_STEP2 = { path: 'notes/step2.txt', content: `from step 1: ${B_STEP1.content}` };
const C_PAUSED = { path: 'notes/pause.txt', content: 'part one' };
const C_DONE = { path: 'notes/pause.txt', content: 'part one\npart two' };

const DEFINITIONS: Record<string, unknown> = {
  // A (and D/E/F/G/J4): creates one tiny artifact.
  'm510-minimal': {
    schema: 1,
    id: 'm510-minimal',
    version: 2,
    title: 'M5.10 minimal',
    steps: [step('write-marker', 'Write marker file', `Create the file ${A_ARTIFACT.path} containing exactly one line: ${A_ARTIFACT.content}\n${ONLY_THIS_FILE}`, 2)],
  },
  // B: step 2 depends on step 1 twice over — (1) through AI Bridge: step 1 declares the output
  // report.summary and step 2's instruction references it, so the step-planner inserts step 1's
  // real report summary into step 2's task text as a labelled STEP OUTPUT block; (2) through the
  // workspace: step 2 must copy the content of the file step 1 created (the token is derived by
  // step 1 from the fixture; step 2's own instruction never names the fixture or the token).
  'm510-two-step': {
    schema: 1,
    id: 'm510-two-step',
    version: 2,
    title: 'M5.10 two-step (dependent)',
    steps: [
      {
        ...step(
          'write-token',
          'Write token file',
          `Read the file fixtures/sample.txt. Create the file ${B_STEP1.path} containing exactly one line: the first word of fixtures/sample.txt followed by "-token" (no spaces). In the SUMMARY section of your report, state the exact content you wrote to ${B_STEP1.path}.\n${ONLY_THIS_FILE}`,
          2,
        ),
        outputs: ['report.summary'],
      },
      step(
        'copy-token',
        'Copy token from step 1',
        `The previous workflow step created the file ${B_STEP1.path}. Its report summary is:\n{{steps.write-token.outputs.report.summary}}\nRead ${B_STEP1.path} and create the file ${B_STEP2.path} containing exactly one line: "from step 1: " followed by the exact content of ${B_STEP1.path}.\n${ONLY_THIS_FILE}`,
        2,
      ),
    ],
  },
  // The reviewer only sees the report, so the report itself must state the unfinished goal —
  // otherwise real Codex (correctly) judges iteration 1 DONE and no iteration boundary exists
  // for a pause to land on (the M4 two-part pattern, scripts/desktop/real-e2e.ts).
  'm510-pause': {
    schema: 1,
    id: 'm510-pause',
    version: 1,
    title: 'M5.10 pause/resume',
    steps: [
      step(
        'two-part',
        'Two-part note',
        [
          'GOAL: the file notes/pause.txt must contain exactly two lines: "part one" and then "part two". The GOAL is complete only when both lines exist.',
          'CONSTRAINT FOR THIS ITERATION: if notes/pause.txt does not exist yet, create it with ONLY the single line "part one" and do NOT write "part two" — it is reserved for the next iteration. If notes/pause.txt already contains "part one", append the line "part two".',
          'Do not touch any other file. In your report: the TASK section must restate the full GOAL; if part two is still missing, the ISSUES section must say so and set NEXT_ACTION: CONTINUE.',
        ].join('\n'),
        3,
      ),
    ],
  },
};
const SCENARIO_DEFINITION: Record<Scenario, string> = {
  definitions: 'm510-minimal',
  preflight: 'm510-minimal',
  A: 'm510-minimal',
  B: 'm510-two-step',
  C: 'm510-pause',
  D: 'm510-minimal',
  E: 'm510-minimal',
  F: 'm510-minimal',
  G: 'm510-minimal',
  J1: 'm510-minimal',
  'J1-zero': 'm510-minimal',
  J2: 'm510-minimal',
  J4: 'm510-minimal',
};

async function git(args: string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'user.name=m5.10', '-c', 'user.email=m5.10@example.invalid', ...args], { cwd: projectPath, windowsHide: true });
}

async function setupProject(): Promise<void> {
  if (existsSync(projectPath)) {
    if (!existsSync(path.join(projectPath, MARKER))) throw new Error(`${projectPath} exists and was not created by this script — refusing to delete it`);
    await rm(projectPath, { recursive: true, force: true });
  }
  await mkdir(path.join(projectPath, 'fixtures'), { recursive: true });
  await writeFile(path.join(projectPath, MARKER), 'disposable M5.10 E2E sandbox (created by scripts/real/m5.10-workflow-e2e.ts)\n');
  await writeFile(path.join(projectPath, 'README.md'), '# M5.10 E2E sandbox\n\nDisposable target for the M5.10 real workflow E2E.\n');
  await writeFile(path.join(projectPath, 'fixtures', 'sample.txt'), 'alpha\nbravo\ncharlie\n');
  await writeFile(path.join(projectPath, '.gitignore'), `.ai-bridge/\n${MARKER}\n`);
  await execFileAsync('git', ['init', '-q'], { cwd: projectPath, windowsHide: true });
  await git(['add', '-A']);
  await git(['commit', '-qm', 'sandbox baseline']);
  const defs = path.join(aiBridgeDir, 'workflows', 'definitions');
  await mkdir(defs, { recursive: true });
  for (const [id, d] of Object.entries(DEFINITIONS)) await writeFile(path.join(defs, `${id}.json`), `${JSON.stringify(d, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// processes: identity = (pid, CreationDate)
// ---------------------------------------------------------------------------

interface Proc {
  pid: number;
  ppid: number;
  name: string;
  created: string;
  cmd: string;
}
type Role = 'electron-main' | 'electron-helper' | 'workflow-host' | 'execution-host' | 'claude' | 'codex' | 'other';
interface Tracked {
  pid: number;
  created: string;
  ppid: number;
  parentKey: string | null;
  name: string;
  role: Role;
  firstSeenAt: string;
  lastSeenAt: string;
  goneAt: string | null;
}
const keyOf = (p: { pid: number; created: string }) => `${p.pid}@${p.created}`;

const PS_PROCS =
  "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; created=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }); cmd=[string]$_.CommandLine } } | ConvertTo-Json -Compress";

async function procs(): Promise<Proc[]> {
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_PROCS], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return (JSON.parse(stdout) as Proc[]).map((p) => ({ ...p, cmd: p.cmd ?? '' }));
}

function classify(p: Proc): Role {
  const cmd = p.cmd.toLowerCase();
  if (cmd.includes('workflow-host.mjs')) return 'workflow-host';
  if (cmd.includes('run-host.mjs')) return 'execution-host';
  const name = p.name.toLowerCase();
  if (name === 'claude.exe') return 'claude';
  if (name === 'codex.exe') return 'codex';
  if (cmd.includes('--type=')) return 'electron-helper';
  return 'other';
}

/** Follows every process descending from the tracked roots (the Electron Main processes this
 * driver launched), across parents dying (a detached Execution Host outlives its Workflow Host). */
class ProcessMonitor {
  readonly tracked = new Map<string, Tracked>();
  latest: Proc[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sampling: Promise<Proc[]> = Promise.resolve([]);
  #running = false;

  addRoot(p: Proc, role: Role): Tracked {
    const t: Tracked = { pid: p.pid, created: p.created, ppid: p.ppid, parentKey: null, name: p.name, role, firstSeenAt: nowIso(), lastSeenAt: nowIso(), goneAt: null };
    this.tracked.set(keyOf(p), t);
    return t;
  }

  start(): void {
    this.#running = true;
    const loop = () => {
      if (!this.#running) return;
      void this.sample().finally(() => {
        if (this.#running) this.#timer = setTimeout(loop, 1000);
      });
    };
    loop();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
  }

  /** One serialized sample (callers await a fresh view). */
  sample(): Promise<Proc[]> {
    const run = this.#sampling.then(async () => {
      const snap = await procs();
      const at = nowIso();
      const live = new Map(snap.map((p) => [keyOf(p), p]));
      const liveByPid = new Map(snap.map((p) => [p.pid, p]));
      for (const [k, t] of this.tracked) {
        if (live.has(k)) t.lastSeenAt = at;
        else if (t.goneAt === null) t.goneAt = at;
      }
      // Newly seen children of a tracked, currently live parent (iterate to catch grandchildren).
      for (let added = true; added; ) {
        added = false;
        for (const p of snap) {
          const k = keyOf(p);
          if (this.tracked.has(k)) continue;
          const parent = liveByPid.get(p.ppid);
          if (!parent || !this.tracked.has(keyOf(parent)) || parent.created > p.created) continue;
          this.tracked.set(k, { pid: p.pid, created: p.created, ppid: p.ppid, parentKey: keyOf(parent), name: p.name, role: classify(p), firstSeenAt: at, lastSeenAt: at, goneAt: null });
          added = true;
        }
      }
      this.latest = snap;
      return snap;
    });
    this.#sampling = run.catch(() => []);
    return run;
  }

  alive(t: { pid: number; created: string }): boolean {
    return this.latest.some((p) => p.pid === t.pid && p.created === t.created);
  }

  byRole(role: Role): Tracked[] {
    return [...this.tracked.values()].filter((t) => t.role === role);
  }

  childrenOf(parent: Tracked, role?: Role): Tracked[] {
    const pk = keyOf(parent);
    return [...this.tracked.values()].filter((t) => t.parentKey === pk && (role === undefined || t.role === role));
  }

  summary(): Record<string, unknown>[] {
    return [...this.tracked.values()].map((t) => ({ role: t.role, name: t.name, pid: t.pid, created: t.created, parentPid: t.ppid, firstSeenAt: t.firstSeenAt, goneAt: t.goneAt }));
  }
}

const monitor = new ProcessMonitor();

/** Kills exactly one process, after re-verifying its identity (never a tree, never a recycled pid). */
async function killOnly(t: Tracked, what: string): Promise<string> {
  const snap = await monitor.sample();
  const live = snap.find((p) => p.pid === t.pid);
  if (!live || live.created !== t.created) throw new Error(`refusing to kill ${what}: pid ${t.pid} is not the process first seen at ${t.created}`);
  process.kill(t.pid);
  const at = nowIso();
  log(`KILLED ${what} pid ${t.pid} (created ${t.created}) at ${at}`);
  return at;
}

async function waitUntil<T>(what: string, poll: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, intervalMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await poll();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)?.slice(0, 600)}`);
    await sleep(Math.max(intervalMs, 200));
  }
}

// ---------------------------------------------------------------------------
// the app (real Electron) and its renderer
// ---------------------------------------------------------------------------

interface App {
  child: ChildProcess;
  main: Tracked;
  page: CdpPage;
  dialogs: { type: string; message: string; at: string }[];
  exit: Promise<{ code: number | null; signal: string | null; at: string }>;
}

/** The isolated crash app on the dev Electron (D2): launchApp's launch with the crash app's directory
 * as the app path instead of the repo root. */
async function launchCrashApp(dir: string): Promise<ChildProcess> {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(path.join(userDataDir, 'settings.json'), JSON.stringify({ defaultProjectPath: projectPath }), 'utf8');
  return spawn(DEV_ELECTRON, [dir, `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], { env: { ...process.env, ...appEnv }, stdio: 'ignore' });
}

async function launch(label: string): Promise<App> {
  port += 1;
  const child = appDir ? await launchCrashApp(appDir) : await launchApp({ userDataDir, defaultProjectPath: projectPath, port, exe, env: appEnv });
  const exit = new Promise<{ code: number | null; signal: string | null; at: string }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, at: nowIso() })));
  if (child.pid === undefined) throw new Error('Electron did not start');
  const snap = await waitUntil('Electron main in the process table', () => procs(), (s) => s.some((p) => p.pid === child.pid), 20_000, 500);
  const main = monitor.addRoot(snap.find((p) => p.pid === child.pid)!, 'electron-main');
  log(`launched app (${label}): Electron Main pid ${main.pid} (created ${main.created})`);
  const page = await CdpPage.connect(port, 60_000);
  const dialogs: App['dialogs'] = [];
  // window.confirm in the renderer (STOP confirmation): recorded here, answered by a real click on
  // Electron's native dialog (clickAndConfirm). Accepting it through CDP instead resolves the JS
  // call but leaves Electron's native box up (observed), which blocks a later window close.
  page.on('Page.javascriptDialogOpening', (params) => {
    dialogs.push({ type: String(params.type), message: String(params.message), at: nowIso() });
  });
  await waitUntil('project loaded in the app', () => panel(page), (p) => p?.project !== null && p?.project !== undefined, 30_000);
  await waitUntil('navigation rendered', () => page.eval<boolean>(`!!document.querySelector('[data-testid="nav-workflows"]')`), (v) => v, 30_000, 250);
  await page.eval(ui.click('nav-workflows'));
  await waitUntil('Workflows view', () => page.eval<boolean>(`!!document.querySelector('[data-testid="workflow-view"]')`), (v) => v, 15_000, 250);
  // H: every scenario drives the UI at the M5.9 target size 1080×700 (renderer viewport).
  await emulateTargetViewport(page);
  return { child, main, page, dialogs, exit };
}

interface PanelSnap {
  project: { path: string } | null;
  workflow: WfSnap | null;
  activity: { hostPid: number | null; hostedWorkflowId: string | null; running: string[] };
  canStartNew: boolean;
  startBlockedBy: { code: string; message: string } | null;
  attached: boolean;
  pendingAction: string | null;
  lastError: { code: string; title: string; message: string } | null;
}
interface WfSnap {
  workflowId: string;
  definitionId: string;
  definitionHash: string;
  state: string;
  displayState: string;
  terminalReason: string | null;
  evidenceLevel: string | null;
  pauseRequested: boolean;
  stopRequested: string | null;
  host: { alive: boolean; pid: number | null };
  steps: { stepId: string; state: string; attempts: number; current: { attemptId: string; state: string; executionId: string | null; iterationsUsed: number; outcome: { kind: string; finalStatus: string | null } | null } | null }[];
  recovery: { kind: string; finding: string | null; executionId: string | null; reason: string | null }[];
  controls: { canStart: boolean; canPause: boolean; canResume: boolean; canStop: boolean };
  lastEventSeq: number;
  execution: { runId: string | null; status: string; iteration: number; claude: { pid: number | null }; codex: { pid: number | null } } | null;
}

async function panel(page: CdpPage): Promise<PanelSnap | null> {
  const res = await page.eval<{ ok: boolean; data: PanelSnap }>('window.aiBridge.workflowGetSnapshot()');
  return res.ok ? res.data : null;
}

async function wf(page: CdpPage): Promise<WfSnap | null> {
  return (await panel(page))?.workflow ?? null;
}

interface WfEvent {
  seq: number;
  type: string;
  timestamp: string;
  actor: string;
  stepId: string | null;
  attemptId: string | null;
  executionId: string | null;
  payload: Record<string, unknown>;
}

async function events(page: CdpPage, workflowId: string): Promise<WfEvent[]> {
  const res = await page.eval<{ ok: boolean; data: WfEvent[] }>(`window.aiBridge.workflowGetEvents({ workflowId: ${JSON.stringify(workflowId)}, afterSeq: 0, limit: 1000 })`);
  if (!res.ok) throw new Error('workflowGetEvents failed');
  return res.data;
}

async function attemptView(page: CdpPage, attemptId: string): Promise<{ attempt: Record<string, unknown> } | null> {
  const res = await page.eval<{ ok: boolean; data: { attempt: Record<string, unknown> } }>(`window.aiBridge.workflowGetAttempt({ attemptId: ${JSON.stringify(attemptId)} })`);
  return res.ok ? res.data : null;
}

const selectValue = (testId: string, value: string) =>
  `(() => { const el = document.querySelector('[data-testid="${testId}"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`;

async function shot(app: App, name: string): Promise<void> {
  try {
    await app.page.screenshot(path.join(resultsDir, `${name}.png`));
  } catch (err) {
    log(`screenshot ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// H — layout audit at 1080×700 (the M5.9 target size; measurements only, no UI change)
// ---------------------------------------------------------------------------

const VIEW_W = 1080;
const VIEW_H = 700;

/** The renderer viewport is set to exactly 1080×700 CSS px for the whole scenario. */
async function emulateTargetViewport(page: CdpPage): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
}

interface Box {
  visible: boolean;
  topmost: boolean;
  withinX: boolean;
  withinY: boolean;
  rect: number[];
}
interface LayoutProbe {
  viewport: [number, number];
  page: { scrollW: number; clientW: number; scrollH: number; clientH: number };
  content: { scrollW: number; clientW: number; scrollH: number; clientH: number } | null;
  offenders: string[];
  offenderCount: number;
  focus: Record<string, Box | null>;
}

/** Measures the page as rendered. The shell pins html/body/#root to 100 % height and lets only
 * `.content` scroll (styles.css), so: the document must not scroll at all, `.content` may scroll
 * vertically but not horizontally, and no element may stick out of the viewport unless an
 * ancestor scroller inside the viewport clips it. `topmost` = elementFromPoint hits the element
 * (it is not covered by an overlay). */
const layoutProbe = (focus: string[]) => `(() => {
  const vw = innerWidth, vh = innerHeight, se = document.scrollingElement, content = document.querySelector('.content');
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    let topmost = false;
    if (visible) {
      const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), y = Math.min(Math.max(r.top + Math.min(r.height / 2, 10), 0), vh - 1);
      const hit = document.elementFromPoint(x, y);
      topmost = !!hit && (hit === el || el.contains(hit));
    }
    return { visible, topmost, withinX: r.left >= -0.5 && r.right <= vw + 0.5, withinY: r.top >= -0.5 && r.bottom <= vh + 0.5, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] };
  };
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) { const pr = p.getBoundingClientRect(); if (pr.left >= -1 && pr.right <= vw + 1) return true; }
    }
    return false;
  };
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) offenders.push((el.dataset && el.dataset.testid) || el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 30));
  }
  const focus = {};
  for (const id of ${JSON.stringify(focus)}) focus[id] = box(document.querySelector('[data-testid="' + id + '"]'));
  return {
    viewport: [vw, vh],
    page: { scrollW: se.scrollWidth, clientW: se.clientWidth, scrollH: se.scrollHeight, clientH: se.clientHeight },
    content: content ? { scrollW: content.scrollWidth, clientW: content.clientWidth, scrollH: content.scrollHeight, clientH: content.clientHeight } : null,
    offenders: offenders.slice(0, 15), offenderCount: offenders.length, focus,
  };
})()`;

const shown = (b: Box | null | undefined): boolean => !!b && b.visible && b.withinX && b.withinY && b.topmost;
const pageFits = (m: LayoutProbe) => m.page.scrollH <= m.page.clientH + 1 && m.page.scrollW <= m.page.clientW + 1;
const noHorizontalOverflow = (m: LayoutProbe) => m.content !== null && m.content.scrollW <= m.content.clientW + 1 && m.offenderCount === 0;
const scrollContentTop = `(document.querySelector('.content')?.scrollTo(0, 0), true)`;
const scrollIntoView = (testId: string) => `(document.querySelector('[data-testid="${testId}"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), true)`;

interface LayoutExpect {
  list?: boolean;
  detail?: boolean;
  /** The display-state label expected in the detail header (e.g. "Blocked", "Interrupted"). */
  state?: string;
  controls?: boolean;
  journal?: boolean;
  interrupted?: boolean;
  recovery?: boolean;
}

/** Scrolls the content pane to the top and waits until it STAYS there. Closing a native dialog (the
 * STOP confirm) hands focus back to the renderer asynchronously, and the browser then scrolls the
 * re-focused button into view — a measurement taken before that settles is not the layout at rest. */
async function settleContentTop(page: CdpPage): Promise<{ rounds: number; lateScrollTops: number[]; activeElement: string | null }> {
  const lateScrollTops: number[] = [];
  let stable = 0;
  let rounds = 0;
  while (stable < 2 && rounds < 20) {
    rounds += 1;
    await page.eval(scrollContentTop);
    await sleep(250);
    const st = await page.eval<number | null>(`document.querySelector('.content')?.scrollTop ?? null`);
    if (st === null || st === 0) stable += 1;
    else {
      stable = 0;
      lateScrollTops.push(st);
    }
  }
  const activeElement = await page.eval<string | null>(`(() => { const a = document.activeElement; return a ? (a.getAttribute('data-testid') ?? a.tagName) : null; })()`);
  return { rounds, lateScrollTops, activeElement };
}

async function layoutAudit(app: App, label: string, expect: LayoutExpect): Promise<Record<string, unknown>> {
  const page = app.page;
  const pre = `[H ${label} @${VIEW_W}×${VIEW_H}]`;
  await emulateTargetViewport(page);
  const settle = await settleContentTop(page); // the assertions below are on measurements
  if (settle.lateScrollTops.length > 0) log(`${pre} the content pane scrolled after the reset (focus restoration): ${JSON.stringify(settle)}`);
  const ids = ['nav-workflows', 'workflow-view', 'wf-list', 'wf-detail', 'wf-display-state', 'wf-headline', 'wf-controls', 'wf-interrupted', 'wf-recovery', 'wf-tab-journal'];
  const top = await page.eval<LayoutProbe>(layoutProbe(ids));
  await shot(app, `${label}-${VIEW_W}x${VIEW_H}`);
  const out: Record<string, unknown> = { label, viewport: top.viewport, page: top.page, content: top.content, offenders: top.offenders, settle };
  check(`${pre} viewport is exactly ${VIEW_W}×${VIEW_H}`, top.viewport[0] === VIEW_W && top.viewport[1] === VIEW_H, top.viewport);
  check(`${pre} no page-level scrolling (the document fits the viewport)`, pageFits(top), top.page);
  check(`${pre} no horizontal overflow (content pane and every element)`, noHorizontalOverflow(top), { content: top.content, offenders: top.offenders });
  check(`${pre} workflow navigation visible`, shown(top.focus['nav-workflows']), top.focus['nav-workflows']);
  if (expect.list) check(`${pre} workflow list visible`, !!top.focus['wf-list']?.visible && !!top.focus['wf-list']?.withinX, top.focus['wf-list']);
  if (expect.detail) check(`${pre} workflow detail visible (header + state)`, !!top.focus['wf-detail']?.visible && !!top.focus['wf-detail']?.withinX && shown(top.focus['wf-display-state']), { detail: top.focus['wf-detail'], state: top.focus['wf-display-state'] });
  if (expect.state) {
    const text = await page.eval<string | null>(ui.text('wf-display-state'));
    check(`${pre} state rendered as "${expect.state}"`, text === expect.state, text);
  }
  if (expect.interrupted) check(`${pre} INTERRUPTED (recovery) banner rendered`, !!top.focus['wf-interrupted']?.visible && !!top.focus['wf-interrupted']?.withinX, top.focus['wf-interrupted']);
  if (expect.controls) {
    const btns = ['wf-btn-pause', 'wf-btn-resume', 'wf-btn-stop'];
    const before = await page.eval<LayoutProbe>(layoutProbe(btns));
    out.controlsAboveFold = btns.every((id) => shown(before.focus[id]));
    await page.eval(scrollIntoView('wf-controls'));
    await sleep(200);
    const after = await page.eval<LayoutProbe>(layoutProbe(btns));
    check(`${pre} workflow controls visible (PAUSE/RESUME/STOP unclipped and not covered)`, btns.every((id) => shown(after.focus[id])), { aboveFoldWithoutScrolling: out.controlsAboveFold, buttons: after.focus });
    await page.eval(scrollContentTop);
  }
  if (expect.recovery) {
    await page.eval(scrollIntoView('wf-recovery'));
    await sleep(200);
    const r = await page.eval<LayoutProbe>(layoutProbe(['wf-recovery', 'wf-adopt-note']));
    const items = await page.eval<number>(`document.querySelectorAll('[data-testid="wf-recovery-item"]').length`);
    check(`${pre} recovery section rendered (items + note, unclipped)`, items > 0 && !!r.focus['wf-recovery']?.visible && !!r.focus['wf-recovery']?.withinX && noHorizontalOverflow(r), { items, recovery: r.focus['wf-recovery'], offenders: r.offenders });
    await page.eval(scrollContentTop);
  }
  if (expect.journal) {
    await page.eval(ui.click('wf-tab-journal'));
    const chars = await waitUntil('journal tab content', () => page.eval<number>(`document.querySelector('[data-testid="wf-journal"]')?.innerText?.length ?? 0`), (n) => n > 200, 15_000, 500);
    await page.eval(scrollIntoView('wf-journal'));
    await sleep(200);
    const j = await page.eval<LayoutProbe>(layoutProbe(['wf-journal']));
    await shot(app, `${label}-journal-${VIEW_W}x${VIEW_H}`);
    check(`${pre} journal accessible (tab renders workflow.md without horizontal overflow)`, chars > 200 && !!j.focus['wf-journal']?.visible && noHorizontalOverflow(j) && pageFits(j), { chars, journal: j.focus['wf-journal'], offenders: j.offenders });
    await page.eval(ui.click('wf-tab-timeline'));
    await page.eval(scrollContentTop);
  }
  out.realMinimumWindow = await realMinimumWindowAudit(app, label);
  await emulateTargetViewport(page);
  return out;
}

/** Additional observation: the REAL window at its minimum size (BrowserWindow minWidth/minHeight
 * 1080×700 are outer bounds, so the page gets slightly less). Requests a smaller size; Electron
 * clamps it to the minimum. Recorded and checked separately from the 1080×700 viewport checks. */
async function realMinimumWindowAudit(app: App, label: string): Promise<Record<string, unknown>> {
  const page = app.page;
  await page.send('Emulation.clearDeviceMetricsOverride');
  const outer = await resizeMainWindow(app.main.pid, 600, 400).catch((err: unknown) => `resize failed: ${err instanceof Error ? err.message : String(err)}`);
  await sleep(600);
  await page.eval(scrollContentTop);
  const m = await page.eval<LayoutProbe>(layoutProbe(['nav-workflows', 'wf-display-state']));
  const pre = `[H ${label} real minimum window, inner ${m.viewport[0]}×${m.viewport[1]}]`;
  check(`${pre} no page-level scrolling`, pageFits(m), m.page);
  check(`${pre} no horizontal overflow`, noHorizontalOverflow(m), { content: m.content, offenders: m.offenders });
  check(`${pre} workflow navigation visible`, shown(m.focus['nav-workflows']), m.focus['nav-workflows']);
  await shot(app, `${label}-real-min-window`);
  return { outer, inner: m.viewport, page: m.page, content: m.content, offenders: m.offenders };
}

/** MoveWindow on Electron Main's main window (the user dragging the window smaller). */
async function resizeMainWindow(pid: number, width: number, height: number): Promise<string> {
  const ps = `
Add-Type -Namespace M510 -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool MoveWindow(System.IntPtr h, int x, int y, int w, int hh, bool repaint); [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }'
$h = (Get-Process -Id ${pid}).MainWindowHandle
[void][M510.Win]::MoveWindow($h, 40, 40, ${width}, ${height}, $true)
Start-Sleep -Milliseconds 300
$r = New-Object M510.Win+RECT
[void][M510.Win]::GetWindowRect($h, [ref]$r)
'{0}x{1}' -f ($r.Right - $r.Left), ($r.Bottom - $r.Top)
`;
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true });
  return `outer ${stdout.trim()} (physical px)`;
}

/** "Artifacts of the run →" from the workflow detail opens the Artifacts view on that execution. */
/** Zero quota: the Artifacts view is reachable from the navigation and fits 1080×700 (with no
 * execution yet it shows its empty state; the per-execution link is artifactsLinkCheck). */
async function artifactsViewAudit(app: App, label: string): Promise<Record<string, unknown>> {
  const pre = `[H ${label} @${VIEW_W}×${VIEW_H}]`;
  await app.page.eval(ui.click('nav-artifacts'));
  const text = await waitUntil('Artifacts view', () => app.page.eval<string>(`document.querySelector('.content')?.innerText ?? ''`), (t) => /Artifacts|session/i.test(t), 15_000, 250);
  await settleContentTop(app.page);
  const m = await app.page.eval<LayoutProbe>(layoutProbe(['nav-artifacts', 'session-select', 'session-facts']));
  await shot(app, `${label}-${VIEW_W}x${VIEW_H}`);
  check(`${pre} Artifacts view reachable from the navigation and rendered`, shown(m.focus['nav-artifacts']) && text.length > 0, { text: text.slice(0, 120), sessionSelect: m.focus['session-select'] ?? null });
  check(`${pre} Artifacts view: no page-level scrolling, no horizontal overflow`, pageFits(m) && noHorizontalOverflow(m), { page: m.page, content: m.content, offenders: m.offenders });
  await app.page.eval(ui.click('nav-workflows'));
  await waitUntil('Workflows view', () => app.page.eval<boolean>(`!!document.querySelector('[data-testid="workflow-view"]')`), (v) => v, 15_000, 250);
  return { label, text: text.slice(0, 200), page: m.page, content: m.content, sessionSelect: m.focus['session-select'] ?? null };
}

async function artifactsLinkCheck(app: App, executionId: string): Promise<void> {
  await app.page.eval(scrollIntoView('wf-open-artifacts'));
  await app.page.eval(ui.click('wf-open-artifacts'));
  const selected = await waitUntil('Artifacts view on the execution', () => app.page.eval<string | null>(`document.querySelector('[data-testid="session-select"]')?.value ?? null`), (v) => v === executionId, 15_000, 500).catch(() => null);
  check(`[H] "Artifacts" link opens the Artifacts view on execution ${executionId}`, selected === executionId, selected);
  await shot(app, 'artifacts-view');
  await app.page.eval(ui.click('nav-workflows'));
  await waitUntil('Workflows view', () => app.page.eval<boolean>(`!!document.querySelector('[data-testid="workflow-view"]')`), (v) => v, 15_000, 250);
}

// ---------------------------------------------------------------------------
// deterministic artifact checks (A, B, C, E, F, J4) — the work product, checked by the driver
// ---------------------------------------------------------------------------

async function readArtifact(rel: string): Promise<{ content: string | null; mtime: string | null }> {
  try {
    const file = path.join(projectPath, rel);
    const content = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n').replace(/\n$/, '');
    return { content, mtime: (await stat(file)).mtime.toISOString() };
  } catch {
    return { content: null, mtime: null };
  }
}

async function gitPorcelain(): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: projectPath, windowsHide: true });
  return stdout.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
}

/** Each expected file has exactly the expected content, and `git status` shows nothing else
 * (the sandbox's .gitignore excludes .ai-bridge/ and the sandbox marker). */
async function artifactChecks(label: string, expected: { path: string; content: string }[]): Promise<Record<string, unknown>> {
  const files: Record<string, unknown>[] = [];
  for (const e of expected) {
    const a = await readArtifact(e.path);
    files.push({ path: e.path, expected: e.content, actual: a.content, sha256: a.content === null ? null : sha256(a.content), mtime: a.mtime });
    check(`${label}: artifact ${e.path} contains exactly ${JSON.stringify(e.content)}`, a.content === e.content, { actual: a.content });
  }
  const status = await gitPorcelain();
  const allowed = new Set(expected.map((e) => `?? ${e.path}`));
  check(`${label}: no other file created or changed in the project (git status)`, status.length === allowed.size && status.every((l) => allowed.has(l)), status);
  return { files, gitStatus: status };
}

/** B: proves Step 1 → output → Step 2 input → Step 2 execution with AI Bridge's own records. */
async function dependencyChecks(ev: Record<string, any>): Promise<Record<string, unknown>> {
  const [a1, a2] = ev.attempts as any[];
  const out: Record<string, unknown> = {};
  if (!a1?.executionId || !a2?.executionId) {
    check('B: both steps have an execution', false, { a1: a1?.executionId, a2: a2?.executionId });
    return out;
  }
  // 1. Step 1's output as the engine computes it: the last validated report of step 1's run,
  //    report.summary = the SUMMARY section (the same functions the engine uses).
  const artifacts = await new BridgeEngine(projectPath).getSessionArtifacts(a1.executionId);
  const report = artifacts?.iterations.map((it) => it.report).filter((r) => r.availability === 'AVAILABLE').at(-1);
  const reportText = report && report.availability === 'AVAILABLE' ? report.text : null;
  const summary = reportText === null ? null : outputFromReport('report.summary', (h) => extractSection(reportText, h));
  // 2. Step 2's input: the task text AI Bridge sent (attempts/<step>-<n>/task.md, exact bytes).
  const taskFile = path.join(aiBridgeDir, 'workflows', 'instances', ev.workflowId, 'attempts', `${a2.stepId}-${a2.attemptNo ?? 1}`, 'task.md');
  const task = await readFile(taskFile, 'utf8').catch(() => null);
  const label = 'write-token report.summary';
  const m = task === null ? null : new RegExp(`--- BEGIN STEP OUTPUT ${label} ---\\n([\\s\\S]*?)\\n--- END STEP OUTPUT ${label} ---`).exec(task);
  const block = m ? m[1] : null;
  out.step1Summary = summary;
  out.step2Block = block;
  out.step2TaskSha256 = task === null ? null : sha256(task);
  check('B: step 2 task.md contains the labelled STEP OUTPUT block of step 1 (report.summary)', block !== null, { taskFile: path.relative(projectPath, taskFile) });
  check("B: the block is step 1's real output, not the UNKNOWN placeholder", block !== null && !block.startsWith('UNKNOWN'), block?.slice(0, 200));
  check("B: the block equals the SUMMARY section of step 1's last validated report", block !== null && summary !== null && block === summary, { summary: summary?.slice(0, 200), block: block?.slice(0, 200) });
  out.summaryMentionsToken = summary?.includes(B_STEP1.content) ?? false; // informational: the step asked for it; the model decides
  // 3. The workspace chain: step 2's file is built from step 1's file, and was written after step 2 started.
  const f1 = await readArtifact(B_STEP1.path);
  const f2 = await readArtifact(B_STEP2.path);
  const run2 = (ev.runs as any[]).find((r) => r.runId === a2.executionId);
  const run2Start = run2 ? Math.min(...run2.calls.map((c: CallRecord) => Date.parse(c.startedAt ?? ''))) : NaN;
  out.files = { step1: f1, step2: f2, step2FirstCliStart: Number.isFinite(run2Start) ? new Date(run2Start).toISOString() : null };
  check("B: step 2's artifact is derived from step 1's artifact", f1.content !== null && f2.content === `from step 1: ${f1.content}`, { step1: f1.content, step2: f2.content });
  check("B: step 1's artifact existed before step 2's first CLI call; step 2's artifact was written after it", f1.mtime !== null && f2.mtime !== null && Number.isFinite(run2Start) && Date.parse(f1.mtime) < run2Start && Date.parse(f2.mtime) > run2Start, out.files);
  return out;
}

/** Start workflow… → pick the definition → START, exactly as a user does. */
async function startViaUi(app: App, definitionId: string, auditDialog = false): Promise<string> {
  await submitStartDialog(app, definitionId, auditDialog);
  const started = (await waitUntil('workflow accepted by the Workflow Host', () => wf(app.page), (w) => w !== null && w.definitionId === definitionId && w.state !== 'CREATED', 60_000))!;
  log(`workflow started: ${started.workflowId} (${started.state})`);
  return started.workflowId;
}

async function submitStartDialog(app: App, definitionId: string, auditDialog: boolean): Promise<void> {
  const page = app.page;
  await waitUntil('"Start workflow…" enabled', () => page.eval<boolean | null>(ui.disabled('wf-start')), (d) => d === false, 30_000, 500);
  await page.eval(ui.click('wf-start'));
  await waitUntil('definitions listed', () => page.eval<string | null>(ui.text('wf-start-hash')), (t) => t !== null, 15_000, 250);
  const chosen = await page.eval<string>(selectValue('wf-start-definition', definitionId));
  await sleep(300);
  const hashText = await page.eval<string | null>(ui.text('wf-start-hash'));
  log(`start dialog: definition ${chosen}, ${hashText}`);
  await shot(app, 'start-dialog');
  if (auditDialog) {
    const d = await page.eval<LayoutProbe>(layoutProbe(['wf-start-dialog', 'wf-start-definition', 'wf-start-submit']));
    check(`[H start dialog @${VIEW_W}×${VIEW_H}] dialog fits the viewport; definition select and START visible`, !!d.focus['wf-start-dialog']?.withinX && !!d.focus['wf-start-dialog']?.withinY && shown(d.focus['wf-start-definition']) && shown(d.focus['wf-start-submit']) && pageFits(d), d.focus);
  }
  await page.eval(ui.click('wf-start-submit'));
}

async function clickWhenEnabled(app: App, testId: string, timeoutMs = 30_000): Promise<string> {
  await waitUntil(`${testId} enabled`, () => app.page.eval<boolean | null>(ui.disabled(testId)), (d) => d === false, timeoutMs, 500);
  await app.page.eval(ui.click(testId));
  const at = nowIso();
  log(`clicked ${testId} at ${at}`);
  return at;
}

/** A control guarded by window.confirm: click it, see the native confirm, click its OK. */
async function clickAndConfirm(app: App, testId: string, messagePrefix: string): Promise<{ clickedAt: string; dialog: NativeDialog }> {
  await waitUntil(`${testId} enabled`, () => app.page.eval<boolean | null>(ui.disabled(testId)), (d) => d === false, 30_000, 500);
  const clickedAt = nowIso();
  const clicked = app.page.eval(ui.click(testId)); // resolves once the confirm is answered
  const dialog = await waitUntil('confirm dialog', () => nativeDialog(app.main.pid), (d) => d.found && (d.texts ?? []).some((t) => t.startsWith(messagePrefix)), 15_000, 500);
  const ok = await nativeDialog(app.main.pid, 'OK');
  if (ok.clicked !== 'OK') throw new Error(`could not click OK on the confirm dialog: ${JSON.stringify(ok)}`);
  await clicked;
  log(`clicked ${testId} at ${clickedAt}, confirmed with OK`);
  return { clickedAt, dialog };
}

async function waitWorkflow(app: App, what: string, done: (w: WfSnap) => boolean, timeoutMs: number): Promise<WfSnap> {
  return waitUntil(what, () => wf(app.page), (w) => w !== null && done(w), timeoutMs, 1000) as Promise<WfSnap>;
}

// ---------------------------------------------------------------------------
// native dialogs (Electron Main's showMessageBoxSync) via Windows UI Automation
// ---------------------------------------------------------------------------

/** `click`: a PowerShell -like pattern for the button name (ASCII only: "Hủy" is matched as 'H?y'). */
function uiaScript(pid: number, click: string | null): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$pidCond = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})
$clsCond = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, '#32770')
$dialog = $null
foreach ($w in $A::RootElement.FindAll($TS::Children, $pidCond)) {
  if ($w.Current.ClassName -eq '#32770') { $dialog = $w; break }
  $inner = $w.FindFirst($TS::Children, $clsCond)
  if ($inner) { $dialog = $inner; break }
}
if (-not $dialog) { @{ found = $false } | ConvertTo-Json -Compress; exit 0 }
$textType = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
$texts = @($dialog.FindAll($TS::Descendants, $textType) | ForEach-Object { $_.Current.Name })
# A TaskDialog exposes its buttons as panes of class CCPushButton / CCCommandLink without an Invoke
# pattern (observed on Electron's message boxes) — so a click goes to the button's own HWND.
$buttons = @($dialog.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -or @('CCPushButton', 'CCCommandLink') -contains $_.Current.ClassName })
$names = @($buttons | ForEach-Object { $_.Current.Name })
$clicked = $null
$pattern = '${click ?? ''}'
if ($pattern -ne '') {
  foreach ($b in $buttons) {
    $n = $b.Current.Name
    if ($n -like $pattern) {
      $clicked = $n
      $invoke = $null
      if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke() }
      else {
        Add-Type -Namespace M510 -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
        [void][M510.User32]::PostMessage([System.IntPtr]$b.Current.NativeWindowHandle, 0x00F5, [System.IntPtr]::Zero, [System.IntPtr]::Zero)  # BM_CLICK
      }
      break
    }
  }
}
@{ found = $true; title = $dialog.Current.Name; texts = $texts; buttons = $names; clicked = $clicked } | ConvertTo-Json -Compress
`;
}

interface NativeDialog {
  found: boolean;
  title?: string;
  texts?: string[];
  buttons?: string[];
  clicked?: string | null;
}

const QUIT_CANCEL = 'H?y';
const QUIT_STOP = '*STOP workflow*';

async function nativeDialog(pid: number, click: string | null = null): Promise<NativeDialog> {
  const encoded = Buffer.from(uiaScript(pid, click), 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout.trim()) as NativeDialog;
}

/** The user clicking the window's close (X) button: WM_CLOSE to Electron Main's main window. */
async function closeWindow(pid: number): Promise<string> {
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).CloseMainWindow()`], { windowsHide: true });
  return stdout.trim();
}

/** Graceful end of a scenario (nothing of ours running): close the window like a user. */
async function quitApp(app: App): Promise<{ code: number | null; signal: string | null; at: string } | null> {
  app.page.close();
  const sent = await closeWindow(app.main.pid);
  log(`window close sent (CloseMainWindow → ${sent})`);
  // With no owned Workflow Host / run the app must not prompt: it simply exits.
  const exited = await Promise.race([app.exit, sleep(15_000).then(() => null)]);
  if (exited) return exited;
  const d = await nativeDialog(app.main.pid).catch(() => ({ found: false }) as NativeDialog);
  check('app quits without a dialog when it owns no live work', false, { dialog: d });
  return null;
}

// ---------------------------------------------------------------------------
// evidence (read-only, after the fact)
// ---------------------------------------------------------------------------

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function sessionsList(): Promise<string[]> {
  return (await readdir(path.join(aiBridgeDir, 'sessions')).catch(() => [] as string[])).filter((n) => /^\d{4}-\d{2}-\d{2}_\d{3}$/.test(n)).sort();
}

interface CallRecord {
  agent: string;
  iteration: number;
  mode: string;
  sessionId: string | null;
  sessionEvidence: string | null;
  continuity: string | null;
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  status: string;
  errorCode: string | null;
}

async function executionEvidence(runId: string): Promise<{ runId: string; calls: CallRecord[]; files: string[]; runStartedCorrelation: string | null }> {
  const dir = path.join(aiBridgeDir, 'sessions', runId);
  const files = (await readdir(dir).catch(() => [] as string[])).sort();
  const calls: CallRecord[] = [];
  for (const f of files.filter((n) => /^\d{3}-(claude|codex)-execution\.json$/.test(n))) {
    const r = await readJson<Record<string, any>>(path.join(dir, f));
    if (!r) continue;
    calls.push({
      agent: r.agent,
      iteration: r.iteration,
      mode: r.mode,
      sessionId: r.cliSessionId?.reported ?? null,
      sessionEvidence: r.cliSessionId?.evidence ?? null,
      continuity: r.continuity?.verdict ?? null,
      pid: r.process?.pid ?? null,
      startedAt: r.process?.startedAt ?? null,
      endedAt: r.process?.endedAt ?? null,
      durationMs: r.process?.durationMs ?? null,
      exitCode: r.process?.exitCode ?? null,
      status: r.status,
      errorCode: r.errorCode ?? null,
    });
  }
  // The run's RUN_STARTED correlation (ADR-017) from the project run-event log.
  let runStartedCorrelation: string | null = null;
  try {
    for (const line of (await readFile(path.join(aiBridgeDir, 'logs', 'events.jsonl'), 'utf8')).split('\n')) {
      if (!line.includes(runId) || !line.includes('RUN_STARTED')) continue;
      const e = JSON.parse(line) as { runId?: string; event?: string; correlation?: string };
      if (e.runId === runId && e.event === 'RUN_STARTED') runStartedCorrelation = e.correlation ?? null;
    }
  } catch {
    // no run log
  }
  return { runId, calls, files, runStartedCorrelation };
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
}

async function instanceFile(workflowId: string): Promise<Record<string, any> | null> {
  return readJson(path.join(aiBridgeDir, 'workflows', 'instances', workflowId, 'instance.json'));
}

function inputsOf(evs: WfEvent[], inputType: string): { seq: number; input: Record<string, any> }[] {
  return evs
    .filter((e) => e.type === 'INPUT_RECEIVED' && e.payload.inputType === inputType)
    .map((e) => {
      try {
        return { seq: e.seq, input: JSON.parse(String(e.payload.input)) as Record<string, any> };
      } catch {
        return { seq: e.seq, input: {} };
      }
    });
}

async function workflowEvidence(app: App, workflowId: string): Promise<Record<string, any>> {
  const inst = (await instanceFile(workflowId))?.instance ?? null;
  const evs = await events(app.page, workflowId);
  const attempts = (inst?.steps ?? []).flatMap((s: any) =>
    s.attempts.map((a: any) => ({ stepId: s.stepId, stepState: s.state, ...pick(a, ['attemptId', 'state', 'executionId', 'launches', 'hostPid', 'iterationsUsed', 'maxIterations', 'plannedAt', 'launchedAt', 'endedAt', 'stopCause', 'reportedTokens', 'tokensIncomplete', 'lastOutcome', 'verification']) })),
  );
  const runs = [];
  for (const runId of await sessionsList()) runs.push(await executionEvidence(runId));
  const typeCounts: Record<string, number> = {};
  for (const e of evs) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
  const inputCounts: Record<string, number> = {};
  for (const e of evs) if (e.type === 'INPUT_RECEIVED') inputCounts[String(e.payload.inputType)] = (inputCounts[String(e.payload.inputType)] ?? 0) + 1;
  return {
    workflowId,
    definitionId: inst?.definitionId,
    definitionHash: inst?.definitionHash,
    state: inst?.state,
    terminalReason: inst?.terminalReason,
    evidenceLevel: inst?.evidenceLevel,
    createdAt: inst?.createdAt,
    startedAt: inst?.startedAt,
    endedAt: inst?.endedAt,
    durationMs: inst?.startedAt && inst?.endedAt ? Date.parse(inst.endedAt) - Date.parse(inst.startedAt) : null,
    eventCount: evs.length,
    eventTypeCounts: typeCounts,
    inputCounts,
    attempts,
    runs,
    reconciled: evs.filter((e) => e.type === 'RECONCILED').map((e) => ({ seq: e.seq, timestamp: e.timestamp, actor: e.actor, executionId: e.executionId, payload: e.payload })),
    executionEnded: inputsOf(evs, 'EXECUTION_ENDED').map((x) => ({ seq: x.seq, result: x.input.result })),
    hostSpawned: inputsOf(evs, 'EXECUTION_HOST_SPAWNED').map((x) => ({ seq: x.seq, hostPid: x.input.hostPid })),
    timeline: evs.map((e) => `${e.seq} ${e.timestamp} ${e.type}${e.type === 'INPUT_RECEIVED' ? `(${String(e.payload.inputType)})` : ''} ${e.actor}${e.executionId ? ` exec=${e.executionId}` : ''}`),
  };
}

/** Scenario H: what the real renderer shows for the selected workflow. */
async function captureUi(app: App, label: string): Promise<Record<string, any>> {
  await shot(app, `${label}-detail`);
  const dom = await app.page.eval<Record<string, unknown>>(`(() => {
    const q = (s, r = document) => [...r.querySelectorAll(s)];
    const t = (id, r = document) => r.querySelector('[data-testid="' + id + '"]')?.textContent?.trim() ?? null;
    const view = document.querySelector('[data-testid="workflow-view"]');
    const text = view?.innerText ?? '';
    return {
      list: q('[data-testid="wf-item"]').map((e) => ({ workflowId: e.dataset.workflowId, state: t('wf-item-state', e), step: t('wf-item-step', e) })),
      detailWorkflowId: document.querySelector('[data-testid="wf-detail"]')?.dataset.workflowId ?? null,
      displayState: t('wf-display-state'), persistedState: t('wf-persisted-state'), headline: t('wf-headline'),
      definition: t('wf-definition'), terminalReason: t('wf-terminal-reason'), evidence: t('wf-evidence'),
      verificationMode: t('wf-verification-mode'), host: t('wf-host'), execution: t('wf-execution'), integrity: t('wf-integrity'),
      steps: q('[data-testid="wf-step"]').map((li) => ({ stepId: li.dataset.stepId, state: t('wf-step-state', li), current: !!li.querySelector('[data-testid="wf-step-current"]'),
        attempt: t('wf-step-attempt', li), execution: t('wf-step-execution', li), outcome: t('wf-step-outcome', li), verification: t('wf-step-verification', li), evidence: t('wf-step-evidence', li) })),
      controls: ['wf-btn-start', 'wf-btn-pause', 'wf-btn-resume', 'wf-btn-stop'].map((id) => { const b = document.querySelector('[data-testid="' + id + '"]'); return { id, present: !!b, disabled: b ? b.disabled : null, label: b?.textContent?.trim() ?? null }; }),
      recovery: q('[data-testid="wf-recovery-item"]').map((e) => ({ kind: e.dataset.kind, text: e.textContent.trim() })),
      interruptedBanner: !!document.querySelector('[data-testid="wf-interrupted"]'),
      timelineEvents: q('[data-testid="wf-event"]').length,
      timelineMore: !!document.querySelector('[data-testid="wf-events-more"]'),
      verifiedWordCount: (text.match(/\\bVERIFIED\\b/g) ?? []).length,
      aiAttestedCount: (text.match(/AI_ATTESTED/g) ?? []).length,
    };
  })()`);
  // Journal tab (derived workflow.md).
  let journal: Record<string, unknown> = { shown: false };
  try {
    await app.page.eval(ui.click('wf-tab-journal'));
    const jt = await waitUntil('journal tab content', () => app.page.eval<string | null>(`document.querySelector('[data-testid="wf-journal"]')?.innerText ?? null`), (v) => v !== null && v.length > 200, 15_000, 500) ?? '';
    await shot(app, `${label}-journal`);
    journal = { shown: true, chars: jt.length, mentionsAiAttested: jt.includes('AI_ATTESTED') };
    await app.page.eval(ui.click('wf-tab-timeline'));
  } catch (err) {
    journal = { shown: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ...dom, journal };
}

/** Scenario I: workflow.md is derived, deterministic, and links real artifacts. */
async function journalChecks(app: App, workflowId: string, wfEv: Record<string, any>): Promise<Record<string, unknown>> {
  const file = path.join(aiBridgeDir, 'workflows', 'instances', workflowId, 'workflow.md');
  const before = await readFile(file).catch(() => null);
  const r1 = await app.page.eval<{ ok: boolean; data: { markdown: string } }>(`window.aiBridge.workflowGetJournal({ workflowId: ${JSON.stringify(workflowId)} })`);
  const after1 = await readFile(file).catch(() => null);
  const r2 = await app.page.eval<{ ok: boolean; data: { markdown: string } }>(`window.aiBridge.workflowGetJournal({ workflowId: ${JSON.stringify(workflowId)} })`);
  const after2 = await readFile(file).catch(() => null);
  const md = after2?.toString('utf8') ?? '';
  const links = [...md.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  const linkCheck = links.map((l) => ({ link: l, exists: existsSync(path.resolve(path.dirname(file), l)) }));
  const execIds = (wfEv.attempts as any[]).map((a) => a.executionId).filter(Boolean);
  const attemptIds = (wfEv.attempts as any[]).map((a) => a.attemptId);
  const out = {
    path: path.relative(projectPath, file),
    generated: before !== null,
    sha256Generated: before ? sha256(before) : null,
    sha256Rebuild1: after1 ? sha256(after1) : null,
    sha256Rebuild2: after2 ? sha256(after2) : null,
    ipcMarkdownSha256: r1.ok ? sha256(r1.data.markdown) : null,
    ipcMarkdownSame: r1.ok && r2.ok && r1.data.markdown === r2.data.markdown,
    bytes: after2?.length ?? 0,
    contains: {
      workflowId: md.includes(workflowId),
      definitionId: md.includes(String(wfEv.definitionId)),
      definitionHash: md.includes(String(wfEv.definitionHash)),
      steps: (wfEv.attempts as any[]).every((a) => md.includes(a.stepId)),
      attemptIds: attemptIds.every((id) => md.includes(id)),
      executionIds: execIds.every((id) => md.includes(id)),
      aiAttested: md.includes('AI_ATTESTED'),
      timeline: md.includes('## Timeline') && md.includes('WORKFLOW_CREATED'),
      sessionLinks: execIds.every((id) => links.some((l) => l.includes(`sessions/${id}`))),
    },
    links: linkCheck,
  };
  check('journal generated', out.generated, out.path);
  check('journal byte-identical across two rebuilds (inputs unchanged)', out.sha256Generated !== null && out.sha256Generated === out.sha256Rebuild1 && out.sha256Rebuild1 === out.sha256Rebuild2 && out.ipcMarkdownSame, {
    generated: out.sha256Generated,
    rebuild1: out.sha256Rebuild1,
    rebuild2: out.sha256Rebuild2,
  });
  check('journal contains identity, hash, steps, attempts, executions, AI_ATTESTED, timeline, run links', Object.values(out.contains).every(Boolean), out.contains);
  check('every journal link resolves to an existing artifact', linkCheck.length > 0 && linkCheck.every((l) => l.exists), linkCheck);
  return out;
}

/** After a scenario: every process we saw must be gone; nothing of ours may be left anywhere. */
async function orphanCheck(): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  let alive: Tracked[] = [];
  for (;;) {
    await monitor.sample();
    alive = [...monitor.tracked.values()].filter((t) => monitor.alive(t));
    if (alive.length === 0 || Date.now() > deadline) break;
    await sleep(1000);
  }
  const needles = [projectPath.toLowerCase(), userDataDir.toLowerCase()];
  const stray = monitor.latest.filter((p) => {
    const c = p.cmd.toLowerCase();
    return needles.some((n) => c.includes(n)) || /dist-desktop[\\/](workflow|run)-host\.mjs/.test(c);
  });
  const out = {
    tracked: monitor.tracked.size,
    trackedByRole: Object.fromEntries((['electron-main', 'electron-helper', 'workflow-host', 'execution-host', 'claude', 'codex', 'other'] as Role[]).map((r) => [r, monitor.byRole(r).length])),
    stillAlive: alive.map((t) => ({ role: t.role, pid: t.pid, name: t.name })),
    strayProcesses: stray.map((p) => ({ pid: p.pid, name: p.name })),
  };
  check('no orphan: every process this scenario started has exited', alive.length === 0, out.stillAlive);
  check('no stray host/app process for this project remains', stray.length === 0, out.strayProcesses);
  return out;
}

async function waitRole(role: Role, parent: Tracked, what: string, timeoutMs: number): Promise<Tracked> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await monitor.sample();
    const hit = monitor.childrenOf(parent, role).find((t) => monitor.alive(t));
    if (hit) {
      log(`${what}: pid ${hit.pid} (created ${hit.created}, parent ${parent.role} ${parent.pid})`);
      return hit;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

interface Chain {
  wh: Tracked;
  eh: Tracked;
  claude: Tracked;
  executionId: string;
  attemptId: string;
}

/** The running chain Main → Workflow Host → Execution Host → claude.exe of a just-started workflow. */
async function liveChain(app: App): Promise<Chain> {
  const wh = await waitRole('workflow-host', app.main, 'Workflow Host', 60_000);
  const eh = await waitRole('execution-host', wh, 'Execution Host', 60_000);
  const claude = await waitRole('claude', eh, 'Claude CLI', 180_000);
  const w = await waitWorkflow(app, 'attempt linked to its execution (EXECUTING)', (x) => x.steps.some((s) => s.current?.state === 'EXECUTING' && s.current.executionId !== null), 60_000);
  const cur = w.steps.find((s) => s.current?.state === 'EXECUTING')!.current!;
  const snap = await panel(app.page);
  check('Workflow Host pid (Core host record) = the workflow-host process forked by Main', snap?.activity.hostPid === wh.pid, { core: snap?.activity.hostPid, observed: wh.pid });
  const view = await attemptView(app.page, cur.attemptId);
  check('Execution Host pid (attempt.hostPid) = the run-host process forked by the Workflow Host', view?.attempt.hostPid === eh.pid, { attempt: view?.attempt.hostPid, observed: eh.pid });
  return { wh, eh, claude, executionId: cur.executionId!, attemptId: cur.attemptId };
}

function recordChain(label: string, app: App, c: Chain): void {
  result[label] = {
    electronMain: { pid: app.main.pid, created: app.main.created },
    workflowHost: { pid: c.wh.pid, created: c.wh.created },
    executionHost: { pid: c.eh.pid, created: c.eh.created },
    claude: { pid: c.claude.pid, created: c.claude.created },
    executionId: c.executionId,
    attemptId: c.attemptId,
  };
}

function noDuplicateChecks(ev: Record<string, any>, expected: { executions: number; attempts: number; ehSpawns: number }): void {
  const attempts = ev.attempts as any[];
  const runs = ev.runs as any[];
  check(`execution count = ${expected.executions} (sessions/ of this project)`, runs.length === expected.executions, runs.map((r) => r.runId));
  check(`attempts = ${expected.attempts}, one per step`, attempts.length === expected.attempts && new Set(attempts.map((a) => a.stepId)).size === attempts.length, attempts.map((a) => a.attemptId));
  check('launches = 1 per attempt', attempts.every((a) => a.launches === 1), attempts.map((a) => a.launches));
  check('ATTEMPT_LAUNCHING events = attempts', ev.eventTypeCounts.ATTEMPT_LAUNCHING === expected.attempts, ev.eventTypeCounts.ATTEMPT_LAUNCHING);
  check(`Execution Host spawns recorded = ${expected.ehSpawns}`, (ev.hostSpawned as any[]).length === expected.ehSpawns, ev.hostSpawned);
  const ids = attempts.map((a) => a.executionId);
  check('execution ids distinct and each one is a real run', new Set(ids).size === ids.length && ids.every((id) => runs.some((r) => r.runId === id)), ids);
  for (const r of runs) {
    const a = attempts.find((x) => x.executionId === r.runId);
    check(`run ${r.runId} RUN_STARTED correlation = its attemptId (ADR-017)`, a !== undefined && r.runStartedCorrelation === a.attemptId, { correlation: r.runStartedCorrelation, attemptId: a?.attemptId });
  }
}

function aiAttestedChecks(ev: Record<string, any>): void {
  check('workflow evidence level AI_ATTESTED (never VERIFIED in M5)', ev.evidenceLevel === 'AI_ATTESTED', ev.evidenceLevel);
  for (const a of ev.attempts as any[]) check(`attempt ${a.attemptId} verification PASS / AI_ATTESTED`, a.verification?.verdict === 'PASS' && a.verification?.evidenceLevel === 'AI_ATTESTED', a.verification);
}

function uiChecks(u: Record<string, any>, workflowId: string, ev: Record<string, any>): void {
  check('UI list shows the workflow', (u.list as any[]).some((i) => i.workflowId === workflowId), u.list);
  check('UI detail shows the workflow', u.detailWorkflowId === workflowId, u.detailWorkflowId);
  check('UI evidence = AI_ATTESTED, not claimed verified', String(u.evidence).startsWith('AI_ATTESTED') && u.verifiedWordCount === 0, { evidence: u.evidence, verifiedWordCount: u.verifiedWordCount });
  check('UI verification mode = OutcomeOnly', /outcome/i.test(String(u.verificationMode)), u.verificationMode);
  const steps = u.steps as any[];
  for (const a of ev.attempts as any[]) {
    const s = steps.find((x) => x.stepId === a.stepId);
    check(`UI step ${a.stepId}: attempt 1/1, execution ${a.executionId}, outcome, AI_ATTESTED`, !!s && String(s.attempt).startsWith('1/1') && s.execution === a.executionId && /ENDED/.test(String(s.outcome)) && String(s.evidence).startsWith('AI_ATTESTED'), s);
  }
  check('UI timeline lists the persisted events', u.timelineEvents > 0 && (u.timelineEvents === ev.eventCount || u.timelineMore === true), { shown: u.timelineEvents, persisted: ev.eventCount });
  check('UI journal tab renders workflow.md', u.journal?.shown === true && u.journal?.mentionsAiAttested === true, u.journal);
  const ctl = Object.fromEntries((u.controls as any[]).map((c) => [c.id, c]));
  check('UI controls at rest: PAUSE/RESUME/STOP disabled for a terminal workflow', ctl['wf-btn-pause']?.disabled === true && ctl['wf-btn-resume']?.disabled === true && ctl['wf-btn-stop']?.disabled === true, u.controls);
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

const TERMINALISH = ['COMPLETED', 'FAILED', 'STOPPED', 'BLOCKED', 'WAITING_HUMAN'];

async function scenarioPreflight(): Promise<void> {
  // Zero quota: the whole chain reaches the real preflight, which refuses before any
  // Claude/Codex call when a provider is not ready (claude-auth). Also exercises STOP in the UI.
  const app = await launch('preflight');
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.preflight, true);
  const w = await waitWorkflow(app, 'workflow at rest', (x) => TERMINALISH.includes(x.state), 180_000);
  await monitor.sample();
  log(`state ${w.state}, attempt ${JSON.stringify(w.steps[0]?.current)}`);
  check('Workflow Host forked by Main, Execution Host forked by the Workflow Host', monitor.byRole('workflow-host').length === 1 && monitor.byRole('execution-host').length === 1 && monitor.childrenOf(monitor.byRole('workflow-host')[0], 'execution-host').length === 1, monitor.summary());
  check('no Claude/Codex session was started (preflight refused)', monitor.byRole('codex').length === 0 && (await sessionsList()).length === 0);
  result.uiBlocked = await captureUi(app, 'blocked');
  // H (zero quota): the error state (BLOCKED by the environment) at 1080×700.
  result.layoutBlocked = await layoutAudit(app, 'preflight-blocked', { list: true, detail: true, state: 'Blocked', controls: true, journal: true });
  result.layoutArtifacts = await artifactsViewAudit(app, 'preflight-artifacts');
  if (w.controls.canStop) {
    const c = await clickAndConfirm(app, 'wf-btn-stop', 'STOP workflow?');
    check('STOP confirmation shown (window.confirm, answered OK)', app.dialogs.some((d) => d.type === 'confirm' && d.message.startsWith('STOP workflow?')), { cdp: app.dialogs, native: c.dialog });
    await waitWorkflow(app, 'STOPPED', (x) => x.state === 'STOPPED', 60_000);
    result.layoutStopped = await layoutAudit(app, 'preflight-stopped', { detail: true, state: 'Stopped' });
  }
  result.workflow = await workflowEvidence(app, workflowId);
  result.appExit = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

async function scenarioA(): Promise<void> {
  const app = await launch('A');
  const t0 = Date.now();
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.A);
  const chain = await liveChain(app);
  recordChain('chain', app, chain);
  const w = await waitWorkflow(app, 'COMPLETED', (x) => TERMINALISH.includes(x.state), 20 * 60_000);
  log(`workflow ${workflowId} ${w.state} after ${Math.round((Date.now() - t0) / 1000)} s`);
  await monitor.sample();
  const ev = await workflowEvidence(app, workflowId);
  result.workflow = ev;
  check('workflow COMPLETED', ev.state === 'COMPLETED', { state: ev.state, terminalReason: ev.terminalReason });
  aiAttestedChecks(ev);
  noDuplicateChecks(ev, { executions: 1, attempts: 1, ehSpawns: 1 });
  const claudeSessions = new Set((ev.runs as any[]).flatMap((r) => r.calls.filter((c: CallRecord) => c.agent === 'claude').map((c: CallRecord) => c.sessionId)));
  check('exactly one Execution Host and one Claude session for the step', monitor.byRole('execution-host').length === 1 && claudeSessions.size === 1, { executionHosts: monitor.byRole('execution-host').length, claudeSessions: [...claudeSessions] });
  result.artifacts = await artifactChecks('A', [A_ARTIFACT]);
  const u = await captureUi(app, 'A');
  result.ui = u;
  uiChecks(u, workflowId, ev);
  result.layoutCompleted = await layoutAudit(app, 'A-completed', { list: true, detail: true, state: 'Completed', controls: true, journal: true });
  await artifactsLinkCheck(app, chain.executionId);
  result.journal = await journalChecks(app, workflowId, ev);
  result.appExit = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

async function scenarioB(): Promise<void> {
  const app = await launch('B');
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.B);
  const first = await liveChain(app);
  recordChain('chainStep1', app, first);
  const w = await waitWorkflow(app, 'COMPLETED', (x) => TERMINALISH.includes(x.state), 30 * 60_000);
  log(`workflow ${workflowId} ${w.state}`);
  await monitor.sample();
  const ev = await workflowEvidence(app, workflowId);
  result.workflow = ev;
  check('workflow COMPLETED', ev.state === 'COMPLETED', { state: ev.state, terminalReason: ev.terminalReason });
  aiAttestedChecks(ev);
  noDuplicateChecks(ev, { executions: 2, attempts: 2, ehSpawns: 2 });
  const [a1, a2] = ev.attempts as any[];
  const runOf = (a: any) => (ev.runs as any[]).find((r) => r.runId === a.executionId);
  const r1 = runOf(a1);
  const r2 = runOf(a2);
  if (r1 && r2 && a1 && a2) {
    const lastEnd1 = Math.max(...r1.calls.map((c: CallRecord) => Date.parse(c.endedAt ?? '')));
    const firstStart2 = Math.min(...r2.calls.map((c: CallRecord) => Date.parse(c.startedAt ?? '')));
    check('strictly sequential: step 2 attempt planned after step 1 attempt ended', Date.parse(a2.plannedAt) >= Date.parse(a1.endedAt), { step1EndedAt: a1.endedAt, step2PlannedAt: a2.plannedAt });
    check('strictly sequential: step 2 first CLI call started after step 1 last CLI call ended', firstStart2 > lastEnd1, { step1LastCliEnd: new Date(lastEnd1).toISOString(), step2FirstCliStart: new Date(firstStart2).toISOString() });
  }
  const ehs = monitor.byRole('execution-host').sort((x, y) => x.created.localeCompare(y.created));
  check('two Execution Hosts, lifetimes do not overlap', ehs.length === 2 && ehs[0].goneAt !== null && ehs[1].created >= ehs[0].created && ehs[1].firstSeenAt >= ehs[0].goneAt, ehs.map((e) => ({ pid: e.pid, created: e.created, firstSeenAt: e.firstSeenAt, goneAt: e.goneAt })));
  // Step 1 → output → Step 2 input → Step 2 execution (not two unrelated tasks).
  result.dependency = await dependencyChecks(ev);
  result.artifacts = await artifactChecks('B', [B_STEP1, B_STEP2]);
  const u = await captureUi(app, 'B');
  result.ui = u;
  uiChecks(u, workflowId, ev);
  result.layoutCompleted = await layoutAudit(app, 'B-completed', { list: true, detail: true, state: 'Completed', controls: true, journal: true });
  result.journal = await journalChecks(app, workflowId, ev);
  const md = await readFile(path.join(aiBridgeDir, 'workflows', 'instances', workflowId, 'workflow.md'), 'utf8').catch(() => '');
  const h1 = md.indexOf('### 1. `write-token`');
  const h2 = md.indexOf('### 2. `copy-token`');
  check('B: workflow.md lists step 1 (write-token) before step 2 (copy-token)', h1 !== -1 && h2 > h1, { h1, h2 });
  result.appExit = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

async function scenarioC(): Promise<void> {
  let app = await launch('C-1');
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.C);
  const chain = await liveChain(app);
  recordChain('chain', app, chain);
  const pauseClickedAt = await clickWhenEnabled(app, 'wf-btn-pause', 120_000);
  const pending = await waitWorkflow(app, 'pause recorded', (x) => x.pauseRequested || x.state !== 'RUNNING', 30_000);
  check('PAUSE_REQUESTED persisted (pauseRequested)', pending.pauseRequested || pending.state === 'PAUSED', { pauseRequested: pending.pauseRequested, state: pending.state });
  await shot(app, 'C-pause-pending');
  const rest = await waitWorkflow(app, 'PAUSED (or ended)', (x) => x.state !== 'RUNNING', 20 * 60_000);
  log(`after pause: ${rest.state}`);
  await monitor.sample();
  result.pausedWorkflow = await workflowEvidence(app, workflowId);
  if (!check('workflow PAUSED at a valid checkpoint (execution paused between iterations)', rest.state === 'PAUSED', { state: rest.state, terminalReason: rest.terminalReason, pauseClickedAt })) {
    result.note = 'The pause did not land: the execution reached a final verdict before an iteration boundary. Pause-at-boundary semantics were therefore not exercised.';
    result.appExit = await quitApp(app);
    result.processes = monitor.summary();
    result.cleanup = await orphanCheck();
    return;
  }
  const pausedAttempt = (result.pausedWorkflow as any).attempts[0];
  check('attempt PAUSED_EXECUTION, same execution kept', pausedAttempt.state === 'PAUSED_EXECUTION' && pausedAttempt.executionId === chain.executionId, pausedAttempt);
  const run = await new BridgeEngine(projectPath).status();
  check('the execution itself is PAUSED in BridgeEngine (same runId)', run.runId === chain.executionId && run.status === 'PAUSED', { runId: run.runId, status: run.status, iteration: run.iteration });
  await monitor.sample();
  check('Workflow Host, Execution Host and CLIs ended while paused', !monitor.alive(chain.wh) && !monitor.alive(chain.eh) && monitor.byRole('claude').every((t) => !monitor.alive(t)) && monitor.byRole('codex').every((t) => !monitor.alive(t)));
  const uiPaused = await captureUi(app, 'C-paused');
  result.uiPaused = uiPaused;
  const resumeBtn = (uiPaused.controls as any[]).find((c) => c.id === 'wf-btn-resume');
  check('UI shows PAUSED with RESUME enabled', /PAUSED/.test(String((await wf(app.page))?.displayState)) && resumeBtn?.disabled === false, { displayState: uiPaused.displayState, controls: uiPaused.controls });
  // Iteration 1 finished before the pause landed: exactly the first half of the artifact exists.
  result.artifactsPaused = await artifactChecks('C (paused)', [C_PAUSED]);
  result.layoutPaused = await layoutAudit(app, 'C-paused', { detail: true, state: 'Paused', controls: true });

  // Pause-first quit (docs/23 §11.1): with the workflow PAUSED the app owns no live work, so a
  // normal quit exits without the STOP prompt and the workflow stays resumable.
  const quit = await quitApp(app);
  result.pauseFirstQuit = quit;
  check('pause-first: the app quits cleanly with no STOP prompt', quit !== null && quit.code === 0, quit);

  app = await launch('C-2 (relaunch)');
  const reopened = await waitWorkflow(app, 'the workflow after relaunch', (x) => x.workflowId === workflowId, 30_000);
  check('after relaunch the workflow is still PAUSED and resumable', reopened.state === 'PAUSED' && reopened.controls.canResume, { state: reopened.state, controls: reopened.controls });
  await shot(app, 'C-relaunched');
  await clickWhenEnabled(app, 'wf-btn-resume');
  const resumedWh = await waitRole('workflow-host', app.main, 'Workflow Host (resume)', 60_000);
  const resumedEh = await waitRole('execution-host', resumedWh, 'Execution Host (resume)', 60_000);
  const w = await waitWorkflow(app, 'COMPLETED', (x) => TERMINALISH.includes(x.state), 20 * 60_000);
  log(`after resume: ${w.state}`);
  await monitor.sample();
  const ev = await workflowEvidence(app, workflowId);
  result.workflow = ev;
  result.resumed = { workflowHost: { pid: resumedWh.pid, created: resumedWh.created }, executionHost: { pid: resumedEh.pid, created: resumedEh.created } };
  check('workflow COMPLETED after resume', ev.state === 'COMPLETED', { state: ev.state, terminalReason: ev.terminalReason });
  const a = (ev.attempts as any[])[0];
  check('resume continued the SAME execution (same runId, same attempt)', a.executionId === chain.executionId && a.attemptId === chain.attemptId && (ev.runs as any[]).length === 1, { executionId: a.executionId, runs: (ev.runs as any[]).map((r) => r.runId) });
  check('one attempt, one launch; the resume is a second Execution Host segment of the same run', (ev.attempts as any[]).length === 1 && a.launches === 1 && (ev.hostSpawned as any[]).length === 2, { launches: a.launches, hostSpawned: ev.hostSpawned });
  const claudeCalls = ((ev.runs as any[])[0]?.calls ?? []).filter((c: CallRecord) => c.agent === 'claude');
  check('Claude session continued across the pause (RESUME, same session id, continuity VERIFIED)', claudeCalls.length >= 2 && claudeCalls.slice(1).every((c: CallRecord) => c.mode === 'RESUME' && c.sessionId === claudeCalls[0].sessionId && c.continuity === 'VERIFIED'), claudeCalls);
  aiAttestedChecks(ev);
  result.artifacts = await artifactChecks('C (completed)', [C_DONE]);
  const u = await captureUi(app, 'C');
  result.ui = u;
  uiChecks(u, workflowId, ev);
  result.journal = await journalChecks(app, workflowId, ev);
  result.appExit = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

async function scenarioD(): Promise<void> {
  let app = await launch('D-1');
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.D);
  const chain = await liveChain(app);
  recordChain('chain', app, chain);
  const t0 = Date.now();
  const c = await clickAndConfirm(app, 'wf-btn-stop', 'STOP workflow?');
  const confirm = app.dialogs.find((d) => d.type === 'confirm');
  check('STOP confirmation shown (answered OK)', confirm !== undefined && confirm.message.startsWith('STOP workflow?'), { cdp: app.dialogs, native: c.dialog });
  const stopped = await waitWorkflow(app, 'STOPPED', (x) => ['STOPPED', 'COMPLETED', 'FAILED'].includes(x.state), 5 * 60_000);
  const tStopped = Date.now();
  for (;;) {
    await monitor.sample();
    if (!monitor.alive(chain.eh) && !monitor.alive(chain.claude) && monitor.byRole('codex').every((t) => !monitor.alive(t))) break;
    if (Date.now() - t0 > 120_000) break;
    await sleep(1000);
  }
  const tDead = Date.now();
  result.stopDuration = { toStoppedStateMs: tStopped - t0, toProcessesGoneMs: tDead - t0, note: 'measured by 1 s polling; upper bounds' };
  check('workflow STOPPED', stopped.state === 'STOPPED', { state: stopped.state, terminalReason: stopped.terminalReason });
  check('Execution Host terminated', !monitor.alive(chain.eh));
  check('Claude process terminated', !monitor.alive(chain.claude));
  const ev = await workflowEvidence(app, workflowId);
  result.workflow = ev;
  const a = (ev.attempts as any[])[0];
  check('attempt STOPPED by the USER, same execution', a.state === 'STOPPED' && a.stopCause === 'USER' && a.executionId === chain.executionId, a);
  const run = await new BridgeEngine(projectPath).status();
  check('the execution is STOPPED in BridgeEngine', run.runId === chain.executionId && run.status === 'STOPPED', { runId: run.runId, status: run.status });
  check('STOP reached the WorkflowEngine (one STOP_REQUESTED event)', (ev.eventTypeCounts.STOP_REQUESTED ?? 0) === 1, ev.eventTypeCounts);
  await shot(app, 'D-stopped');
  result.layoutStopped = await layoutAudit(app, 'D-stopped', { detail: true, state: 'Stopped', controls: true });
  result.appExit = await quitApp(app);
  // Later open: nothing is relaunched for a STOPPED workflow.
  const runsBefore = await sessionsList();
  app = await launch('D-2 (reopen)');
  const reopened = await waitWorkflow(app, 'reopened', (x) => x.workflowId === workflowId, 30_000);
  await monitor.sample();
  const runsAfter = await sessionsList();
  check('later open: still STOPPED, no new execution, no Workflow/Execution Host spawned', reopened.state === 'STOPPED' && runsAfter.length === runsBefore.length && monitor.childrenOf(app.main, 'workflow-host').length === 0, { state: reopened.state, runsBefore, runsAfter });
  result.appExit2 = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

/** E and F: after the crash, a NEW Workflow Host must WATCH and ADOPT the surviving execution.
 * J4: the execution already finished while no Workflow Host existed (a stale snapshot) → ADOPT
 * without WATCH. Both: the same execution, never a relaunch. */
async function recoveryAssertions(app: App, workflowId: string, chain: Chain, newWh: Tracked | null, crashAt: string, mode: 'WATCH_THEN_ADOPT' | 'ADOPT_ONLY' = 'WATCH_THEN_ADOPT'): Promise<void> {
  const w = await waitWorkflow(app, 'COMPLETED', (x) => TERMINALISH.includes(x.state), 20 * 60_000);
  log(`after recovery: ${w.state}`);
  await monitor.sample();
  const ev = await workflowEvidence(app, workflowId);
  result.workflow = ev;
  check('workflow COMPLETED', ev.state === 'COMPLETED', { state: ev.state, terminalReason: ev.terminalReason });
  const a = (ev.attempts as any[])[0];
  check('reconciled executionId == original executionId', a.executionId === chain.executionId, { original: chain.executionId, reconciled: a.executionId });
  check('same attemptId', a.attemptId === chain.attemptId, { original: chain.attemptId, now: a.attemptId });
  noDuplicateChecks(ev, { executions: 1, attempts: 1, ehSpawns: 1 });
  const watch = (ev.reconciled as any[]).find((r) => r.payload.finding === 'WATCH');
  const ended = (ev.executionEnded as any[]).filter((x) => x.result?.executionId === chain.executionId);
  // ADOPT is persisted as an ordinary EXECUTION_ENDED input (the M5.7 open item); the reconciler's
  // ADOPT result carries reportedTokens null ("not re-derived"), unlike an attached host's outcome.
  if (mode === 'WATCH_THEN_ADOPT') {
    check('WATCH: the new Workflow Host found the execution RUNNING and watched it', watch !== undefined && (watch.executionId === chain.executionId || watch.payload.executionId === chain.executionId) && Date.parse(watch.timestamp) > Date.parse(crashAt), ev.reconciled);
    check('ADOPT: exactly one EXECUTION_ENDED for the execution, after WATCH, adopted (reportedTokens null)', ended.length === 1 && watch !== undefined && ended[0].seq > watch.seq && ended[0].result.reportedTokens === null, ended);
  } else {
    check('no WATCH: the execution had already ended before the new Workflow Host opened the workflow', watch === undefined, ev.reconciled);
    check('ADOPT: exactly one EXECUTION_ENDED for the execution, adopted from the terminal session (reportedTokens null)', ended.length === 1 && ended[0].result.reportedTokens === null && ended[0].result.finalStatus === 'DONE', ended);
  }
  result.artifacts = await artifactChecks(`${scenario} (the adopted execution's work)`, [A_ARTIFACT]);
  if (newWh) {
    const ehByNew = monitor.childrenOf(newWh, 'execution-host');
    check('the new Workflow Host spawned ZERO Execution Hosts', ehByNew.length === 0, ehByNew.map((t) => t.pid));
  } else {
    log('the new Workflow Host lived shorter than one process sample; "zero new Execution Hosts" rests on the checks below (one Execution Host in the whole scenario, one EXECUTION_HOST_SPAWNED, one session)');
  }
  check('exactly one Execution Host in the whole scenario', monitor.byRole('execution-host').length === 1, monitor.byRole('execution-host').map((t) => t.pid));
  const claudeProcs = monitor.byRole('claude');
  const claudeCalls = ((ev.runs as any[])[0]?.calls ?? []).filter((c: CallRecord) => c.agent === 'claude');
  check('no duplicate Claude session: every Claude process belongs to the original Execution Host; one session id', claudeProcs.every((t) => t.parentKey === keyOf(chain.eh)) && new Set(claudeCalls.map((c: CallRecord) => c.sessionId)).size === 1, { claudeProcs: claudeProcs.map((t) => t.pid), sessions: claudeCalls.map((c: CallRecord) => c.sessionId) });
  aiAttestedChecks(ev);
  const u = await captureUi(app, scenario);
  result.ui = u;
  if (mode === 'WATCH_THEN_ADOPT') {
    check('UI recovery section shows the WATCH decision', (u.recovery as any[]).some((r) => r.kind === 'WATCH' || /WATCH/.test(r.text)), u.recovery);
    result.layoutRecovered = await layoutAudit(app, `${scenario}-recovered`, { detail: true, state: 'Completed', recovery: true, journal: true });
  } else {
    result.layoutRecovered = await layoutAudit(app, `${scenario}-recovered`, { detail: true, state: 'Completed', journal: true });
  }
  uiChecks(u, workflowId, ev);
  result.journal = await journalChecks(app, workflowId, ev);
}

async function scenarioE(): Promise<void> {
  const app = await launch('E');
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.E);
  const chain = await liveChain(app);
  recordChain('chain', app, chain);
  const crashAt = await killOnly(chain.wh, 'Workflow Host');
  await monitor.sample();
  check('Workflow Host is gone', !monitor.alive(chain.wh));
  check('Execution Host survives the Workflow Host', monitor.alive(chain.eh), { pid: chain.eh.pid });
  check('Claude survives the Workflow Host', monitor.alive(chain.claude), { pid: chain.claude.pid });
  check('Electron Main unaffected', monitor.alive(app.main));
  const interrupted = await waitWorkflow(app, 'INTERRUPTED in the UI', (x) => x.displayState === 'INTERRUPTED', 30_000);
  check('UI shows INTERRUPTED with RESUME enabled', interrupted.controls.canResume, { displayState: interrupted.displayState, controls: interrupted.controls });
  await shot(app, 'E-interrupted');
  result.layoutInterrupted = await layoutAudit(app, 'E-interrupted', { detail: true, state: 'Interrupted', interrupted: true, controls: true });
  await monitor.sample();
  const stillRunning = monitor.alive(chain.eh);
  result.executionHostAliveAtResume = stillRunning;
  await clickWhenEnabled(app, 'wf-btn-resume');
  const newWh = await waitRole('workflow-host', app.main, 'new Workflow Host', 60_000);
  result.newWorkflowHost = { pid: newWh.pid, created: newWh.created };
  if (!stillRunning) result.note = 'The execution had already ended before RESUME: the reconciler can only ADOPT (no WATCH window).';
  await recoveryAssertions(app, workflowId, chain, newWh, crashAt);
  result.appExit = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

async function scenarioF(): Promise<void> {
  const app1 = await launch('F-1');
  const workflowId = await startViaUi(app1, SCENARIO_DEFINITION.F);
  const chain = await liveChain(app1);
  recordChain('chain', app1, chain);
  const helpers = monitor.childrenOf(app1.main, 'electron-helper');
  app1.page.close();
  const crashAt = await killOnly(app1.main, 'Electron Main');
  result.mainExit = await Promise.race([app1.exit, sleep(10_000).then(() => null)]);
  // The Workflow Host ends with Main (Windows job, 'with-parent'); wait for that by identity.
  const t0 = Date.now();
  for (;;) {
    await monitor.sample();
    if (!monitor.alive(chain.wh) || Date.now() - t0 > 30_000) break;
    await sleep(1000);
  }
  result.workflowHostGoneWithinMs = Date.now() - t0;
  check('Electron Main is gone', !monitor.alive(app1.main));
  check('Workflow Host ended with Main', !monitor.alive(chain.wh));
  check('Execution Host survives Main', monitor.alive(chain.eh), { pid: chain.eh.pid });
  check('Claude survives Main', monitor.alive(chain.claude), { pid: chain.claude.pid });
  const leftHelpers = helpers.filter((h) => monitor.alive(h));
  check('Electron helper processes ended with Main', leftHelpers.length === 0, leftHelpers.map((h) => h.pid));
  const app2 = await launch('F-2 (relaunch)');
  const interrupted = await waitWorkflow(app2, 'INTERRUPTED after relaunch', (x) => x.workflowId === workflowId, 60_000);
  check('relaunched app shows the workflow INTERRUPTED with RESUME enabled', interrupted.displayState === 'INTERRUPTED' && interrupted.controls.canResume, { displayState: interrupted.displayState, controls: interrupted.controls });
  await shot(app2, 'F-interrupted');
  result.layoutInterrupted = await layoutAudit(app2, 'F-interrupted', { list: true, detail: true, state: 'Interrupted', interrupted: true, controls: true });
  await monitor.sample();
  const stillRunning = monitor.alive(chain.eh);
  result.executionHostAliveAtResume = stillRunning;
  await clickWhenEnabled(app2, 'wf-btn-resume');
  const newWh = await waitRole('workflow-host', app2.main, 'new Workflow Host', 60_000);
  result.newWorkflowHost = { pid: newWh.pid, created: newWh.created, electronMain: { pid: app2.main.pid, created: app2.main.created } };
  if (!stillRunning) result.note = 'The execution had already ended before RESUME: the reconciler can only ADOPT (no WATCH window).';
  await recoveryAssertions(app2, workflowId, chain, newWh, crashAt);
  result.appExit = await quitApp(app2);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

async function scenarioG(): Promise<void> {
  const app = await launch('G');
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.G);
  const chain = await liveChain(app);
  recordChain('chain', app, chain);
  // 1) close → the M5.8.1 quit dialog → "Hủy": nothing changes.
  await closeWindow(app.main.pid);
  const d1 = await waitUntil('quit dialog', () => nativeDialog(app.main.pid), (d) => d.found, 15_000, 500);
  result.quitDialog = d1;
  check('quit dialog shown with "Hủy" and "STOP workflow và thoát"', (d1.buttons ?? []).some((b) => /^H.y$/.test(b)) && (d1.buttons ?? []).some((b) => b.includes('STOP workflow')), d1);
  check('quit dialog says a workflow is running and names PAUSE-first', (d1.texts ?? []).join(' ').includes('workflow') && (d1.texts ?? []).join(' ').includes('PAUSE'), d1.texts);
  const cancel = await nativeDialog(app.main.pid, QUIT_CANCEL);
  check('"Hủy" clicked', typeof cancel.clicked === 'string', cancel);
  await sleep(1500);
  await monitor.sample();
  const after = await wf(app.page);
  const dialogGone = await nativeDialog(app.main.pid);
  check('after "Hủy": dialog closed; app, workflow and execution keep running', !dialogGone.found && monitor.alive(app.main) && after?.state === 'RUNNING' && monitor.alive(chain.eh), { state: after?.state, dialog: dialogGone.found });
  // 2) close → "STOP workflow và thoát": STOP through the WorkflowEngine, then a clean exit.
  app.page.close();
  await closeWindow(app.main.pid);
  await waitUntil('quit dialog (2)', () => nativeDialog(app.main.pid), (d) => d.found, 15_000, 500);
  const t0 = Date.now();
  const stop = await nativeDialog(app.main.pid, QUIT_STOP);
  check('"STOP workflow và thoát" clicked', typeof stop.clicked === 'string' && stop.clicked.includes('STOP'), stop);
  const exit = await Promise.race([app.exit, sleep(180_000).then(() => null)]);
  result.appExit = exit;
  result.quitDurationMs = Date.now() - t0;
  check('application exited cleanly after the STOP', exit !== null && exit.code === 0, exit);
  await monitor.sample();
  const inst = (await instanceFile(workflowId))?.instance;
  const a = inst?.steps?.[0]?.attempts?.[0];
  result.workflowFinal = { state: inst?.state, terminalReason: inst?.terminalReason, attempt: a && pick(a, ['attemptId', 'state', 'executionId', 'stopCause', 'launches']) };
  check('workflow STOPPED (persisted) by the quit', inst?.state === 'STOPPED' && a?.state === 'STOPPED' && a?.stopCause === 'USER', result.workflowFinal);
  const run = await new BridgeEngine(projectPath).status();
  check('the execution is STOPPED in BridgeEngine', run.runId === chain.executionId && run.status === 'STOPPED', { runId: run.runId, status: run.status });
  check('Execution Host and Claude terminated', !monitor.alive(chain.eh) && !monitor.alive(chain.claude));
  const evLog = (await readFile(path.join(aiBridgeDir, 'workflows', 'instances', workflowId, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as WfEvent);
  check('the quit STOP went through the WorkflowEngine (one STOP_REQUESTED event)', evLog.filter((e) => e.type === 'STOP_REQUESTED').length === 1, evLog.map((e) => e.type));
  result.workflowEvents = evLog.map((e) => `${e.seq} ${e.timestamp} ${e.type}${e.type === 'INPUT_RECEIVED' ? `(${String(e.payload.inputType)})` : ''} ${e.actor}`);
  result.runs = await Promise.all((await sessionsList()).map((r) => executionEvidence(r)));
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

/** J4 — "stale workflow snapshot after the execution completed" (J case 4), with the EXISTING
 * mechanism only (the E kill; no crash injection): kill ONLY the Workflow Host while the execution
 * runs, then wait BY STATE (the Execution Host process has exited and BridgeEngine records a
 * terminal status) while no Workflow Host exists. The persisted snapshot still says EXECUTING.
 * RESUME must ADOPT the finished execution — no WATCH, no relaunch, the same executionId. */
async function scenarioJ4(): Promise<void> {
  const app = await launch('J4');
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.J4);
  const chain = await liveChain(app);
  recordChain('chain', app, chain);
  const crashAt = await killOnly(chain.wh, 'Workflow Host');
  await monitor.sample();
  check('Workflow Host is gone', !monitor.alive(chain.wh));
  check('Execution Host survives the Workflow Host', monitor.alive(chain.eh), { pid: chain.eh.pid });
  const deadline = Date.now() + 20 * 60_000;
  while (monitor.alive(chain.eh)) {
    if (Date.now() > deadline) throw new Error('the surviving execution did not finish within 20 minutes');
    await sleep(2000);
    await monitor.sample();
  }
  const whWhileFinishing = monitor.byRole('workflow-host').filter((t) => keyOf(t) !== keyOf(chain.wh));
  check('no Workflow Host existed while the execution finished', whWhileFinishing.length === 0, whWhileFinishing.map((t) => t.pid));
  const run = await new BridgeEngine(projectPath).status();
  result.runAtRest = { runId: run.runId, status: run.status };
  check('the execution finished on its own (terminal in BridgeEngine, same runId)', run.runId === chain.executionId && ['DONE', 'NEED_HUMAN', 'ERROR', 'STOPPED', 'STOPPED_MAX_ITERATIONS'].includes(run.status), result.runAtRest);
  const inst = (await instanceFile(workflowId))?.instance;
  const att = inst?.steps?.[0]?.attempts?.[0];
  result.staleSnapshot = { instance: inst?.state, attempt: att?.state, executionId: att?.executionId };
  check('the persisted workflow snapshot is stale: instance RUNNING, attempt still EXECUTING', inst?.state === 'RUNNING' && att?.state === 'EXECUTING' && att?.executionId === chain.executionId, result.staleSnapshot);
  const interrupted = await waitWorkflow(app, 'INTERRUPTED in the UI', (x) => x.displayState === 'INTERRUPTED', 30_000);
  check('UI shows INTERRUPTED with RESUME enabled', interrupted.controls.canResume, { displayState: interrupted.displayState, controls: interrupted.controls });
  result.layoutInterrupted = await layoutAudit(app, 'J4-interrupted', { detail: true, state: 'Interrupted', interrupted: true, controls: true });
  await clickWhenEnabled(app, 'wf-btn-resume');
  await waitWorkflow(app, 'the workflow at rest after RESUME', (x) => TERMINALISH.includes(x.state), 5 * 60_000);
  await monitor.sample();
  const newWh = monitor.childrenOf(app.main, 'workflow-host').find((t) => keyOf(t) !== keyOf(chain.wh)) ?? null; // may be too short-lived to sample
  result.newWorkflowHost = newWh ? { pid: newWh.pid, created: newWh.created } : 'not sampled (lived < 1 sample interval)';
  await recoveryAssertions(app, workflowId, chain, newWh, crashAt, 'ADOPT_ONLY');
  result.appExit = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

// ---------------------------------------------------------------------------
// J1 / J2 — the TEST-ONLY Workflow Host crash points (B″, docs/59 §23): crash app only
// ---------------------------------------------------------------------------

/** engine.ts's default; the crash app passes no engine override (D3: production recovery timing). */
const PRODUCTION_PREFLIGHT_GRACE_MS = 5 * 60 * 1000;

interface CrashFired {
  pid: number;
  point: string;
  at: string;
}
interface CrashStatusLine {
  pid: number;
  armed: boolean;
  point?: string;
  spent?: boolean;
  reason?: string;
  at: string;
}

async function crashStatusLines(): Promise<CrashStatusLine[]> {
  const text = await readFile(`${crashMarker}.status.jsonl`, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as CrashStatusLine);
}

/** Setup gate: J scenarios run only on a crash app assembled by build-crash-app.ts whose isolation
 * still verifies against the current dist-desktop/ and every packaged release. */
async function crashAppReady(): Promise<boolean> {
  if (!appDir) {
    check('J1/J2 run only on the isolated crash app (--app <dir>); the production and packaged apps carry no crash hook', false, { exe: exe ?? null });
    return false;
  }
  const created = existsSync(path.join(appDir, APP_MARKER));
  const report = await verifyCrashApp(appDir);
  result.crashApp = { dir: path.relative(ROOT, appDir), createdByBuildScript: created, identicalFiles: report.identical.length, differing: report.differing, sentinel: report.sentinel, failures: report.failures };
  check('crash app: assembled by scripts/real/m5.10-crash/build-crash-app.ts', created, appDir);
  check('crash app isolation: every file but dist-desktop/workflow-host.mjs is byte-identical to dist-desktop/; the sentinel only in the crash workflow-host.mjs, none in dist-desktop/ or any release', report.ok, report.failures);
  return created && report.ok;
}

/** The execution-side facts the engine's #facts() gives the reconciler (sessions + RUN_STARTED correlation). */
async function reconcileSessions(): Promise<ReconcileSession[]> {
  const engine = new BridgeEngine(projectPath);
  const out: ReconcileSession[] = [];
  for (const s of await engine.listSessions()) {
    const started = (await engine.getSessionArtifacts(s.runId))?.events.find((e) => e.event === 'RUN_STARTED');
    out.push({ runId: s.runId, startedAt: s.startedAt, status: s.status, iterations: s.iterations, errorCode: s.errorCode, correlation: typeof started?.correlation === 'string' ? started.correlation : null });
  }
  return out;
}

async function runEndedAt(runId: string): Promise<string | null> {
  const evs = (await new BridgeEngine(projectPath).getSessionArtifacts(runId))?.events ?? [];
  return evs.find((e) => e.event === 'RUN_COMPLETED' || e.event === 'RUN_STOPPED')?.timestamp ?? null;
}

const replayFacts = (o: Partial<ReconcileFacts> & Pick<ReconcileFacts, 'nowMs' | 'sessions'>): ReconcileFacts => ({
  preflightGraceMs: PRODUCTION_PREFLIGHT_GRACE_MS,
  current: { runId: null, status: 'NOT_STARTED' },
  recoverable: false,
  hostAlive: null,
  cliAlive: false,
  ...o,
});

/** The workflow exactly as persisted when its Workflow Host died (read after the exit). */
async function persistedAtCrash(workflowId: string): Promise<{ instance: Record<string, any> | undefined; attempt: WorkflowAttempt; events: WfEvent[] }> {
  const instance = (await instanceFile(workflowId))?.instance;
  const evs = (await readFile(path.join(aiBridgeDir, 'workflows', 'instances', workflowId, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as WfEvent);
  return { instance, attempt: instance?.steps?.[0]?.attempts?.[0], events: evs };
}

const START_DIALOG = `(() => { const f = document.querySelector('[data-testid="wf-start-dialog"]'); if (!f) return { open: false, submitting: false, text: null }; return { open: true, submitting: (f.querySelector('[data-testid="wf-start-submit"]')?.textContent ?? '').includes('STARTING'), text: f.innerText.slice(0, 600) }; })()`;
const CLOSE_START_DIALOG = `(() => { const b = document.querySelector('[data-testid="wf-start-dialog"] .modal-actions button[type="button"]'); if (!b) return false; b.click(); return true; })()`;
const notStartedShown = (w: WfSnap) => w.recovery.some((r) => r.kind === 'FINDING' && r.finding === 'NOT_STARTED');

/** J1 — crash after the durable launch intent (ATTEMPT_LAUNCHING committed, task.md written), before
 * ExecutionPort.start() reaches spawnHost(): no Execution Host, no session, no hostPid. RESUME: the
 * real reconciler must WAIT out the production preflight grace (≈ 5 min: nothing proves sooner that
 * no execution is starting) and find NOT_STARTED; the SAME attempt is relaunched.
 * `real` (J1, quota): the relaunch runs → exactly one execution. J1-zero: the relaunch is refused by
 * the real preflight (Claude not authenticated) → no execution at all. */
async function scenarioJ1(real: boolean): Promise<void> {
  const app = await launch(scenario);
  await submitStartDialog(app, SCENARIO_DEFINITION[scenario], false);
  const fired = (await waitUntil('the J1 crash point to fire (marker)', () => readJson<CrashFired>(crashMarker), (f) => f !== null, 120_000, 500))!;
  log(`crash point fired: ${JSON.stringify(fired)}`);
  await waitUntil('the crashed Workflow Host to exit', async () => (await monitor.sample()).some((p) => p.pid === fired.pid && /workflow-host\.mjs/i.test(p.cmd)), (alive) => !alive, 30_000, 1000);
  // The start request races the crash: Main may or may not have had 'accepted' before the exit.
  const dialog = await waitUntil('the start dialog to settle', () => app.page.eval<{ open: boolean; submitting: boolean; text: string | null }>(START_DIALOG), (d) => !d.open || !d.submitting, 60_000, 500);
  result.startOutcome = dialog.open ? { acceptedBeforeCrash: false, dialog: dialog.text } : { acceptedBeforeCrash: true };
  if (dialog.open) {
    await shot(app, `${scenario}-start-dialog-after-crash`);
    await app.page.eval(CLOSE_START_DIALOG);
  }
  const ids = await new WorkflowStore(aiBridgeDir).list();
  check('exactly one workflow instance was created', ids.length === 1, ids);
  const workflowId = ids[0];
  const crash = await persistedAtCrash(workflowId);
  const attempt = crash.attempt;
  const statusAtCrash = await crashStatusLines();
  await monitor.sample();
  result.crash = {
    fired,
    statusLines: statusAtCrash,
    workflowHostSampled: monitor.byRole('workflow-host').some((t) => t.pid === fired.pid),
    instance: crash.instance?.state,
    attempt: attempt && pick(attempt as unknown as Record<string, unknown>, ['attemptId', 'state', 'launches', 'executionId', 'hostPid', 'launchedAt']),
  };
  check('J1 fired at BEFORE_EXECUTION_HOST_FORK in the one Workflow Host this run armed', fired.point === 'BEFORE_EXECUTION_HOST_FORK' && statusAtCrash.length === 1 && statusAtCrash[0].pid === fired.pid && statusAtCrash[0].armed && statusAtCrash[0].spent === false, { fired, statusAtCrash });
  check('Electron Main unaffected', monitor.alive(app.main));
  check('durable: the launch intent — instance RUNNING, attempt LAUNCHING, launches 1, one ATTEMPT_LAUNCHING', crash.instance?.state === 'RUNNING' && attempt?.state === 'LAUNCHING' && attempt.launches === 1 && crash.events.filter((e) => e.type === 'ATTEMPT_LAUNCHING').length === 1, result.crash);
  check('durable: the attempt task.md', !!attempt && existsSync(path.join(aiBridgeDir, 'workflows', 'instances', workflowId, 'attempts', `${attempt.stepId}-${attempt.attemptNo}`, 'task.md')));
  check('not durable: no hostPid, no EXECUTION_HOST_SPAWNED, no executionId', (attempt?.hostPid ?? null) === null && attempt?.executionId === null && inputsOf(crash.events, 'EXECUTION_HOST_SPAWNED').length === 0, result.crash);
  const forkedByCrashed = monitor.latest.filter((p) => p.ppid === fired.pid && /run-host\.mjs/i.test(p.cmd));
  const sessionsAtCrash = await sessionsList();
  check('no Execution Host was forked and no session exists', monitor.byRole('execution-host').length === 0 && forkedByCrashed.length === 0 && sessionsAtCrash.length === 0, { executionHosts: monitor.byRole('execution-host').map((t) => t.pid), forkedByCrashed: forkedByCrashed.map((p) => p.pid), sessions: sessionsAtCrash });

  const interrupted = await waitWorkflow(app, 'INTERRUPTED in the UI', (x) => x.workflowId === workflowId && x.displayState === 'INTERRUPTED', 60_000);
  check('UI shows INTERRUPTED with RESUME enabled', interrupted.controls.canResume, { displayState: interrupted.displayState, controls: interrupted.controls });
  await shot(app, `${scenario}-interrupted`);
  result.layoutInterrupted = await layoutAudit(app, `${scenario}-interrupted`, { detail: true, state: 'Interrupted', interrupted: true, controls: true });
  await clickWhenEnabled(app, 'wf-btn-resume');
  const newWh = await waitRole('workflow-host', app.main, 'new Workflow Host', 60_000);
  result.newWorkflowHost = { pid: newWh.pid, created: newWh.created };
  log(`waiting for the reconciler: production preflight grace ${PRODUCTION_PREFLIGHT_GRACE_MS / 1000} s from launchedAt ${attempt.launchedAt}`);
  const findings = (evs: WfEvent[]) => evs.filter((e) => e.type === 'RECONCILED' && typeof e.payload.finding === 'string');
  const decision = (await waitUntil('the reconciler decision', async () => findings(await events(app.page, workflowId)), (f) => f.length > 0, PRODUCTION_PREFLIGHT_GRACE_MS + 5 * 60_000, 5000))[0];

  // The persisted decision vs the real reconciler over the evidence of that moment: the sessions
  // started by then, and no hostPid (checked above) → hostAlive unknown (null).
  const sessionsThen = (await reconcileSessions()).filter((s) => s.startedAt !== null && s.startedAt <= decision.timestamp);
  const replay = reconcileAttempt(attempt, replayFacts({ nowMs: Date.parse(decision.timestamp), sessions: sessionsThen }));
  const waitedMs = Date.parse(decision.timestamp) - Date.parse(attempt.launchedAt!);
  result.reconciler = { decision: { seq: decision.seq, timestamp: decision.timestamp, payload: decision.payload }, waitedMsSinceLaunch: waitedMs, sessionsThen: sessionsThen.map((s) => s.runId), replayed: replay };
  check('the persisted decision = the real reconciler’s decision for the evidence of that moment (replayed through reconcileAttempt)', replay.action === 'FINDING' && replay.finding.kind === decision.payload.finding, result.reconciler);
  check('D3: the production preflight grace elapsed before the decision (no shortened recovery timing)', waitedMs >= PRODUCTION_PREFLIGHT_GRACE_MS, { waitedMs, graceMs: PRODUCTION_PREFLIGHT_GRACE_MS });

  const w = await waitWorkflow(app, real ? 'COMPLETED' : 'at rest after the relaunch', (x) => TERMINALISH.includes(x.state), real ? 20 * 60_000 : 5 * 60_000);
  log(`after recovery: ${w.state}`);
  await monitor.sample();
  const ev = await workflowEvidence(app, workflowId);
  result.workflow = ev;
  const a = (ev.attempts as any[])[0];
  const statusLines = await crashStatusLines();
  check('the new Workflow Host was armed but spent: the one-shot marker kept it from crashing again', statusLines.length === 2 && statusLines[1].pid === newWh.pid && statusLines[1].armed && statusLines[1].spent === true && (await readJson<CrashFired>(crashMarker))?.pid === fired.pid, statusLines);
  check('relaunch of the SAME attempt: one attempt, same attemptId, launches 2, two ATTEMPT_LAUNCHING', (ev.attempts as any[]).length === 1 && a.attemptId === attempt.attemptId && a.launches === 2 && ev.eventTypeCounts.ATTEMPT_LAUNCHING === 2, { attempts: ev.attempts, launching: ev.eventTypeCounts.ATTEMPT_LAUNCHING });
  const ehs = monitor.byRole('execution-host');
  check('exactly one Execution Host in the whole scenario: forked by the new Workflow Host, after the decision', ehs.length === 1 && ehs[0].parentKey === keyOf(newWh) && Date.parse(ehs[0].created) >= Date.parse(decision.timestamp) && (ev.hostSpawned as any[]).length === 1 && (ev.hostSpawned as any[])[0].hostPid === ehs[0].pid, { executionHosts: ehs.map((t) => ({ pid: t.pid, created: t.created, parentKey: t.parentKey })), hostSpawned: ev.hostSpawned, decidedAt: decision.timestamp });
  check('UI recovery section shows the NOT_STARTED finding', notStartedShown(w), w.recovery);
  if (real) {
    check('workflow COMPLETED', ev.state === 'COMPLETED', { state: ev.state, terminalReason: ev.terminalReason });
    const runs = ev.runs as any[];
    check('exactly ONE execution: one session, linked to the attempt, RUN_STARTED correlation = attemptId (ADR-017)', runs.length === 1 && a.executionId === runs[0].runId && runs[0].runStartedCorrelation === attempt.attemptId, runs.map((r) => ({ runId: r.runId, correlation: r.runStartedCorrelation })));
    const claudeSessions = new Set(runs.flatMap((r) => r.calls.filter((c: CallRecord) => c.agent === 'claude').map((c: CallRecord) => c.sessionId)));
    check('one Claude session; every Claude process is a child of the one Execution Host', claudeSessions.size === 1 && ehs.length === 1 && monitor.byRole('claude').every((t) => t.parentKey === keyOf(ehs[0])), { claudeSessions: [...claudeSessions], claude: monitor.byRole('claude').map((t) => t.pid) });
    aiAttestedChecks(ev);
    result.artifacts = await artifactChecks('J1 (the relaunched execution’s work)', [A_ARTIFACT]);
    const u = await captureUi(app, scenario);
    result.ui = u;
    result.layoutRecovered = await layoutAudit(app, `${scenario}-recovered`, { detail: true, state: 'Completed', recovery: true, journal: true });
    uiChecks(u, workflowId, ev);
    result.journal = await journalChecks(app, workflowId, ev);
  } else {
    check('the relaunch reached the real preflight, which refused (Claude not authenticated): BLOCKED, no session, no CLI', ev.state === 'BLOCKED' && (ev.runs as any[]).length === 0 && monitor.byRole('claude').length === 0 && monitor.byRole('codex').length === 0, { state: ev.state, terminalReason: ev.terminalReason, runs: (ev.runs as any[]).length });
    result.uiBlocked = await captureUi(app, `${scenario}-blocked`);
    if (w.controls.canStop) {
      await clickAndConfirm(app, 'wf-btn-stop', 'STOP workflow?');
      await waitWorkflow(app, 'STOPPED', (x) => x.state === 'STOPPED', 60_000);
    }
  }
  result.appExit = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

/** J2 — crash when the Execution Host's RUN_STARTED reaches the Workflow Host, before the engine
 * commits EXECUTION_LINKED: the Execution Host ('independent') and its Claude CLI survive; the run is
 * RUNNING with the attempt's correlation. RESUME: the real reconciler LINKs the SAME execution, then
 * WATCHes/ADOPTs it as the evidence dictates — never a second execution. Quota (real CLIs). */
async function scenarioJ2(): Promise<void> {
  const app = await launch('J2');
  const workflowId = await startViaUi(app, SCENARIO_DEFINITION.J2);
  const wh = await waitRole('workflow-host', app.main, 'Workflow Host', 60_000);
  const fired = (await waitUntil('the J2 crash point to fire (marker)', () => readJson<CrashFired>(crashMarker), (f) => f !== null, 10 * 60_000, 500))!;
  log(`crash point fired: ${JSON.stringify(fired)}`);
  await waitUntil('the crashed Workflow Host to exit', async () => (await monitor.sample(), monitor.alive(wh)), (alive) => !alive, 30_000, 1000);
  const crash = await persistedAtCrash(workflowId);
  const attempt = crash.attempt;
  // The Execution Host: sampled as the Workflow Host's child, or — if the Workflow Host died before a
  // sample saw it — the process of the persisted hostPid whose parent was that Workflow Host.
  let eh = monitor.childrenOf(wh, 'execution-host')[0] ?? null;
  if (!eh && typeof attempt?.hostPid === 'number') {
    const p = monitor.latest.find((x) => x.pid === attempt.hostPid && x.ppid === wh.pid && /run-host\.mjs/i.test(x.cmd));
    if (p) eh = monitor.addRoot(p, 'execution-host');
  }
  if (!eh) throw new Error('the Execution Host of the crashed Workflow Host was not found');
  const claude = await waitRole('claude', eh, 'Claude CLI (under the surviving Execution Host)', 180_000);
  const run = await new BridgeEngine(projectPath).status();
  const runId = run.runId;
  const execution = runId ? await executionEvidence(runId) : null;
  const statusAtCrash = await crashStatusLines();
  result.crash = {
    fired,
    statusLines: statusAtCrash,
    instance: crash.instance?.state,
    attempt: attempt && pick(attempt as unknown as Record<string, unknown>, ['attemptId', 'state', 'launches', 'executionId', 'hostPid', 'launchedAt']),
    run: { runId, status: run.status, runStartedCorrelation: execution?.runStartedCorrelation ?? null },
  };
  check('J2 fired at ON_RUN_STARTED_BEFORE_LINK in the one Workflow Host this run armed', fired.point === 'ON_RUN_STARTED_BEFORE_LINK' && fired.pid === wh.pid && statusAtCrash.length === 1 && statusAtCrash[0].pid === wh.pid && statusAtCrash[0].armed && statusAtCrash[0].spent === false, { fired, statusAtCrash });
  check('Electron Main unaffected', monitor.alive(app.main));
  check('not durable: EXECUTION_LINKED never committed — attempt LAUNCHING, no executionId', attempt?.state === 'LAUNCHING' && attempt.executionId === null && inputsOf(crash.events, 'EXECUTION_LINKED').length === 0, result.crash);
  check('the Execution Host and its Claude CLI survive the Workflow Host', monitor.alive(eh) && monitor.alive(claude), { executionHost: eh.pid, claude: claude.pid });
  check('durable on the execution side: the run is RUNNING and its RUN_STARTED carries the attemptId (ADR-017)', runId !== null && run.status === 'RUNNING' && execution?.runStartedCorrelation === attempt?.attemptId, result.crash);
  if (runId === null) throw new Error('no execution run exists after the J2 crash');

  const interrupted = await waitWorkflow(app, 'INTERRUPTED in the UI', (x) => x.displayState === 'INTERRUPTED', 60_000);
  check('UI shows INTERRUPTED with RESUME enabled', interrupted.controls.canResume, { displayState: interrupted.displayState, controls: interrupted.controls });
  await shot(app, 'J2-interrupted');
  result.layoutInterrupted = await layoutAudit(app, 'J2-interrupted', { detail: true, state: 'Interrupted', interrupted: true, controls: true });
  await monitor.sample();
  result.executionHostAliveAtResume = monitor.alive(eh);
  await clickWhenEnabled(app, 'wf-btn-resume');
  const newWh = await waitRole('workflow-host', app.main, 'new Workflow Host', 60_000);
  result.newWorkflowHost = { pid: newWh.pid, created: newWh.created };
  await waitWorkflow(app, 'the workflow at rest after RESUME', (x) => TERMINALISH.includes(x.state), 20 * 60_000);

  // Every reconciler decision the new Workflow Host persisted, replayed through the real reconciler
  // over the evidence of its moment.
  const evs = await events(app.page, workflowId);
  const inputEvents = (t: string) => evs.filter((e) => e.type === 'INPUT_RECEIVED' && e.payload.inputType === t);
  const sessionsNow = await reconcileSessions();
  const finalSession = sessionsNow.find((s) => s.runId === runId);
  const endedAt = await runEndedAt(runId);
  // 1. LINK — over the LAUNCHING attempt and the sessions started by then.
  const linked = inputEvents('EXECUTION_LINKED');
  const linkAt = linked[0]?.timestamp;
  const ehAliveAt = (iso: string) => eh.goneAt === null || Date.parse(eh.goneAt) > Date.parse(iso);
  const linkReplay = linkAt ? reconcileAttempt(attempt, replayFacts({ nowMs: Date.parse(linkAt), sessions: sessionsNow.filter((s) => s.startedAt !== null && s.startedAt <= linkAt), hostAlive: typeof attempt.hostPid === 'number' ? ehAliveAt(linkAt) : null })) : null;
  const linkedTo = linked[0] ? (JSON.parse(String(linked[0].payload.input)) as { executionId?: string }).executionId : null;
  check('LINK: exactly one EXECUTION_LINKED, to the SAME execution — the real reconciler’s decision (replayed)', linked.length === 1 && linkedTo === runId && isDeepStrictEqual(linkReplay, { action: 'LINK', executionId: runId }), { linked: linked.length, linkedTo, linkReplay });
  // 2. WATCH (persisted only while the run was running) — over the run's status at that moment.
  const linkedAttempt: WorkflowAttempt = { ...attempt, state: 'EXECUTING', executionId: runId };
  const watch = evs.find((e) => e.type === 'RECONCILED' && e.payload.finding === 'WATCH') ?? null;
  let watchReplay = null;
  if (watch && finalSession) {
    const status = endedAt === null || Date.parse(endedAt) > Date.parse(watch.timestamp) ? 'RUNNING' : finalSession.status;
    watchReplay = reconcileAttempt(linkedAttempt, replayFacts({ nowMs: Date.parse(watch.timestamp), current: { runId, status }, sessions: [{ ...finalSession, status }] }));
  }
  check('WATCH (if persisted) — the real reconciler’s decision for the run’s status at that moment (replayed)', watch === null || isDeepStrictEqual(watchReplay, { action: 'FINDING', finding: { kind: 'WATCH', executionId: runId } }), { watch: watch && { seq: watch.seq, timestamp: watch.timestamp }, runEndedAt: endedAt, watchReplay });
  // 3. ADOPT — over the run's final facts.
  const ended = inputEvents('EXECUTION_ENDED');
  const adoptedResult = ended.length === 1 ? (JSON.parse(String(ended[0].payload.input)) as { result?: unknown }).result : null;
  const now = await new BridgeEngine(projectPath).status();
  const adoptReplay = finalSession ? reconcileAttempt(linkedAttempt, replayFacts({ nowMs: Date.now(), current: { runId: now.runId, status: now.status }, sessions: [finalSession] })) : null;
  check('ADOPT: exactly one EXECUTION_ENDED — the real reconciler’s ADOPT of the run’s final facts (replayed)', ended.length === 1 && isDeepStrictEqual(adoptReplay, { action: 'ADOPT', result: adoptedResult }), { adoptedResult, adoptReplay });
  result.reconciler = { linkAt, linkReplay, watch: watch && { seq: watch.seq, timestamp: watch.timestamp, replayed: watchReplay }, adoptReplay, runEndedAt: endedAt };

  const chain: Chain = { wh, eh, claude, executionId: runId, attemptId: attempt.attemptId };
  recordChain('chain', app, chain);
  await recoveryAssertions(app, workflowId, chain, newWh, fired.at, watch ? 'WATCH_THEN_ADOPT' : 'ADOPT_ONLY');
  result.appExit = await quitApp(app);
  result.processes = monitor.summary();
  result.cleanup = await orphanCheck();
}

/** Zero quota, no app: the M5.10 test data through the production validator/dry-run and the
 * app's own definition loader, plus the properties the real scenarios depend on. */
async function scenarioDefinitions(): Promise<void> {
  const plans: Record<string, any> = {};
  for (const [id, raw] of Object.entries(DEFINITIONS)) {
    const plan = dryRunWorkflow(raw, {});
    const loaded = await loadWorkflowDefinition(aiBridgeDir, id);
    check(`definition ${id}: valid for M5 (validator + dry run)`, plan.ok, plan.ok ? plan.definitionHash : plan.errors);
    check(`definition ${id}: the app's loader accepts the file with the same hash`, plan.ok && loaded.ok && loaded.definitionHash === plan.definitionHash, loaded.ok ? loaded.definitionHash : loaded.error);
    if (plan.ok) plans[id] = plan;
  }
  result.definitions = Object.fromEntries(Object.entries(plans).map(([id, p]) => [id, { hash: p.definitionHash, steps: p.steps.map((s: any) => ({ stepId: s.stepId, outputs: s.outputs, taskPreview: s.taskPreview })) }]));
  const a = plans['m510-minimal']?.steps?.[0]?.taskPreview ?? '';
  check('A: the task asks for exactly the artifact the driver checks (path + content)', a.includes(A_ARTIFACT.path) && a.includes(A_ARTIFACT.content), a);
  const [b1, b2] = plans['m510-two-step']?.steps ?? [];
  check('B: step 1 declares the output report.summary', !!b1 && b1.outputs.includes('report.summary'), b1?.outputs);
  check('B: step 1 task asks for the step-1 artifact and to state it in SUMMARY', !!b1 && b1.taskPreview.includes(B_STEP1.path) && b1.taskPreview.includes('SUMMARY'), b1?.taskPreview);
  check("B: step 2 task gets step 1's output as a labelled STEP OUTPUT block (the M5 step-planner)", !!b2 && b2.taskPreview.includes('--- BEGIN STEP OUTPUT write-token report.summary ---'), b2?.taskPreview);
  check('B: step 2 task never names the fixture or the token (it can only get them from step 1)', !!b2 && !b2.taskPreview.includes('fixtures/sample.txt') && !b2.taskPreview.includes(B_STEP1.content), b2?.taskPreview);
  check("B: step 2 task asks for the step-2 artifact built from step 1's file", !!b2 && b2.taskPreview.includes(B_STEP2.path) && b2.taskPreview.includes(B_STEP1.path), b2?.taskPreview);
  const c = plans['m510-pause']?.steps?.[0];
  check('C: the pause task is a single step with maxIterations ≥ 2 (a pause needs an iteration boundary)', !!c && c.maxIterations >= 2 && c.taskPreview.includes(C_DONE.path), c && { maxIterations: c.maxIterations });
}

// ---------------------------------------------------------------------------

async function providerReadiness(): Promise<Record<string, unknown>> {
  const d = (await new BridgeEngine(projectPath).doctor()) as { overall?: string; checks?: { name: string; status: string }[] };
  const status = (n: string) => d.checks?.find((c) => c.name === n)?.status ?? null;
  return { overall: d.overall ?? null, claudeCli: status('claude-cli'), claudeAuth: status('claude-auth'), codexCli: status('codex-cli'), codexAuth: status('codex-auth') };
}

async function main(): Promise<void> {
  await mkdir(resultsDir, { recursive: true });
  await setupProject();
  if (scenario === 'definitions') {
    await scenarioDefinitions();
    return;
  }
  const crashPoint = CRASH_SCENARIOS[scenario];
  if (crashPoint) {
    if (!(await crashAppReady())) return;
    appEnv = { [CRASH_ENV]: crashPoint, [MARKER_ENV]: crashMarker };
  } else if (scenario === 'preflight' && !appDir) {
    // Build isolation (4): the production/packaged app gets a fully valid crash configuration and
    // must ignore it — its workflow-host.mjs contains no crash hook.
    appEnv = { [CRASH_ENV]: 'BEFORE_EXECUTION_HOST_FORK', [MARKER_ENV]: crashMarker };
  }
  if (Object.keys(appEnv).length > 0) log('TEST-ONLY crash configuration in the app environment:', appEnv);
  result.providers = await providerReadiness();
  log('provider readiness (doctor, zero quota):', result.providers);
  const claudeReady = (result.providers as { claudeAuth?: string }).claudeAuth === 'PASS';
  const zeroQuota = ZERO_QUOTA.includes(scenario);
  if (!zeroQuota && !claudeReady) {
    check('providers ready for a real-provider scenario', false, result.providers);
    return;
  }
  // The zero-quota scenarios rely on the preflight REFUSING. With Claude authenticated they would
  // start a real execution (quota) and then fail their own assertions.
  if (zeroQuota && claudeReady) {
    check(`${scenario} is zero-quota only: refused because Claude is authenticated (it would start a real execution)`, false, result.providers);
    return;
  }
  monitor.start();
  try {
    const run = { preflight: scenarioPreflight, A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE, F: scenarioF, G: scenarioG, J1: () => scenarioJ1(true), 'J1-zero': () => scenarioJ1(false), J2: scenarioJ2, J4: scenarioJ4 }[scenario];
    await run();
    if (scenario === 'preflight' && !appDir) {
      const status = await crashStatusLines();
      check('production app: the armed TEST-ONLY crash configuration is inert — no marker, no status line (the chain forked normally, above)', !existsSync(crashMarker) && status.length === 0, { marker: existsSync(crashMarker), statusLines: status });
    }
  } catch (err) {
    check('scenario completed without a harness error', false, err instanceof Error ? err.message : String(err));
    await monitor.sample().catch(() => undefined);
    result.processes = monitor.summary();
    result.aliveAfterError = [...monitor.tracked.values()].filter((t) => monitor.alive(t)).map((t) => ({ role: t.role, pid: t.pid, created: t.created }));
  } finally {
    monitor.stop();
  }
}

try {
  await main();
} finally {
  result.endedAt = nowIso();
  result.checks = checks;
  const failed = checks.filter((c) => !c.ok).length;
  result.summary = `${checks.length - failed}/${checks.length} checks passed`;
  await writeFile(path.join(resultsDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(path.join(resultsDir, 'log.txt'), `${logLines.join('\n')}\n`);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  log(`\n${result.summary} — ${path.relative(ROOT, resultsDir)}`);
  process.exitCode = failed === 0 ? 0 : 1;
}
