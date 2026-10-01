import type { BridgeRecoveryCheck } from '../../core/bridge-engine.ts';
import type { ControlState, PendingAction } from './ipc-contract.ts';

export interface ControlInput {
  hasProject: boolean;
  /** `BridgeStatus.status` from Core, or null when no project is open. */
  status: string | null;
  /** `BridgeStatus.iteration` from Core (0 until the first iteration has started). */
  iteration: number;
  recovery: BridgeRecoveryCheck['kind'];
  pendingAction: PendingAction | null;
  pauseRequested: boolean;
  runAttached: boolean;
  /** M5.8: a workflow owns the project's executions (Core: the workflow lock / a RUNNING
   * instance). Its execution is controlled through the workflow, never the Run controls. */
  workflowActive?: boolean;
}

/**
 * Which of START / PAUSE / RESUME / STOP are usable right now (M4 §8). Computed in Main
 * from Core's own status and recovery answer, never by the renderer. Resume is only
 * ever offered when Core's `checkRecovery()` said RECOVERABLE.
 */
export function deriveControls(input: ControlInput): ControlState {
  const { hasProject, status, iteration, recovery, pendingAction, pauseRequested, runAttached } = input;
  if (input.workflowActive) return { canStart: false, canPause: false, canResume: false, stopMode: null };
  const running = status === 'RUNNING' || runAttached;
  const busy = pendingAction !== null;
  const unfinished = status === 'PAUSED' || status === 'INTERRUPTED';

  const canStart = hasProject && !busy && !running && status !== 'PAUSED' && !(status === 'INTERRUPTED' && recovery === 'RECOVERABLE');
  // Core honours a pause at its first safe boundary. Before iteration 1 has started that
  // boundary is PREFLIGHT, and Core's own recovery rule makes a session paused there
  // un-resumable (the task text is not persisted yet) — so PAUSE is only offered once
  // Core reports iteration ≥ 1, where a pause always lands on a resumable checkpoint.
  const canPause = hasProject && status === 'RUNNING' && iteration >= 1 && !busy && !pauseRequested;
  const canResume = hasProject && !busy && !running && unfinished && recovery === 'RECOVERABLE';

  let stopMode: ControlState['stopMode'] = null;
  // A pending pause can take up to a minute to land — stopping must stay possible.
  if (running && (pendingAction === null || pendingAction === 'pause')) stopMode = 'STOP';
  else if (hasProject && !busy && !running && unfinished) stopMode = 'DISCARD';

  return { canStart, canPause, canResume, stopMode };
}
