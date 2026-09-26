import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { checkEnvForApiKeys, parseClaudeAuthStatus, parseCodexLoginStatus } from './cost-guard.ts';
import { resolveExecutable } from './preflight/executable-resolver.ts';
import { runDoctorChecks, type DoctorCheckOutcome, type DoctorReport } from './preflight/doctor.ts';
import { checkGitStatus } from './preflight/git-safety.ts';
import { runProcess, killProcessTree } from '../automation/process-runner.ts';
import { SessionManager } from './session-manager/session-manager.ts';
import { ClaudeCodeCliAdapter } from '../adapters/claude/claude-code-cli-adapter.ts';
import { CodexCliAdapter } from '../adapters/chatgpt/codex-cli-adapter.ts';
import { Orchestrator, CRASH_POINTS, type LogEntry, type OrchestratorState, type OrchestratorFinalStatus, type CrashPoint } from './orchestrator/orchestrator.ts';
import { appendLogLine } from './logger/logger.ts';
import { acquireLock, releaseLock } from './lock/run-lock.ts';
import { loadConfig, validateConfig, type AiBridgeConfig } from './config/config.ts';
import { requestStop } from './process-manager/process-manager.ts';
import { appendEvent, formatHumanLogLine, rotateIfOversized, type BridgeEvent } from './observability/events.ts';
import { AtomicJsonWriter } from './state-manager/atomic-json-writer.ts';
import { decideRecoveryStrategy, type ResumeState } from './recovery/recovery.ts';
import { describeAgentActivity, type AgentActivity } from './status/agent-activity.ts';
import {
  isValidRunId,
  listSessions,
  readEventLog,
  readSessionArtifacts,
  type CurrentSessionInfo,
  type SessionArtifacts,
  type SessionSummary,
} from './session-history/session-history.ts';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Preflight (doctor)
// ---------------------------------------------------------------------------

export interface Preflight {
  report: DoctorReport;
  claudeExe: string | null;
  codexExe: string | null;
  config: AiBridgeConfig;
  configErrors: string[];
  gitWarning: string | null;
}

async function realWhereDep(name: string): Promise<string[]> {
  const { stdout } = await execFileAsync('where', [name]);
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function realGlobCodexBinDep(): Promise<string[]> {
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  const dirs = await readdir(base).catch(() => [] as string[]);
  const withTimes = await Promise.all(
    dirs.map(async (d) => {
      const p = path.join(base, d, 'codex.exe');
      const s = await stat(p).catch(() => null);
      return s ? { p, t: s.mtimeMs } : null;
    }),
  );
  return withTimes
    .filter((x): x is { p: string; t: number } => x !== null)
    .sort((a, b) => b.t - a.t)
    .map((x) => x.p);
}

function realIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function realAttemptGracefulStop(pid: number): Promise<void> {
  // Windows headless console processes generally ignore this (no real signal delivery
  // across processes) — it's a best-effort attempt before the force-kill fallback.
  // Documented limitation: see docs/06-recovery-design.md.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already dead
    }
  }
}

async function realClaudeAuthCheck(claudeExe: string): Promise<DoctorCheckOutcome> {
  const r = await runProcess({ command: claudeExe, args: ['auth', 'status'], timeoutMs: 15000 });
  if (r.exitCode !== 0) return { status: 'FAIL', detail: `"claude auth status" exited ${r.exitCode}` };
  const auth = parseClaudeAuthStatus(r.stdout);
  if (auth.authMode === 'subscription') return { status: 'PASS', detail: 'logged in with a Claude subscription' };
  if (auth.authMode === 'api-key') return { status: 'BLOCKED', detail: 'logged in via Console/API key — this would bill an API key. Run: claude auth login --claudeai' };
  if (auth.authMode === 'none') return { status: 'FAIL', detail: 'not logged in. Run: claude auth login --claudeai' };
  return { status: 'UNKNOWN', detail: `unrecognized "claude auth status" output: ${r.stdout.slice(0, 200)}` };
}

async function realCodexAuthCheck(codexExe: string): Promise<DoctorCheckOutcome> {
  const r = await runProcess({ command: codexExe, args: ['login', 'status'], timeoutMs: 15000 });
  const auth = parseCodexLoginStatus(r.stdout || r.stderr);
  if (auth.authMode === 'chatgpt') return { status: 'PASS', detail: 'logged in using ChatGPT' };
  if (auth.authMode === 'api-key') return { status: 'BLOCKED', detail: 'logged in via API key — this would bill an API key. Run: codex login' };
  if (auth.authMode === 'none') return { status: 'FAIL', detail: 'not logged in. Run: codex login' };
  return { status: 'UNKNOWN', detail: `unrecognized "codex login status" output: ${(r.stdout || r.stderr).slice(0, 200)}` };
}

