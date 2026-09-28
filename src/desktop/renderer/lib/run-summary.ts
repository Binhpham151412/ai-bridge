import type { BridgeSnapshot } from '../../shared/ipc-contract.ts';
import type { Tone } from './format.ts';

/**
 * Plain-language presentation of what Core reports — presentation only. Every sentence
 * is picked from a fixed table keyed by Core's own values (`BridgeStatus.status`,
 * `currentPhase`, `activity`, `iteration`, `pauseRequested`, `recovery`, `lastError`);
 * nothing here guesses what Claude or ChatGPT is "really" doing. When the state is not
 * one of the known values the text falls back to a neutral "Processing…".
 */

export interface Headline {
  /** One sentence answering "what is AI Bridge doing right now?". */
  text: string;
  /** Optional second line (e.g. a pending pause, the error title). */
  note: string | null;
  tone: Tone;
}

const PIPELINE_PHASES = ['CLAUDE_EXECUTING', 'REPORT_DETECTED', 'REPORT_VALIDATED', 'CODEX_REVIEWING', 'CODEX_RESPONSE_RECEIVED', 'RESPONSE_PARSED'] as const;

function runningText(phase: string | null, iteration: number): string {
  switch (phase) {
    case 'PREFLIGHT':
      return 'Running pre-flight checks…';
    case 'RECOVERING':
      return 'Recovering the interrupted session…';
    case 'CLAUDE_EXECUTING':
      // From round 2 on, Claude's prompt is exactly the PROMPT block ChatGPT returned in
      // the previous round (Core forwards it byte-for-byte), so this claim is structural.
      return iteration > 1 ? `Claude is working on the changes ChatGPT requested in round ${iteration - 1}.` : 'Claude is working on the task.';
    case 'REPORT_DETECTED':
      return 'Claude produced its report — AI Bridge is validating it.';
    case 'REPORT_VALIDATED':
      return 'Report validated — handing it to ChatGPT for review.';
    case 'CODEX_REVIEWING':
      return "ChatGPT is reviewing Claude's report.";
    case 'CODEX_RESPONSE_RECEIVED':
      return 'ChatGPT replied — AI Bridge is reading the review.';
    case 'RESPONSE_PARSED':
      return "ChatGPT's review was processed — deciding the next step.";
    default:
      return 'Processing…';
  }
}

/**
 * `endDetail` is the `detail` of this session's own final RUN_COMPLETED / RUN_STOPPED
 * event (Core writes the errorCode / stop reason there). It fills the note for ERROR and
 * STOPPED when this app instance has no `lastError` — e.g. after a restart.
 */
export function describeHeadline(snapshot: BridgeSnapshot | null, endDetail: string | null = null): Headline {
  if (!snapshot) return { text: 'Connecting to AI Bridge…', note: null, tone: 'idle' };
  if (!snapshot.project) return { text: 'No project selected.', note: null, tone: 'idle' };
  const status = snapshot.status;
  if (!status || status.status === 'NOT_STARTED') return { text: 'Ready. Start a run to begin.', note: null, tone: 'idle' };

  switch (status.status) {
    case 'RUNNING': {
      let note: string | null = null;
      if (snapshot.pauseRequested) note = 'Pause requested — AI Bridge will pause at the next safe point.';
      else if (!snapshot.runAttached) note = 'This run is managed by another process (CLI or an earlier app session) — status refreshes periodically, without live events.';
      return { text: runningText(status.currentPhase, status.iteration), note, tone: 'active' };
    }
    case 'DONE':
      return { text: 'Run completed — ChatGPT marked the work as done.', note: null, tone: 'success' };
    case 'NEED_HUMAN':
      return { text: 'Run stopped — ChatGPT asked for a human decision.', note: null, tone: 'warning' };
    case 'STOPPED_MAX_ITERATIONS':
      return { text: 'Run stopped — the maximum number of review rounds was reached.', note: null, tone: 'warning' };
    case 'STOPPED':
      return { text: 'Run stopped.', note: endDetail, tone: 'warning' };
    case 'ERROR':
      return { text: 'Run failed.', note: snapshot.lastError?.title ?? endDetail, tone: 'danger' };
    case 'PAUSED':
      return { text: 'Run paused.', note: snapshot.recovery.kind === 'RECOVERABLE' ? 'Resume to continue from the last safe point.' : null, tone: 'paused' };
    case 'INTERRUPTED': {
      let note: string | null = null;
      if (snapshot.recovery.kind === 'RECOVERABLE') note = 'It can be resumed from the last safe point.';
      else if (snapshot.recovery.kind === 'BLOCKED') note = 'It cannot be resumed — see the reason above.';
      return { text: 'Run was interrupted.', note, tone: 'danger' };
    }
    default:
      return { text: `Status: ${status.status}`, note: null, tone: 'idle' };
  }
}

