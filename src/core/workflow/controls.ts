import { TERMINAL_INSTANCE_STATES, type WorkflowInstance, type WorkflowInstanceState } from './types.ts';

/**
 * M5.2 — what a UI may offer for a workflow, derived in Core (docs/35 §3.2, ADR-010), the
 * workflow counterpart of desktop/shared/controls.ts `deriveControls`. The renderer never
 * decides availability itself. Pure: whether the workflow host is alive is an input
 * (the caller checks the workflow lock's pid).
 */

/** INTERRUPTED is derived, never persisted: RUNNING on disk, but the owning host is gone. */
export type WorkflowDisplayState = WorkflowInstanceState | 'INTERRUPTED';

export function deriveWorkflowDisplayState(instance: WorkflowInstance, hostAlive: boolean): WorkflowDisplayState {
  return instance.state === 'RUNNING' && !hostAlive ? 'INTERRUPTED' : instance.state;
}

export interface WorkflowControls {
  canStart: boolean;
  canPause: boolean;
  /** PAUSED → continue; BLOCKED → restart the same attempt; INTERRUPTED → re-host (reconciler, M5.6). */
  canResume: boolean;
  canStop: boolean;
  /** HUMAN_ANSWER values currently accepted (M5: fail, stop). */
  canAnswer: string[];
}

const NONE: WorkflowControls = { canStart: false, canPause: false, canResume: false, canStop: false, canAnswer: [] };

/** Answers the M5 decider accepts; `retry` (M6) and `resume-execution` (M5.6) are not offered.
 * `approve-bypass` (M5.10.1) appears only when the decider offered it (NEED_HUMAN, once per step). */
const M5_ANSWERS = ['fail', 'stop', 'approve-bypass'];

export function deriveWorkflowControls(instance: WorkflowInstance, context: { hostAlive: boolean }): WorkflowControls {
  const display = deriveWorkflowDisplayState(instance, context.hostAlive);
  if (TERMINAL_INSTANCE_STATES.includes(instance.state)) return { ...NONE };
  const stopPending = instance.stopRequested !== null;
  switch (display) {
    case 'CREATED':
      return { ...NONE, canStart: true, canStop: true };
    case 'RUNNING':
      return { ...NONE, canPause: !instance.pauseRequested && !stopPending, canStop: !stopPending };
    case 'INTERRUPTED':
      return { ...NONE, canResume: true, canStop: !stopPending };
    case 'PAUSED':
    case 'BLOCKED':
      return { ...NONE, canResume: !stopPending, canStop: !stopPending };
    case 'WAITING_HUMAN':
      return { ...NONE, canStop: !stopPending, canAnswer: stopPending ? [] : (instance.waitingFor?.options ?? []).filter((o) => M5_ANSWERS.includes(o)) };
    default:
      return { ...NONE };
  }
}