async function realRunDoctor(projectPath: string): Promise<Preflight> {
  const p = enginePaths(projectPath);
  const claudeExe = await resolveExecutable('claude', { where: realWhereDep });
  const codexExe = await resolveExecutable('codex', { where: realWhereDep, globCodexBin: realGlobCodexBinDep });
  const { config, errors: configErrors } = await loadConfig(p.configPath, { readFile: (f) => readFile(f, 'utf8') });
  const git = await checkGitStatus(projectPath, {
    runGit: async (args, cwd) => {
      const r = await runProcess({ command: 'git', args, cwd, timeoutMs: 15000 });
      return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr };
    },
  });

  const report = await runDoctorChecks([
    { name: 'node', run: async () => ({ status: 'PASS', detail: process.version }) },
    {
      name: 'api-key-env',
      run: async () => {
        const c = checkEnvForApiKeys(process.env);
        return c.blocked ? { status: 'BLOCKED', detail: `cost-risk env vars set: ${c.foundKeys.join(', ')}` } : { status: 'PASS', detail: 'no cost-risk env vars set' };
      },
    },
    { name: 'claude-cli', run: async () => (claudeExe ? { status: 'PASS', detail: claudeExe } : { status: 'FAIL', detail: 'claude not found on PATH' }) },
    { name: 'claude-auth', run: async () => (claudeExe ? realClaudeAuthCheck(claudeExe) : { status: 'UNKNOWN', detail: 'skipped: claude not found' }) },
    {
      name: 'codex-cli',
      run: async () => (codexExe ? { status: 'PASS', detail: codexExe } : { status: 'FAIL', detail: 'codex not found on PATH or under %LOCALAPPDATA%\\OpenAI\\Codex\\bin' }),
    },
    { name: 'codex-auth', run: async () => (codexExe ? realCodexAuthCheck(codexExe) : { status: 'UNKNOWN', detail: 'skipped: codex not found' }) },
    {
      name: 'git',
      run: async () => {
        const r = await runProcess({ command: 'git', args: ['--version'], timeoutMs: 10000 });
        return r.exitCode === 0 ? { status: 'PASS', detail: r.stdout.trim() } : { status: 'FAIL', detail: 'git not found' };
      },
    },
    {
      name: 'project-directory',
      run: async () => {
        const s = await stat(projectPath).catch(() => null);
        return s?.isDirectory() ? { status: 'PASS', detail: projectPath } : { status: 'FAIL', detail: `project path does not exist: ${projectPath}` };
      },
    },
    {
      name: 'config',
      run: async () => (configErrors.length === 0 ? { status: 'PASS', detail: '.ai-bridge/config.json valid (or using defaults)' } : { status: 'FAIL', detail: configErrors.join('; ') }),
    },
    {
      name: 'git-repository',
      run: async () => {
        if (git.warning === 'WARNING_NOT_GIT_REPOSITORY') return { status: config.requireGitRepository ? 'FAIL' : 'WARNING', detail: 'WARNING_NOT_GIT_REPOSITORY' };
        if (git.warning === 'WARNING_UNCOMMITTED_CHANGES') return { status: config.stopOnUncommittedChanges ? 'FAIL' : 'WARNING', detail: 'WARNING_UNCOMMITTED_CHANGES' };
        return { status: 'PASS', detail: 'clean working tree' };
      },
    },
  ]);

  return { report, claudeExe, codexExe, config, configErrors, gitWarning: git.warning };
}

// ---------------------------------------------------------------------------
// Shared paths
// ---------------------------------------------------------------------------

function enginePaths(projectPath: string) {
  const aiBridgeDir = path.join(projectPath, '.ai-bridge');
  return {
    aiBridgeDir,
    configPath: path.join(aiBridgeDir, 'config.json'),
    lockPath: path.join(aiBridgeDir, 'state', 'lock'),
    stateFile: path.join(aiBridgeDir, 'state', 'current-session.json'),
    eventsPath: path.join(aiBridgeDir, 'logs', 'events.jsonl'),
    humanLogPath: path.join(aiBridgeDir, 'logs', 'ai-bridge.log'),
    pauseRequestPath: path.join(aiBridgeDir, 'state', 'pause-request'),
  };
}

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface BridgeEngineDeps {
  /** Full preflight override — defaults to the real doctor (real `where`, real auth
   * checks, real git status). Tests supply a fake one instead of faking each of its
   * inner parts individually; doctor's own internals are already exhaustively unit
   * tested (doctor.test.ts, executable-resolver.test.ts, cost-guard.test.ts). */
  runDoctor?: (projectPath: string) => Promise<Preflight>;
  isPidAlive?: (pid: number) => boolean;
  attemptGracefulStop?: (pid: number) => Promise<void>;
  /** Test-only: prefixes the claude/codex adapter's command with a fake-CLI script path
   * (e.g. `[FAKE_CLAUDE]`), so `executable` (from doctor) can stay `process.execPath`.
   * Defaults to `[]` — production behaviour is unchanged when omitted. */
  claudeCommandArgsPrefix?: string[];
  codexCommandArgsPrefix?: string[];
  /** Test-only: extra env vars passed to the Claude/Codex child process (e.g.
   * `FAKE_CLAUDE_MODE`). Defaults to unset — production behaviour is unchanged. */
  claudeEnv?: NodeJS.ProcessEnv;
  codexEnv?: NodeJS.ProcessEnv;
}

