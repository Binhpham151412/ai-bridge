/**
 * The full set of states this project's orchestrator actually uses. Names follow the
 * existing `OrchestratorState` (M1/M2) rather than the M3 spec's alternate vocabulary
 * where an equivalent already existed (e.g. REPORT_DETECTED ~= the spec's
 * CLAUDE_COMPLETED+report-detected step; the spec explicitly permits this: "Không cần
 * dùng state nào nếu implementation hiện tại đã có tên tương đương"). PAUSED and
 * RECOVERING are new in M3.
 */
export type BridgeState =
  | 'IDLE'
  | 'RECOVERING'
  | 'PREFLIGHT'
  | 'CLAUDE_EXECUTING'
  | 'REPORT_DETECTED'
  | 'REPORT_VALIDATED'
  | 'CODEX_REVIEWING'
  | 'CODEX_RESPONSE_RECEIVED'
  | 'RESPONSE_PARSED'
  | 'DONE'
  | 'NEED_HUMAN'
  | 'ERROR'
  | 'STOPPED'
  | 'STOPPED_MAX_ITERATIONS'
  | 'PAUSED';

/**
 * Traced directly from every `push()`/state-producing call site in
 * `src/core/orchestrator/orchestrator.ts` (see that file's comments for the exact line
 * references) — this table is the actual reachable transition graph, not an aspirational
 * one. PAUSED/RECOVERING entries reflect the M3 pause/recovery design
 * (docs/06-recovery-design.md): pause is only honored at the same "safe boundary" points
 * shouldStop already uses (PREFLIGHT, before any iteration starts; RESPONSE_PARSED,
 * between iterations) — never mid-flight.
 */
const TRANSITIONS: Record<BridgeState, readonly BridgeState[]> = {
  IDLE: ['RECOVERING', 'PREFLIGHT', 'ERROR'],
  RECOVERING: ['PREFLIGHT'],
  PREFLIGHT: ['CLAUDE_EXECUTING', 'REPORT_DETECTED', 'ERROR', 'STOPPED', 'PAUSED', 'STOPPED_MAX_ITERATIONS'],
  CLAUDE_EXECUTING: ['REPORT_DETECTED', 'ERROR'],
  REPORT_DETECTED: ['REPORT_VALIDATED', 'ERROR'],
  REPORT_VALIDATED: ['CODEX_REVIEWING', 'ERROR'],
  CODEX_REVIEWING: ['CODEX_RESPONSE_RECEIVED', 'ERROR'],
  CODEX_RESPONSE_RECEIVED: ['RESPONSE_PARSED'],
  RESPONSE_PARSED: ['CLAUDE_EXECUTING', 'DONE', 'NEED_HUMAN', 'ERROR', 'STOPPED', 'PAUSED', 'STOPPED_MAX_ITERATIONS'],
  PAUSED: ['CLAUDE_EXECUTING', 'REPORT_DETECTED', 'STOPPED'],
  DONE: [],
  NEED_HUMAN: [],
  ERROR: [],
  STOPPED: [],
  STOPPED_MAX_ITERATIONS: [],
};

export function isValidTransition(from: BridgeState, to: BridgeState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertValidTransition(from: BridgeState, to: BridgeState): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`INVALID_STATE_TRANSITION: ${from} -> ${to} is not allowed`);
  }
}