export interface AgentLine {
  /** Short state word shown in the pill (Working / Reviewing / Waiting / Idle). */
  label: string;
  /** The raw Core activity value, kept for tone + tooltip. */
  raw: string;
  /** One line of context, derived from the same Core phase. */
  detail: string;
}

const ACTIVITY_LABEL: Record<string, string> = { EXECUTING: 'Working', REVIEWING: 'Reviewing', WAITING: 'Waiting', IDLE: 'Idle' };

export function describeAgent(agent: 'claude' | 'codex', snapshot: BridgeSnapshot | null): AgentLine {
  const status = snapshot?.status ?? null;
  const raw = (agent === 'claude' ? status?.activity.claude : status?.activity.codex) ?? 'IDLE';
  const phase = status?.currentPhase ?? null;
  const round = status?.iteration ?? 0;
  let detail = 'Not running';
  if (raw === 'EXECUTING') detail = round > 0 ? `Working on round ${round}` : 'Working';
  else if (raw === 'REVIEWING') detail = round > 0 ? `Reviewing Claude's report for round ${round}` : "Reviewing Claude's report";
  else if (raw === 'WAITING') {
    if (agent === 'claude') {
      if (phase === 'CODEX_REVIEWING' || phase === 'CODEX_RESPONSE_RECEIVED') detail = "Waiting for ChatGPT's review";
      else if (phase === 'REPORT_DETECTED' || phase === 'REPORT_VALIDATED') detail = 'Report submitted';
      else detail = 'Waiting';
    } else if (phase === 'CLAUDE_EXECUTING') detail = "Waiting for Claude's report";
    else if (phase === 'REPORT_DETECTED') detail = 'Waiting for the report to be validated';
    else if (phase === 'REPORT_VALIDATED') detail = 'Report ready for review';
    else detail = 'Waiting';
  }
  return { label: ACTIVITY_LABEL[raw] ?? raw, raw, detail };
}

export type StepState = 'done' | 'active' | 'todo';

export interface RoundStep {
  label: string;
  state: StepState;
}

const STEP_LABELS = ['Claude works', 'Report validated', 'ChatGPT reviews', 'Verdict'] as const;

/**
 * The four stages of one review round, positioned by Core's live phase. Only meaningful
 * while a run is RUNNING inside a round; returns null otherwise (the caller then shows
 * the round's recorded outcome from the journal instead of a guessed stepper).
 */
export function roundSteps(snapshot: BridgeSnapshot | null): RoundStep[] | null {
  const status = snapshot?.status;
  if (status?.status !== 'RUNNING') return null;
  const idx = (PIPELINE_PHASES as readonly string[]).indexOf(status.currentPhase ?? '');
  if (idx === -1) return null;
  // Phase index → [stages finished, stage in progress].
  const plan: [number, number | null][] = [
    [0, 0], // CLAUDE_EXECUTING
    [1, 1], // REPORT_DETECTED — validating
    [2, null], // REPORT_VALIDATED — review about to start
    [2, 2], // CODEX_REVIEWING
    [3, 3], // CODEX_RESPONSE_RECEIVED — reading the verdict
    [4, null], // RESPONSE_PARSED
  ];
  const [done, active] = plan[idx];
  return STEP_LABELS.map((label, i) => ({ label, state: i < done ? 'done' : i === active ? 'active' : 'todo' }));
}

export const ROUND_STATE_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  RUNNING: 'Running',
  FAILED: 'Failed',
  INTERRUPTED: 'Interrupted',
  STOPPED: 'Stopped',
  INCOMPLETE: 'Incomplete',
};

export const ROUND_STATE_MARK: Record<string, string> = {
  COMPLETED: '✓',
  RUNNING: '●',
  FAILED: '✗',
  INTERRUPTED: '✗',
  STOPPED: '■',
  INCOMPLETE: '◌',
};

/** Tone for a journal RoundState — reuses the status palette. */
export function roundTone(state: string): Tone {
  switch (state) {
    case 'COMPLETED':
      return 'success';
    case 'RUNNING':
      return 'active';
    case 'FAILED':
    case 'INTERRUPTED':
      return 'danger';
    case 'STOPPED':
    case 'INCOMPLETE':
      return 'warning';
    default:
      return 'idle';
  }
}

export const VERDICT_LABEL: Record<string, string> = {
  CONTINUE: 'ChatGPT: continue',
  DONE: 'ChatGPT: done',
  NEED_HUMAN: 'ChatGPT: needs a human',
};

/** Friendly word for a Core run status, for headers and pickers. */
const STATUS_LABEL: Record<string, string> = {
  RUNNING: 'Running',
  DONE: 'Completed',
  NEED_HUMAN: 'Needs human',
  ERROR: 'Failed',
  STOPPED: 'Stopped',
  STOPPED_MAX_ITERATIONS: 'Max rounds reached',
  PAUSED: 'Paused',
  INTERRUPTED: 'Interrupted',
  NOT_STARTED: 'Not started',
  UNKNOWN: 'Unknown',
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return STATUS_LABEL[status] ?? status;
}