export interface BridgeStartOptions {
  task: string;
  maxIterations?: number;
  /** Test-only pass-through to Orchestrator's real crash-injection mechanism — see
   * docs/06-recovery-design.md. Never set by production callers. */
  crashInjection?: { at: CrashPoint; onTrigger: () => void };
}

export type BridgeRunOutcome =
  | { kind: 'BLOCKED_PREFLIGHT'; doctorReport: DoctorReport }
  | { kind: 'ALREADY_RUNNING'; pid: number; doctorReport: DoctorReport }
  | { kind: 'NO_STATE' }
  | { kind: 'RECOVERY_BLOCKED'; reason: string; doctorReport: DoctorReport }
  | {
      kind: 'COMPLETED';
      finalStatus: OrchestratorFinalStatus;
      errorCode: string | null;
      errorMessage: string | null;
      iterations: number;
      sessionDir: string;
      claudeSessionId: string | null;
      codexThreadId: string | null;
      doctorReport: DoctorReport;
    };

export type BridgePauseOutcome = { kind: 'NOT_RUNNING' } | { kind: 'PAUSED' } | { kind: 'STILL_RUNNING' } | { kind: 'ENDED_BEFORE_PAUSE'; finalStatus: string };

export type BridgeStopOutcome = { kind: 'NOT_RUNNING' } | { kind: 'STOPPED'; reason: 'GRACEFUL_STOP' | 'FORCE_KILLED' | 'STOP_FAILED'; ok: boolean };

export type BridgeResetOutcome = { kind: 'REFUSED_RUNNING'; pid: number } | { kind: 'RESET' };

/** What `resume()` would do right now, decided by the exact same logic `resume()`
 * itself uses — without acquiring a lock, running doctor, or starting anything. Lets a
 * UI offer (or refuse) Resume without ever deciding recoverability on its own. */
export type BridgeRecoveryCheck =
  | { kind: 'NONE' }
  | { kind: 'RUNNING'; runId: string }
  | { kind: 'RECOVERABLE'; runId: string; iteration: number; status: string; strategy: 'CONTINUE_FROM_PROMPT' | 'RESEND_REPORT_TO_CODEX' }
  | { kind: 'BLOCKED'; runId: string; iteration: number; status: string; reason: string };

export interface BridgeConfigView {
  config: AiBridgeConfig;
  errors: string[];
  path: string;
  exists: boolean;
}

export type BridgeSaveConfigOutcome = { kind: 'SAVED'; config: AiBridgeConfig } | { kind: 'INVALID'; errors: string[] } | { kind: 'REFUSED_RUNNING'; pid: number };

export interface BridgeStatus {
  runId: string | null;
  /** RUNNING / INTERRUPTED / NOT_STARTED, or a terminal OrchestratorFinalStatus. */
  status: string;
  iteration: number;
  currentPhase: string | null;
  claude: { pid: number | null; sessionId: string | null };
  codex: { pid: number | null; threadId: string | null };
  startedAt: string | null;
  updatedAt: string | null;
  lastReportPath: string | null;
  /** The maxIterations this run was started with, or null for a state file written
   * before M4 (the field did not exist yet) / no session. */
  maxIterations: number | null;
  /** What Claude and Codex are each doing right now (core/status/agent-activity.ts). */
  activity: AgentActivity;
}

export type BridgeEventListener = (event: BridgeEvent) => void;

interface SessionState {
  runId: string;
  projectPath: string;
  status: string;
  iteration: number;
  claudeSessionId: string | null;
  codexThreadId: string | null;
  claudePid: number | null;
  codexPid: number | null;
  lastReportPath: string | null;
  lastPromptHash: string | null;
  /** Absent in state files written before M4. */
  maxIterations?: number;
  startedAt: string;
  updatedAt: string;
}

type RecoveryPlan =
  | { ok: false; reason: string }
  | { ok: true; strategy: 'CONTINUE_FROM_PROMPT' | 'RESEND_REPORT_TO_CODEX'; initialPrompt: string; resumeState: ResumeState };

const TRANSITION_EVENT_MAP: Partial<Record<OrchestratorState, BridgeEvent['event']>> = {
  CLAUDE_EXECUTING: 'CLAUDE_STARTED',
  REPORT_DETECTED: 'REPORT_DETECTED',
  REPORT_VALIDATED: 'REPORT_VALIDATED',
  CODEX_REVIEWING: 'CODEX_STARTED',
  RESPONSE_PARSED: 'RESPONSE_PARSED',
  ERROR: 'ERROR',
  PAUSED: 'PAUSED',
};

const TRANSITION_DETAIL_MAP: Partial<Record<OrchestratorState, (nnn: string) => string>> = {
  CLAUDE_EXECUTING: (nnn) => `Claude started (iteration ${nnn})`,
  REPORT_DETECTED: (nnn) => `Report ${nnn} detected`,
  REPORT_VALIDATED: (nnn) => `Report ${nnn} validated`,
  CODEX_REVIEWING: (nnn) => `Codex started reviewing report ${nnn}`,
  RESPONSE_PARSED: (nnn) => `Codex response ${nnn} parsed`,
  ERROR: (nnn) => `Error during iteration ${nnn}`,
  PAUSED: (nnn) => `Paused after iteration ${nnn}`,
};

