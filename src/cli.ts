#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from './cli-args.ts';
import { BridgeEngine, CRASH_POINTS, type BridgeStartOptions } from './core/bridge-engine.ts';
import type { DoctorReport } from './core/preflight/doctor.ts';

function printDoctorReport(report: DoctorReport): void {
  for (const c of report.checks) console.log(`[${c.status}] ${c.name} — ${c.detail}`);
  console.log(`Overall: ${report.overall}`);
}

function crashInjectionFromEnv(): BridgeStartOptions['crashInjection'] {
  const at = process.env.AI_BRIDGE_CRASH_AT;
  if (!at || !(CRASH_POINTS as readonly string[]).includes(at)) return undefined;
  // Test-only: makes this process self-terminate at a precise, named point so a real
  // crash-recovery test can force a genuine interruption. Never set in normal use. See
  // docs/06-recovery-design.md.
  return { at: at as (typeof CRASH_POINTS)[number], onTrigger: () => process.exit(137) };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function cmdDoctor(flags: Record<string, string>): Promise<void> {
  const projectPath = path.resolve(flags.project ?? process.cwd());
  const engine = new BridgeEngine(projectPath);
  const report = await engine.doctor();
  printDoctorReport(report);
  process.exitCode = report.overall === 'PASS' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// start / resume — both funnel through BridgeEngine and share result printing
// ---------------------------------------------------------------------------

function printRunOutcome(outcome: Awaited<ReturnType<BridgeEngine['start']>>, projectPath: string): void {
  if (outcome.kind === 'BLOCKED_PREFLIGHT') {
    printDoctorReport(outcome.doctorReport);
    console.error(`\nPreflight ${outcome.doctorReport.overall} — refusing to proceed.`);
    process.exitCode = outcome.doctorReport.overall === 'BLOCKED' ? 2 : 1;
    return;
  }
  if (outcome.kind === 'ALREADY_RUNNING') {
    console.error(`ERROR_ALREADY_RUNNING: another ai-bridge session (pid ${outcome.pid}) is already running for this project.`);
    console.error(`Run "ai-bridge status --project ${projectPath}" or "ai-bridge stop --project ${projectPath}".`);
    process.exitCode = 2;
    return;
  }
  if (outcome.kind === 'INVALID_OPTIONS') {
    console.error(`Invalid options: ${outcome.reason}`);
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'NO_STATE') {
    console.error('No session state found — nothing to resume.');
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'RECOVERY_BLOCKED') {
    printDoctorReport(outcome.doctorReport);
    console.error(`\nRECOVERY_BLOCKED: ${outcome.reason}`);
    process.exitCode = 3;
    return;
  }
  // COMPLETED
  printDoctorReport(outcome.doctorReport);
  console.log(`\nFinal status: ${outcome.finalStatus}`);
  if (outcome.errorCode) console.log(`Error: ${outcome.errorCode}${outcome.errorMessage ? ` — ${outcome.errorMessage}` : ''}`);
  console.log(`Iterations: ${outcome.iterations}`);
  console.log(`Session dir: ${outcome.sessionDir}`);
  process.exitCode = outcome.finalStatus === 'DONE' ? 0 : 1;
}

async function cmdStart(flags: Record<string, string>): Promise<void> {
  if (!flags.project || !flags.task) {
    console.error('Usage: ai-bridge start --project <path> --task "<text>" [--max-iterations <n>]');
    process.exitCode = 1;
    return;
  }
  const projectPath = path.resolve(flags.project);
  const engine = new BridgeEngine(projectPath);
  console.log(`\nStarting in ${projectPath}\n`);
  const outcome = await engine.start({
    task: flags.task,
    maxIterations: flags['max-iterations'] ? Number(flags['max-iterations']) : undefined,
    crashInjection: crashInjectionFromEnv(),
  });
  printRunOutcome(outcome, projectPath);
}

async function cmdResume(flags: Record<string, string>): Promise<void> {
  const projectPath = path.resolve(flags.project ?? process.cwd());
  const engine = new BridgeEngine(projectPath);
  const status = await engine.status();
  console.log(status.status === 'PAUSED' ? 'Resuming from a pause.' : 'Recovering from an interruption.');
  const outcome = await engine.resume();
  printRunOutcome(outcome, projectPath);
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function cmdStop(flags: Record<string, string>): Promise<void> {
  const projectPath = path.resolve(flags.project ?? process.cwd());
  const engine = new BridgeEngine(projectPath);
  const outcome = await engine.stop();
  if (outcome.kind === 'NOT_RUNNING') {
    console.log('No running ai-bridge session found for this project.');
    return;
  }
  console.log(`Stop result: ${outcome.reason}`);
  process.exitCode = outcome.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

async function cmdPause(flags: Record<string, string>): Promise<void> {
  const projectPath = path.resolve(flags.project ?? process.cwd());
  const engine = new BridgeEngine(projectPath);
  const outcome = await engine.pause();
  if (outcome.kind === 'NOT_RUNNING') {
    console.log('No running ai-bridge session found for this project.');
    process.exitCode = 1;
    return;
  }
  if (outcome.kind === 'PAUSED') {
    console.log('PAUSED.');
    return;
  }
  if (outcome.kind === 'STILL_RUNNING') {
    console.log('Still waiting for a safe boundary — check "ai-bridge status" for progress.');
    // Distinct from PAUSED (M3 known limitation, fixed here): the pause was requested
    // but not confirmed reached within the wait window, so this is not a success exit.
    process.exitCode = 1;
    return;
  }
  // ENDED_BEFORE_PAUSE
  console.log(`The session ended (final status: ${outcome.finalStatus}) before a pause was reached.`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(flags: Record<string, string>): Promise<void> {
  const projectPath = path.resolve(flags.project ?? process.cwd());
  const engine = new BridgeEngine(projectPath);
  const status = await engine.status();
  if (status.status === 'NOT_STARTED') {
    console.log('No session state found. Run "ai-bridge start" first.');
    process.exitCode = 1;
    return;
  }

  const elapsedMs = status.startedAt ? Date.now() - Date.parse(status.startedAt) : 0;
  console.log(`Status: ${status.status}`);
  console.log(`Session: ${status.runId}`);
  console.log(`Iteration: ${status.iteration}`);
  console.log(`Current phase: ${status.currentPhase}`);
  console.log(`Claude PID: ${status.claude.pid ?? '-'}`);
  console.log(`Codex PID: ${status.codex.pid ?? '-'}`);
  console.log(`Elapsed: ${Math.round(elapsedMs / 1000)}s`);
  console.log(`Last report: ${status.lastReportPath ?? '-'}`);
  if (status.status === 'INTERRUPTED') {
    console.log('\nThis session was interrupted (crash or forced termination) without reaching a terminal state.');
    console.log(`Run "ai-bridge resume --project ${projectPath}" to see if it can be continued safely.`);
  }
}

// ---------------------------------------------------------------------------
// logs / reset
// ---------------------------------------------------------------------------

async function cmdLogs(flags: Record<string, string>): Promise<void> {
  const projectPath = path.resolve(flags.project ?? process.cwd());
  const engine = new BridgeEngine(projectPath);
  const n = flags.lines ? Number(flags.lines) : 50;
  const lines = await engine.logs(n);
  if (lines.length === 0) {
    console.log('No logs found yet. Run "ai-bridge start" first.');
    process.exitCode = 1;
    return;
  }
  console.log(lines.join('\n'));
}

async function cmdReset(flags: Record<string, string>): Promise<void> {
  const projectPath = path.resolve(flags.project ?? process.cwd());
  const engine = new BridgeEngine(projectPath);
  const outcome = await engine.reset();
  if (outcome.kind === 'REFUSED_RUNNING') {
    console.error(`Refusing to reset: a session (pid ${outcome.pid}) is still running. Run "ai-bridge stop" first.`);
    process.exitCode = 1;
    return;
  }
  console.log('Reset .ai-bridge/state (lock and current-session.json cleared).');
  if (flags.artifacts === 'true') {
    console.log('--artifacts is not implemented: reports/sessions/logs were left untouched by design. Delete them manually if you really want to.');
  }
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === null) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }
  if (parsed.command === 'doctor') return cmdDoctor(parsed.flags);
  if (parsed.command === 'start') return cmdStart(parsed.flags);
  if (parsed.command === 'status') return cmdStatus(parsed.flags);
  if (parsed.command === 'stop') return cmdStop(parsed.flags);
  if (parsed.command === 'resume') return cmdResume(parsed.flags);
  if (parsed.command === 'logs') return cmdLogs(parsed.flags);
  if (parsed.command === 'reset') return cmdReset(parsed.flags);
  if (parsed.command === 'pause') return cmdPause(parsed.flags);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
