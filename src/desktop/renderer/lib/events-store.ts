import type { BridgeEvent, EventType } from '../../../core/observability/events.ts';

/** How many activity rows the renderer keeps (and renders) at most (M4 §32). */
export const MAX_ACTIVITY_EVENTS = 500;

export function eventKey(e: BridgeEvent): string {
  return `${e.timestamp}|${e.runId}|${e.iteration}|${e.event}|${e.phase}|${e.detail ?? ''}`;
}

/** Merges history + live events: de-duplicated (the same event can arrive both from
 * the initial history read and the live stream), ordered by time, bounded. */
export function mergeEvents(existing: readonly BridgeEvent[], incoming: readonly BridgeEvent[], max = MAX_ACTIVITY_EVENTS): BridgeEvent[] {
  const seen = new Set<string>();
  const merged: BridgeEvent[] = [];
  for (const e of [...existing, ...incoming]) {
    const key = eventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  merged.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

export type EventLevel = 'normal' | 'warning' | 'error';

const LABELS: Record<EventType, string> = {
  RUN_STARTED: 'Session started',
  RUN_STOPPED: 'Stopped',
  RUN_COMPLETED: 'Run completed',
  CLAUDE_STARTED: 'Claude step started',
  CLAUDE_EXITED: 'Claude CLI exited',
  REPORT_DETECTED: 'Report detected',
  REPORT_VALIDATED: 'Report validated',
  CODEX_STARTED: 'Codex step started',
  CODEX_EXITED: 'Codex CLI exited',
  RESPONSE_PARSED: 'Response parsed',
  PROMPT_SENT: 'Prompt written to Claude stdin',
  ITERATION_COMPLETED: 'Iteration completed',
  ERROR: 'Error',
  TIMEOUT: 'Timeout',
  RECOVERY_STARTED: 'Recovery started',
  RECOVERY_COMPLETED: 'Recovery completed',
  PAUSE_REQUESTED: 'Pause requested',
  PAUSED: 'Paused',
  PROMPT_PERSISTED: 'Claude prompt persisted',
  CLAUDE_PROCESS_STARTED: 'Claude CLI started',
  CLAUDE_SESSION_RESUMED: 'Claude session resumed',
  CLAUDE_FAILED: 'Claude CLI failed',
  CODEX_PROCESS_STARTED: 'Codex CLI started',
  CODEX_FAILED: 'Codex CLI failed',
};

export function describeEvent(e: BridgeEvent): { label: string; level: EventLevel } {
  let level: EventLevel = 'normal';
  if (e.event === 'ERROR' || e.event === 'TIMEOUT' || e.event === 'CLAUDE_FAILED' || e.event === 'CODEX_FAILED') level = 'error';
  else if (e.event === 'CLAUDE_SESSION_RESUMED' && e.continuity !== 'VERIFIED') level = 'warning';
  else if (e.event === 'RUN_COMPLETED' && e.phase === 'ERROR') level = 'error';
  else if ((e.event === 'CLAUDE_EXITED' || e.event === 'CODEX_EXITED') && /— error$/.test(e.detail ?? '')) level = 'error';
  else if (e.event === 'RUN_STOPPED' || e.event === 'PAUSE_REQUESTED' || e.event === 'PAUSED' || e.event === 'RECOVERY_STARTED') level = 'warning';
  else if (e.event === 'RUN_COMPLETED' && e.phase !== 'DONE') level = 'warning';
  const label = e.event === 'RUN_COMPLETED' && e.phase && e.phase !== 'DONE' ? `Run ended (${e.phase})` : LABELS[e.event];
  return { label, level };
}

/** Pipe/process-level lifecycle events: kept in the technical event log, left out of the
 * plain-language "Recent activity" feed (the milestone events already cover each step). */
const TECHNICAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['PROMPT_PERSISTED', 'CLAUDE_PROCESS_STARTED', 'PROMPT_SENT', 'CODEX_PROCESS_STARTED']);

export function isTechnicalEvent(e: BridgeEvent): boolean {
  return TECHNICAL_EVENTS.has(e.event);
}

const FRIENDLY: Record<EventType, string> = {
  RUN_STARTED: 'Run started',
  RUN_STOPPED: 'Run stopped',
  RUN_COMPLETED: 'Run completed',
  CLAUDE_STARTED: 'Claude started working',
  CLAUDE_EXITED: 'Claude finished',
  REPORT_DETECTED: 'Report generated',
  REPORT_VALIDATED: 'Report validated',
  CODEX_STARTED: 'ChatGPT started reviewing',
  CODEX_EXITED: 'ChatGPT finished reviewing',
  RESPONSE_PARSED: 'Review received',
  PROMPT_SENT: 'Prompt sent to Claude',
  ITERATION_COMPLETED: 'Round completed',
  ERROR: 'Error',
  TIMEOUT: 'Timed out',
  RECOVERY_STARTED: 'Recovery started',
  RECOVERY_COMPLETED: 'Recovery completed',
  PAUSE_REQUESTED: 'Pause requested',
  PAUSED: 'Paused',
  PROMPT_PERSISTED: 'Claude prompt saved',
  CLAUDE_PROCESS_STARTED: 'Claude CLI started',
  CLAUDE_SESSION_RESUMED: 'Claude continued its session',
  CLAUDE_FAILED: 'Claude failed',
  CODEX_PROCESS_STARTED: 'Codex CLI started',
  CODEX_FAILED: 'ChatGPT (Codex) failed',
};

/** The same event, worded for the plain-language feed. Level is identical to
 * `describeEvent`; the Core detail string is only surfaced for warnings/errors (where it
 * carries the reason), so routine rows stay one short line. */
export function humanizeEvent(e: BridgeEvent): { label: string; level: EventLevel; detail: string | null } {
  const { level } = describeEvent(e);
  let label = FRIENDLY[e.event];
  if (e.event === 'RUN_COMPLETED' && e.phase && e.phase !== 'DONE') label = `Run ended (${e.phase})`;
  else if ((e.event === 'CLAUDE_EXITED' || e.event === 'CODEX_EXITED') && level === 'error') label = e.event === 'CLAUDE_EXITED' ? 'Claude exited with an error' : 'ChatGPT (Codex) exited with an error';
  else if (e.event === 'CLAUDE_SESSION_RESUMED' && level === 'warning') label = 'Claude session continuity not verified';
  const detail = level !== 'normal' || e.event === 'RUN_STOPPED' ? (e.detail ?? null) : null;
  return { label, level, detail };
}