const TERMINAL_STATUSES = ['DONE', 'NEED_HUMAN', 'ERROR', 'STOPPED', 'STOPPED_MAX_ITERATIONS', 'PAUSED'];

/** Caps events.jsonl/ai-bridge.log at ~2x this (current + one `.1` backup) rather than
 * unbounded growth across a long-running project (M3.5 §15). Never rotates mid-run in a
 * way that loses the current session's own lines — only the OLDEST content moves to the
 * backup file; whatever's being appended right now always lands in the fresh file. */
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The single Core entry point a caller (the CLI today, Electron's main process later)
 * uses to drive one project's AI Bridge session — start/pause/resume/stop/status, plus
 * a live event subscription. Owns everything cli.ts used to own directly: doctor
 * gating, the run lock, session directory creation, state persistence, and Orchestrator
 * wiring. No import of `cli.ts`/`cli-args.ts`, no `console.*`, no `process.exit` — see
 * `tests/architecture.test.ts`. One instance is scoped to one project directory.
 */
interface ResolvedDeps {
  runDoctor: (projectPath: string) => Promise<Preflight>;
  isPidAlive: (pid: number) => boolean;
  attemptGracefulStop: (pid: number) => Promise<void>;
  claudeCommandArgsPrefix: string[];
  codexCommandArgsPrefix: string[];
  // Deliberately stay `undefined` (not `{}`) when not overridden: `child_process.spawn`
  // inherits the parent's environment only when `env` is omitted entirely — passing an
  // explicit `{}` replaces it outright (no PATH, no APPDATA, ...), which would break the
  // real `claude`/`codex` CLI in production. Only ever set by tests.
  claudeEnv: NodeJS.ProcessEnv | undefined;
  codexEnv: NodeJS.ProcessEnv | undefined;
}

export class BridgeEngine {
  private readonly projectPath: string;
  private readonly deps: ResolvedDeps;
  private readonly listeners = new Set<BridgeEventListener>();

  constructor(projectPath: string, deps: BridgeEngineDeps = {}) {
    this.projectPath = path.resolve(projectPath);
    this.deps = {
      runDoctor: deps.runDoctor ?? realRunDoctor,
      isPidAlive: deps.isPidAlive ?? realIsPidAlive,
      attemptGracefulStop: deps.attemptGracefulStop ?? realAttemptGracefulStop,
      claudeCommandArgsPrefix: deps.claudeCommandArgsPrefix ?? [],
      codexCommandArgsPrefix: deps.codexCommandArgsPrefix ?? [],
      claudeEnv: deps.claudeEnv,
      codexEnv: deps.codexEnv,
    };
  }

  /** Returns an unsubscribe function. Listener errors are swallowed so one broken
   * subscriber can never take down a run. */
  subscribe(listener: BridgeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async doctor(): Promise<DoctorReport> {
    const { report } = await this.deps.runDoctor(this.projectPath);
    return report;
  }

  async start(options: BridgeStartOptions): Promise<BridgeRunOutcome> {
    const p = enginePaths(this.projectPath);
    const preflight = await this.deps.runDoctor(this.projectPath);
    if (preflight.report.overall !== 'PASS' || !preflight.claudeExe || !preflight.codexExe) {
      return { kind: 'BLOCKED_PREFLIGHT', doctorReport: preflight.report };
    }

    const lock = await acquireLock(p.lockPath);
    if (!lock.ok) return { kind: 'ALREADY_RUNNING', pid: lock.pid!, doctorReport: preflight.report };

    try {
      await this.clearStalePauseRequest(p);
      const sessionMgr = new SessionManager({ aiBridgeDir: p.aiBridgeDir });
      const session = await sessionMgr.createSession();
      const projectName = path.basename(this.projectPath);
      const maxIterations = options.maxIterations ?? preflight.config.maxIterations;

      const result = await this.runLoop({
        projectName,
        bridgeSessionId: session.sessionId,
        sessionDir: session.sessionDir,
        reportsDir: session.reportsDir,
        logsDir: session.logsDir,
        initialPrompt: options.task,
        claudeExe: preflight.claudeExe,
        codexExe: preflight.codexExe,
        config: { ...preflight.config, maxIterations },
        crashInjection: options.crashInjection,
      });
      return {
        kind: 'COMPLETED',
        finalStatus: result.finalStatus,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        iterations: result.iterations.length,
        sessionDir: session.sessionDir,
        claudeSessionId: result.claudeSessionId,
        codexThreadId: result.codexThreadId,
        doctorReport: preflight.report,
      };
    } finally {
      await releaseLock(p.lockPath);
    }
  }

  async resume(): Promise<BridgeRunOutcome> {
    const p = enginePaths(this.projectPath);
    let state: SessionState;
    try {
      state = JSON.parse(await readFile(p.stateFile, 'utf8'));
    } catch {
      return { kind: 'NO_STATE' };
    }

    const preflight = await this.deps.runDoctor(this.projectPath);
    if (preflight.report.overall !== 'PASS' || !preflight.claudeExe || !preflight.codexExe) {
      return { kind: 'BLOCKED_PREFLIGHT', doctorReport: preflight.report };
    }

    const lock = await acquireLock(p.lockPath);
    if (!lock.ok) return { kind: 'ALREADY_RUNNING', pid: lock.pid!, doctorReport: preflight.report };

    try {
      await this.clearStalePauseRequest(p);
      const sessionDir = path.join(p.aiBridgeDir, 'sessions', state.runId);
      const reportsDir = path.join(p.aiBridgeDir, 'reports');
      const logsDir = path.join(p.aiBridgeDir, 'logs');
      const projectName = path.basename(this.projectPath);

      await this.logEvent(p, { runId: state.runId, iteration: state.iteration, phase: state.status, event: 'RECOVERY_STARTED' });

      const plan = await this.planRecovery(p, state);
      if (!plan.ok) return { kind: 'RECOVERY_BLOCKED', reason: plan.reason, doctorReport: preflight.report };
      const { initialPrompt, resumeState } = plan;

      const result = await this.runLoop({
        projectName,
        bridgeSessionId: state.runId,
        sessionDir,
        reportsDir,
        logsDir,
        initialPrompt,
        claudeExe: preflight.claudeExe,
        codexExe: preflight.codexExe,
        // A resumed run keeps the cap it was started with (persisted since M4); older
        // state files without the field fall back to config, as before.
        config: { ...preflight.config, maxIterations: state.maxIterations ?? preflight.config.maxIterations },
        resumeState,
      });
      await this.logEvent(p, { runId: state.runId, iteration: result.iterations.length, phase: result.finalStatus, event: 'RECOVERY_COMPLETED' });
      return {
        kind: 'COMPLETED',
        finalStatus: result.finalStatus,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        iterations: result.iterations.length,
        sessionDir,
        claudeSessionId: result.claudeSessionId,
        codexThreadId: result.codexThreadId,
        doctorReport: preflight.report,
      };
    } finally {
      await releaseLock(p.lockPath);
    }
  }

  async pause(): Promise<BridgePauseOutcome> {
    const p = enginePaths(this.projectPath);

    let lockPid: number | null = null;
    try {
      lockPid = JSON.parse(await readFile(p.lockPath, 'utf8')).pid ?? null;
    } catch {
      lockPid = null;
    }
    if (lockPid === null || !this.deps.isPidAlive(lockPid)) return { kind: 'NOT_RUNNING' };

    await writeFile(p.pauseRequestPath, JSON.stringify({ requestedAt: new Date().toISOString() }), 'utf8');
    try {
      const current: SessionState = JSON.parse(await readFile(p.stateFile, 'utf8'));
      await this.logEvent(p, { runId: current.runId, iteration: current.iteration, phase: current.status, event: 'PAUSE_REQUESTED' });
    } catch {
      // No readable state file yet — the marker is still in place; only the event log entry is skipped.
    }

    const readStatus = async (): Promise<string | null> => {
      try {
        return JSON.parse(await readFile(p.stateFile, 'utf8')).status ?? null;
      } catch {
        return null;
      }
    };

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && this.deps.isPidAlive(lockPid)) {
      const status = await readStatus();
      if (status === 'PAUSED') return { kind: 'PAUSED' };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // The process may have reached PAUSED and exited between the loop's last status
    // check and its isPidAlive re-check (a real race observed under real timing) —
    // read the state file one final time before concluding it was missed.
    const finalStatus = await readStatus();
    if (finalStatus === 'PAUSED') return { kind: 'PAUSED' };
    if (this.deps.isPidAlive(lockPid)) return { kind: 'STILL_RUNNING' };
    return { kind: 'ENDED_BEFORE_PAUSE', finalStatus: finalStatus ?? 'unknown' };
  }

  async stop(): Promise<BridgeStopOutcome> {
    const p = enginePaths(this.projectPath);

    let lockData: { pid: number } | null = null;
    try {
      lockData = JSON.parse(await readFile(p.lockPath, 'utf8'));
    } catch {
      lockData = null;
    }
    if (!lockData || typeof lockData.pid !== 'number') return { kind: 'NOT_RUNNING' };

    const result = await requestStop(
      lockData.pid,
      { isPidAlive: this.deps.isPidAlive, attemptGraceful: this.deps.attemptGracefulStop, forceKill: async (pid) => killProcessTree(pid), sleep: (ms) => new Promise((res) => setTimeout(res, ms)) },
      { gracefulTimeoutMs: 10_000, pollIntervalMs: 300 },
    );

    if (result.reason === 'FORCE_KILLED' || result.reason === 'STOP_FAILED') {
      // The process could not clean up after itself — do it here instead.
      await releaseLock(p.lockPath);
    }
    if (result.reason === 'NOT_RUNNING') return { kind: 'NOT_RUNNING' };
    if (!this.deps.isPidAlive(lockData.pid)) await this.recordUserStop(p, result.reason);
    return { kind: 'STOPPED', reason: result.reason, ok: result.ok };
  }

  async status(): Promise<BridgeStatus> {
    const p = enginePaths(this.projectPath);

    let state: SessionState;
    try {
      state = JSON.parse(await readFile(p.stateFile, 'utf8'));
    } catch {
      return {
        runId: null,
        status: 'NOT_STARTED',
        iteration: 0,
        currentPhase: null,
        claude: { pid: null, sessionId: null },
        codex: { pid: null, threadId: null },
        startedAt: null,
        updatedAt: null,
        lastReportPath: null,
        maxIterations: null,
        activity: describeAgentActivity('NOT_STARTED', null),
      };
    }

    let lockPid: number | null = null;
    try {
      lockPid = JSON.parse(await readFile(p.lockPath, 'utf8')).pid ?? null;
    } catch {
      lockPid = null;
    }

    let displayStatus: string;
    if (TERMINAL_STATUSES.includes(state.status)) displayStatus = state.status;
    else if (lockPid !== null && this.deps.isPidAlive(lockPid)) displayStatus = 'RUNNING';
    else displayStatus = 'INTERRUPTED';

    return {
      runId: state.runId,
      status: displayStatus,
      iteration: state.iteration,
      currentPhase: state.status,
      claude: { pid: state.claudePid, sessionId: state.claudeSessionId },
      codex: { pid: state.codexPid, threadId: state.codexThreadId },
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      lastReportPath: state.lastReportPath,
      maxIterations: typeof state.maxIterations === 'number' ? state.maxIterations : null,
      activity: describeAgentActivity(displayStatus, state.status),
    };
  }

  /** Read-only preview of `resume()`'s own decision for the current session. */
  async checkRecovery(): Promise<BridgeRecoveryCheck> {
    const p = enginePaths(this.projectPath);
    const state = await this.readState(p);
    if (!state) return { kind: 'NONE' };
    const status = await this.status();
    if (status.status === 'RUNNING') return { kind: 'RUNNING', runId: state.runId };
    if (status.status !== 'PAUSED' && status.status !== 'INTERRUPTED') return { kind: 'NONE' };
    const plan = await this.planRecovery(p, state);
    if (!plan.ok) return { kind: 'BLOCKED', runId: state.runId, iteration: state.iteration, status: status.status, reason: plan.reason };
    return { kind: 'RECOVERABLE', runId: state.runId, iteration: state.iteration, status: status.status, strategy: plan.strategy };
  }

  /** Every session directory of this project, newest first (core/session-history). */
  async listSessions(): Promise<SessionSummary[]> {
    const p = enginePaths(this.projectPath);
    return listSessions(p.aiBridgeDir, p.eventsPath, await this.currentSessionInfo(p));
  }

  /** Read-only artifacts of one session, or null for an unknown/invalid run id. */
  async getSessionArtifacts(runId: string): Promise<SessionArtifacts | null> {
    if (!isValidRunId(runId)) return null;
    const p = enginePaths(this.projectPath);
    return readSessionArtifacts(p.aiBridgeDir, p.eventsPath, runId, await this.currentSessionInfo(p));
  }

  /** The newest `limit` structured events (all sessions), oldest first. */
  async recentEvents(limit = 200): Promise<BridgeEvent[]> {
    const p = enginePaths(this.projectPath);
    return readEventLog(p.eventsPath, Math.max(1, Math.min(limit, 5000)));
  }

  async getConfig(): Promise<BridgeConfigView> {
    const p = enginePaths(this.projectPath);
    const exists = await stat(p.configPath).then(() => true, () => false);
    const { config, errors } = await loadConfig(p.configPath, { readFile: (f) => readFile(f, 'utf8') });
    return { config, errors, path: p.configPath, exists };
  }

  /** Validates with the same rules `doctor`/`start` use and writes `.ai-bridge/config.json`
   * atomically — never while a session is running (it would not pick the change up
   * mid-run, and a half-applied config is worse than none). */
  async saveConfig(raw: unknown): Promise<BridgeSaveConfigOutcome> {
    const p = enginePaths(this.projectPath);
    const lockPid = await this.readLockPid(p);
    if (lockPid !== null && this.deps.isPidAlive(lockPid)) return { kind: 'REFUSED_RUNNING', pid: lockPid };
    const { config, errors } = validateConfig(raw);
    if (errors.length > 0) return { kind: 'INVALID', errors };
    await new AtomicJsonWriter<AiBridgeConfig>(p.configPath).write(config);
    return { kind: 'SAVED', config };
  }

  async logs(lines = 50): Promise<string[]> {
    const p = enginePaths(this.projectPath);
    try {
      const text = await readFile(p.humanLogPath, 'utf8');
      return text.split('\n').filter((l) => l.trim() !== '').slice(-lines);
    } catch {
      return [];
    }
  }

  async reset(): Promise<BridgeResetOutcome> {
    const p = enginePaths(this.projectPath);

    let lockPid: number | null = null;
    try {
      lockPid = JSON.parse(await readFile(p.lockPath, 'utf8')).pid ?? null;
    } catch {
      lockPid = null;
    }
    if (lockPid !== null && this.deps.isPidAlive(lockPid)) return { kind: 'REFUSED_RUNNING', pid: lockPid };

    // Only ever touches .ai-bridge/state (lock + current-session.json) — never project
    // code, never reports/sessions/logs.
    await releaseLock(p.lockPath);
    await rm(p.stateFile, { force: true });
    return { kind: 'RESET' };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async readState(p: ReturnType<typeof enginePaths>): Promise<SessionState | null> {
    try {
      return JSON.parse(await readFile(p.stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  private async readLockPid(p: ReturnType<typeof enginePaths>): Promise<number | null> {
    try {
      const pid = JSON.parse(await readFile(p.lockPath, 'utf8')).pid;
      return typeof pid === 'number' ? pid : null;
    } catch {
      return null;
    }
  }

  private async currentSessionInfo(p: ReturnType<typeof enginePaths>): Promise<CurrentSessionInfo | null> {
    const state = await this.readState(p);
    if (!state) return null;
    const status = await this.status();
    return { runId: state.runId, displayStatus: status.status, iteration: state.iteration, state: { ...state } };
  }

  /** The single recovery decision shared by `resume()` and `checkRecovery()`: the pure
   * checkpoint choice (core/recovery) plus the on-disk artifact it needs. Read-only. */
  private async planRecovery(p: ReturnType<typeof enginePaths>, state: SessionState): Promise<RecoveryPlan> {
    const sessionDir = path.join(p.aiBridgeDir, 'sessions', state.runId);
    const reportsDir = path.join(p.aiBridgeDir, 'reports');
    const nnn = (n: number) => String(n).padStart(3, '0');
    // The decision itself (which checkpoint applies, or none) is core/recovery
    // logic, shared with the CLI's resume path — see core/recovery/recovery.ts.
    const strategy = decideRecoveryStrategy(state);

    if (strategy.kind === 'BLOCKED') return { ok: false, reason: strategy.reason };
    if (strategy.kind === 'CONTINUE_FROM_PROMPT') {
      const extractedPromptPath = path.join(sessionDir, `${nnn(strategy.readPromptForIteration)}-extracted-prompt.md`);
      try {
        const initialPrompt = await readFile(extractedPromptPath, 'utf8');
        return { ok: true, strategy: strategy.kind, initialPrompt, resumeState: strategy.resumeState };
      } catch {
        return { ok: false, reason: `Expected ${extractedPromptPath} to exist for a ${state.status} session, but it does not.` };
      }
    }
    const reportPath = path.join(reportsDir, `${nnn(strategy.iteration)}-report.md`);
    const promptPath = path.join(sessionDir, `${nnn(strategy.iteration)}-claude-prompt.md`);
    const reportExists = await stat(reportPath).then(() => true).catch(() => false);
    if (!reportExists) return { ok: false, reason: `Expected ${reportPath} to exist for a ${state.status} session, but it does not.` };
    const initialPrompt = await readFile(promptPath, 'utf8').catch(() => '');
    return { ok: true, strategy: strategy.kind, initialPrompt, resumeState: strategy.resumeState };
  }

  /** A pause marker left behind by a run that ended without honoring it (crash, forced
   * stop) must not pause the *next* run at its very first boundary. Only called while
   * this process holds the run lock, so no live run can be waiting on it. */
  private async clearStalePauseRequest(p: ReturnType<typeof enginePaths>): Promise<void> {
    await rm(p.pauseRequestPath, { force: true });
  }

  /** After `stop()` confirmed the session's process is gone, a state file still showing
   * a mid-flight phase would read as a crash (INTERRUPTED) — but the user asked for this
   * ending. Records it as STOPPED (terminal) so nothing offers to resume it. */
  private async recordUserStop(p: ReturnType<typeof enginePaths>, reason: string): Promise<void> {
    const state = await this.readState(p);
    await this.clearStalePauseRequest(p);
    if (!state || TERMINAL_STATUSES.includes(state.status)) return;
    const stopped: SessionState = { ...state, status: 'STOPPED', claudePid: null, codexPid: null };
    await this.writeState(new AtomicJsonWriter<SessionState>(p.stateFile), stopped);
    await this.logEvent(p, { runId: state.runId, iteration: state.iteration, phase: 'STOPPED', event: 'RUN_STOPPED', detail: `Stopped by user (${reason})` });
  }

  private async writeState(writer: AtomicJsonWriter<SessionState>, state: SessionState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await writer.write(state);
  }

  private async logEvent(p: ReturnType<typeof enginePaths>, event: Omit<BridgeEvent, 'timestamp'>): Promise<void> {
    const full = { timestamp: new Date().toISOString(), ...event } as BridgeEvent;
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // One broken subscriber must never break the run or other subscribers.
      }
    }
    await appendEvent(p.eventsPath, full, { maxBytes: MAX_LOG_FILE_BYTES });
    await rotateIfOversized(p.humanLogPath, MAX_LOG_FILE_BYTES);
    await writeFile(p.humanLogPath, formatHumanLogLine(full) + '\n', { flag: 'a' });
  }

  private async runLoop(o: {
    projectName: string;
    bridgeSessionId: string;
    sessionDir: string;
    reportsDir: string;
    logsDir: string;
    initialPrompt: string;
    claudeExe: string;
    codexExe: string;
    config: AiBridgeConfig;
    resumeState?: NonNullable<ConstructorParameters<typeof Orchestrator>[0]['resumeState']>;
    crashInjection?: { at: CrashPoint; onTrigger: () => void };
  }): ReturnType<Orchestrator['run']> {
    const p = enginePaths(this.projectPath);
    const logFile = path.join(o.logsDir, `${new Date().toISOString().slice(0, 10)}-session.log`);
    let stopRequested = false;
    const onSigint = () => {
      stopRequested = true;
    };
    process.once('SIGINT', onSigint);

    const state: SessionState = {
      runId: o.bridgeSessionId,
      projectPath: this.projectPath,
      status: 'STARTING',
      iteration: o.resumeState?.startIteration ?? 0,
      claudeSessionId: o.resumeState?.claudeSessionId ?? null,
      codexThreadId: o.resumeState?.codexThreadId ?? null,
      claudePid: null,
      codexPid: null,
      lastReportPath: null,
      lastPromptHash: null,
      maxIterations: o.config.maxIterations,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const stateWriter = new AtomicJsonWriter<SessionState>(p.stateFile);
    await this.writeState(stateWriter, state);
    await this.logEvent(p, { runId: o.bridgeSessionId, iteration: 0, phase: 'RUN', event: 'RUN_STARTED' });

    const orchestrator = new Orchestrator({
      projectName: o.projectName,
      projectPath: this.projectPath,
      bridgeSessionId: o.bridgeSessionId,
      sessionDir: o.sessionDir,
      reportsDir: o.reportsDir,
      initialPrompt: o.initialPrompt,
      maxIterations: o.config.maxIterations,
      claudeTimeoutMs: o.config.claudeTimeoutMs,
      codexTimeoutMs: o.config.codexTimeoutMs,
      claudeAdapter: new ClaudeCodeCliAdapter({ executable: o.claudeExe, commandArgsPrefix: this.deps.claudeCommandArgsPrefix }),
      codexAdapter: new CodexCliAdapter({ executable: o.codexExe, commandArgsPrefix: this.deps.codexCommandArgsPrefix }),
      claudeEnv: this.deps.claudeEnv,
      codexEnv: this.deps.codexEnv,
      resumeState: o.resumeState,
      crashInjection: o.crashInjection,
      shouldStop: () => stopRequested,
      shouldPause: () => stat(p.pauseRequestPath).then(() => true, () => false),
      onPidUpdate: ({ adapter, pid }) => {
        if (adapter === 'claude') state.claudePid = pid;
        else state.codexPid = pid;
        void this.writeState(stateWriter, state);
      },
      onSessionUpdate: async ({ claudeSessionId, codexThreadId }) => {
        // Awaited by the orchestrator: persisted BEFORE the other adapter is ever
        // invoked, not fire-and-forget — a crash right after Claude finishes must not
        // be able to lose the session id resume needs to continue it correctly.
        if (claudeSessionId) state.claudeSessionId = claudeSessionId;
        if (codexThreadId) state.codexThreadId = codexThreadId;
        await this.writeState(stateWriter, state);
      },
      onTransition: async (t) => {
        state.status = t.state;
        if (t.iteration > 0) state.iteration = t.iteration;
        // Awaited by the orchestrator: fully durable before the next step proceeds.
        await this.writeState(stateWriter, state);
        const mapped = TRANSITION_EVENT_MAP[t.state];
        if (mapped) {
          const nnn = String(t.iteration).padStart(3, '0');
          const detail = TRANSITION_DETAIL_MAP[t.state]?.(nnn);
          void this.logEvent(p, { runId: o.bridgeSessionId, iteration: t.iteration, phase: t.state, event: mapped, detail }).catch(() => {});
        }
      },
      onLog: async (entry: LogEntry) => {
        await appendLogLine(logFile, { timestamp: new Date().toISOString(), sessionId: o.bridgeSessionId, ...entry });
        if (entry.reportPath) state.lastReportPath = entry.reportPath;
        await this.logEvent(p, {
          runId: o.bridgeSessionId,
          iteration: entry.iteration,
          phase: entry.adapter,
          event: entry.adapter === 'claude' ? 'CLAUDE_EXITED' : 'CODEX_EXITED',
          detail: `${entry.adapter} exited ${entry.exitCode} (${entry.durationMs}ms) — ${entry.status}`,
        });
      },
    });

    try {
      const result = await orchestrator.run();
      // The pause request (if any) has now been honored (or the run ended some other
      // way before it was checked again) — clear it so a future fresh `start` isn't
      // immediately paused by a stale marker.
      await rm(p.pauseRequestPath, { force: true });

      state.status = result.finalStatus;
      state.claudeSessionId = result.claudeSessionId;
      state.codexThreadId = result.codexThreadId;
      state.claudePid = null;
      state.codexPid = null;
      await this.writeState(stateWriter, state);
      await this.logEvent(p, {
        runId: o.bridgeSessionId,
        iteration: result.iterations.length,
        phase: result.finalStatus,
        event: result.finalStatus === 'STOPPED' ? 'RUN_STOPPED' : 'RUN_COMPLETED',
        detail: result.errorCode ?? undefined,
      });

      return result;
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
  }
}

export { CRASH_POINTS };
export type { CrashPoint };
