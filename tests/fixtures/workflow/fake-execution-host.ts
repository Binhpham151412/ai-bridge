// Test Execution Host for the M5.4 ExecutionPort tests: the production `serveRunHost` (the
// same Electron-free host Electron Main forks) around a real BridgeEngine wired to the fake
// claude/codex CLIs and a scripted doctor. Never runs a real CLI or spends quota.
//
//   FAKE_HOST_INFO_FILE      write {pid, ppid, startOptions} here (process-relationship checks)
//   FAKE_HOST_MODE           normal | doctor-fail | throw | garbage | tamper-correlation
//   AI_BRIDGE_CRASH_AT       existing crash injection (self-exit 137 at a named point)
//   FAKE_CLAUDE_MODE / FAKE_CLAUDE_DELAY_MS / FAKE_CLAUDE_USAGE / FAKE_CODEX_MODE   fake CLI behaviour
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeEngine, CRASH_POINTS, type BridgeStartOptions } from '../../../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../../../src/core/config/config.ts';
import { serveRunHost, type HostEngine } from '../../../src/desktop/main/run-host.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../fake-codex/fake-codex.mjs', import.meta.url));
const mode = process.env.FAKE_HOST_MODE ?? 'normal';
const infoFile = process.env.FAKE_HOST_INFO_FILE;

const info: Record<string, unknown> = { pid: process.pid, ppid: process.ppid };
const writeInfo = () => {
  if (infoFile) writeFileSync(infoFile, JSON.stringify(info), 'utf8');
};
writeInfo();

// Diagnostics for the process-lifetime tests: how this host ended. An external TerminateProcess
// leaves no record; an own exit/crash does. Crash semantics are kept (the process still dies).
if (infoFile) {
  const trail = (line: string) => {
    try {
      appendFileSync(`${infoFile}.trail`, `${process.pid} ${line}\n`, 'utf8');
    } catch {
      // diagnostics only
    }
  };
  process.on('disconnect', () => trail('disconnect'));
  process.on('exit', (code) => trail(`exit ${code}`));
  process.on('uncaughtException', (err) => {
    trail(`uncaughtException ${err.stack ?? err.message}`);
    process.exit(70);
  });
  process.on('unhandledRejection', (err) => {
    trail(`unhandledRejection ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(71);
  });
}

function crashInjection(): BridgeStartOptions['crashInjection'] {
  const at = process.env.AI_BRIDGE_CRASH_AT;
  if (!at || !(CRASH_POINTS as readonly string[]).includes(at)) return undefined;
  return { at: at as (typeof CRASH_POINTS)[number], onTrigger: () => process.exit(137) };
}

function realEngine(projectPath: string): BridgeEngine {
  return new BridgeEngine(projectPath, {
    runDoctor: async () => ({
      report: { checks: [{ name: 'fake', status: mode === 'doctor-fail' ? 'FAIL' : 'PASS', detail: 'scripted' }], overall: mode === 'doctor-fail' ? 'FAIL' : 'PASS' },
      claudeExe: process.execPath,
      codexExe: process.execPath,
      config: DEFAULT_CONFIG,
      configErrors: [],
      gitWarning: null,
    }),
    claudeCommandArgsPrefix: [FAKE_CLAUDE],
    codexCommandArgsPrefix: [FAKE_CODEX],
    claudeEnv: {
      FAKE_CLAUDE_MODE: process.env.FAKE_CLAUDE_MODE ?? 'ok',
      FAKE_CLAUDE_DELAY_MS: process.env.FAKE_CLAUDE_DELAY_MS ?? '0',
      FAKE_CLAUDE_USAGE: process.env.FAKE_CLAUDE_USAGE ?? '0',
    },
    codexEnv: { FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE ?? 'sequence' },
  });
}

function createEngine(projectPath: string): HostEngine {
  const engine = realEngine(projectPath);
  if (mode === 'throw') {
    return { subscribe: () => () => {}, start: async () => Promise.reject(new Error('simulated host exception')), resume: async () => Promise.reject(new Error('simulated host exception')) };
  }
  return {
    subscribe: (listener) => engine.subscribe(listener),
    start: (options) => {
      info.startOptions = { task: options.task, maxIterations: options.maxIterations ?? null, correlation: options.correlation ?? null };
      writeInfo();
      return engine.start(mode === 'tamper-correlation' ? { ...options, correlation: 'tampered-by-host' } : options).catch((err: unknown) => {
        if (infoFile) appendFileSync(`${infoFile}.trail`, `${process.pid} start rejected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`, 'utf8');
        throw err;
      });
    },
    resume: () => engine.resume(),
  };
}

if (mode === 'garbage' && process.send) {
  process.send({ type: 'event', event: { not: 'an event' } });
  process.send({ type: 'outcome' });
  process.send('plain text');
}

serveRunHost({ createEngine, crashInjection: crashInjection() });
