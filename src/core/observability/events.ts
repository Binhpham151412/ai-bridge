import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export const EVENT_TYPES = [
  'RUN_STARTED',
  'RUN_STOPPED',
  'RUN_COMPLETED',
  'CLAUDE_STARTED',
  'CLAUDE_EXITED',
  'REPORT_DETECTED',
  'REPORT_VALIDATED',
  'CODEX_STARTED',
  'CODEX_EXITED',
  'RESPONSE_PARSED',
  'PROMPT_SENT',
  'ITERATION_COMPLETED',
  'ERROR',
  'TIMEOUT',
  'RECOVERY_STARTED',
  'RECOVERY_COMPLETED',
  'PAUSE_REQUESTED',
  'PAUSED',
  // M4.1 execution lifecycle — each names exactly what was observed, nothing more.
  'PROMPT_PERSISTED',
  'CLAUDE_PROCESS_STARTED',
  'CLAUDE_SESSION_RESUMED',
  'CLAUDE_FAILED',
  'CODEX_PROCESS_STARTED',
  'CODEX_FAILED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface BridgeEvent {
  timestamp: string;
  runId: string;
  iteration: number;
  phase: string;
  event: EventType;
  detail?: string;
  [extra: string]: unknown;
}

const DEFAULT_MESSAGES: Record<EventType, string> = {
  RUN_STARTED: 'Run started',
  RUN_STOPPED: 'Run stopped',
  RUN_COMPLETED: 'Run completed',
  CLAUDE_STARTED: 'Claude started',
  CLAUDE_EXITED: 'Claude exited',
  REPORT_DETECTED: 'Report detected',
  REPORT_VALIDATED: 'Report validated',
  CODEX_STARTED: 'Codex started',
  CODEX_EXITED: 'Codex exited',
  RESPONSE_PARSED: 'Codex response parsed',
  PROMPT_SENT: 'Prompt sent',
  ITERATION_COMPLETED: 'Iteration completed',
  ERROR: 'Error',
  TIMEOUT: 'Timeout',
  RECOVERY_STARTED: 'Recovery started',
  RECOVERY_COMPLETED: 'Recovery completed',
  PAUSE_REQUESTED: 'Pause requested',
  PAUSED: 'Paused',
  PROMPT_PERSISTED: 'Claude prompt persisted',
  CLAUDE_PROCESS_STARTED: 'Claude CLI process started',
  CLAUDE_SESSION_RESUMED: 'Claude CLI session resumed',
  CLAUDE_FAILED: 'Claude CLI failed',
  CODEX_PROCESS_STARTED: 'Codex CLI process started',
  CODEX_FAILED: 'Codex CLI failed',
};

const ERROR_LEVEL_EVENTS: readonly EventType[] = ['ERROR', 'TIMEOUT', 'CLAUDE_FAILED', 'CODEX_FAILED'];

/**
 * Simple single-backup rotation: if `filePath` is already at or over `maxBytes`, moves
 * it to `<filePath>.1` (overwriting any previous backup) and leaves nothing at the
 * original path — the caller's next write recreates it fresh. Bounds a long-running
 * project's log growth to roughly 2x maxBytes (current + one backup) rather than
 * unbounded (M3.5 §15). A no-op when the file doesn't exist yet or is under the limit.
 */
export async function rotateIfOversized(filePath: string, maxBytes: number): Promise<void> {
  const size = await stat(filePath).then((s) => s.size).catch(() => null);
  if (size === null || size < maxBytes) return;
  await rename(filePath, `${filePath}.1`);
}

export async function appendEvent(filePath: string, event: BridgeEvent, options: { maxBytes?: number } = {}): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (options.maxBytes !== undefined) await rotateIfOversized(filePath, options.maxBytes);
  await appendFile(filePath, JSON.stringify(event) + '\n', 'utf8');
}

/** e.g. "19:42:01 [INFO] Iteration 1: Report 001 validated" */
export function formatHumanLogLine(event: BridgeEvent): string {
  const time = event.timestamp.slice(11, 19);
  const level = ERROR_LEVEL_EVENTS.includes(event.event) ? 'ERROR' : 'INFO';
  const message = event.detail ?? DEFAULT_MESSAGES[event.event];
  const prefix = event.iteration > 0 ? `Iteration ${event.iteration}: ` : '';
  return `${time} [${level}] ${prefix}${message}`;
}
