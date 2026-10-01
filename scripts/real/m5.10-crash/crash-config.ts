// TEST-ONLY (M5.10 B″, docs/59 §22.5/§23). Never imported by src/ and never part of dist-desktop/
// or a packaged app: build-crash-app.ts bundles it only into sandbox/m5.10-crash-app/.
//
// Configuration of the two Workflow Host crash points used by the M5.10 J1/J2 recovery tests.
// Fail-closed: anything but a fully valid configuration DISABLES the hook (the Workflow Host then
// behaves exactly like production) and reports why. Nothing here evaluates code, runs a command,
// reads credentials or talks IPC: it reads two environment variables and creates one small marker
// file with an exclusive create.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Also the isolation SENTINEL: this string must exist only in the crash app's workflow-host.mjs. */
export const CRASH_ENV = 'AI_BRIDGE_TEST_WF_CRASH_AT';
export const MARKER_ENV = 'AI_BRIDGE_TEST_WF_CRASH_MARKER';

export const CRASH_POINTS = [
  /** J1: the launch intent (ATTEMPT_LAUNCHING) is durable; the Execution Host is not forked yet. */
  'BEFORE_EXECUTION_HOST_FORK',
  /** J2: the Execution Host's RUN_STARTED reached the Workflow Host; EXECUTION_LINKED is not committed. */
  'ON_RUN_STARTED_BEFORE_LINK',
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export const CRASH_EXIT_CODE = 137;
/** The marker's file name; its directory must already exist. */
export const MARKER_NAME_PATTERN = /^m510-crash-[a-z0-9-]{1,64}\.marker$/;

export type CrashConfig =
  | { armed: false; reason: 'NOT_SET' }
  | { armed: false; reason: 'INVALID_POINT' | 'INVALID_MARKER'; detail: string; marker: string | null }
  | { armed: true; point: CrashPoint; marker: string };

const isCrashPoint = (v: string): v is CrashPoint => (CRASH_POINTS as readonly string[]).includes(v);

/** Validates the marker path: absolute (drive-letter or POSIX root, never UNC), no NUL, a fixed
 * file-name pattern, an existing parent directory. Returns an error text, or null when valid. */
export function markerProblem(marker: string | undefined, exists: (p: string) => boolean = existsSync): string | null {
  if (marker === undefined || marker === '') return `${MARKER_ENV} is not set`;
  if (marker.includes('\0')) return `${MARKER_ENV} contains a NUL character`;
  if (marker.startsWith('\\\\') || marker.startsWith('//')) return `${MARKER_ENV} must not be a UNC path`;
  if (!path.isAbsolute(marker)) return `${MARKER_ENV} must be an absolute path`;
  if (!MARKER_NAME_PATTERN.test(path.basename(marker))) return `${MARKER_ENV} file name must match ${String(MARKER_NAME_PATTERN)}`;
  if (!exists(path.dirname(marker))) return `${MARKER_ENV} directory does not exist`;
  return null;
}

export function parseCrashConfig(env: Readonly<Record<string, string | undefined>>, exists: (p: string) => boolean = existsSync): CrashConfig {
  const point = env[CRASH_ENV];
  if (point === undefined || point === '') return { armed: false, reason: 'NOT_SET' };
  const marker = env[MARKER_ENV];
  const problem = markerProblem(marker, exists);
  if (problem !== null) return { armed: false, reason: 'INVALID_MARKER', detail: problem, marker: null };
  if (!isCrashPoint(point)) return { armed: false, reason: 'INVALID_POINT', detail: `${CRASH_ENV} must be one of ${CRASH_POINTS.join(', ')}`, marker: marker! };
  return { armed: true, point, marker: marker! };
}

/** The explicit configuration report a test reads before trusting a crash run: one JSON line per
 * Workflow Host process in `<marker>.status.jsonl` (when the marker path is usable), else stderr.
 * NOT_SET is silent (the production-equivalent default). */
export function reportCrashConfig(cfg: CrashConfig, pid: number = process.pid): void {
  if (!cfg.armed && cfg.reason === 'NOT_SET') return;
  const line = cfg.armed
    ? { pid, armed: true, point: cfg.point, spent: existsSync(cfg.marker), at: new Date().toISOString() }
    : { pid, armed: false, reason: cfg.reason, detail: cfg.detail, at: new Date().toISOString() };
  const target = cfg.marker;
  if (target) {
    try {
      appendFileSync(`${target}.status.jsonl`, `${JSON.stringify(line)}\n`, 'utf8');
      return;
    } catch {
      // fall through to stderr
    }
  }
  process.stderr.write(`[m5.10-crash] crash hook disabled: ${JSON.stringify(line)}\n`);
}

/** True exactly once per marker path, across processes: the marker is created with an exclusive
 * create ('wx'), so the next Workflow Host (same environment, same Main) never fires again. */
export function fire(cfg: CrashConfig, point: CrashPoint, pid: number = process.pid): boolean {
  if (!cfg.armed || cfg.point !== point) return false;
  try {
    writeFileSync(cfg.marker, `${JSON.stringify({ pid, point, at: new Date().toISOString() })}\n`, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false; // already fired (EEXIST) or not creatable: never crash twice, never crash blindly
  }
}
