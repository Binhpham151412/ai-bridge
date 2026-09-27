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
