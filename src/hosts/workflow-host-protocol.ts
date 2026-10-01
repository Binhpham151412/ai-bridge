import { KEBAB_CASE_ID, WORKFLOW_LIMITS } from '../core/workflow/definition.ts';
import { WORKFLOW_EVENT_TYPES, WORKFLOW_INSTANCE_STATES, isValidWorkflowId, type WorkflowEvent, type WorkflowInstanceState } from '../core/workflow/types.ts';

/**
 * M5.8 — messages between a parent (Electron Main's WorkflowController) and the Workflow Host
 * (ADR-011 option A), the workflow counterpart of desktop/main/run-host-protocol.ts.
 *
 * The first message a host receives is exactly one lifecycle command; after it was accepted,
 * the parent may send control requests (pause/stop) for the hosted workflow. The host reports
 * `accepted` or `rejected`, forwards every event it persisted, answers each control request,
 * and says `ended` once the workflow reached a resting state and the workflow lock is released.
 * Every decision is the WorkflowEngine's; nothing here decides anything.
 */

/** Stable error categories shared by the host, WorkflowController, IPC and the CLI. */
export const WORKFLOW_ERROR_CODES = [
  'INVALID_REQUEST',
  'DEFINITION_NOT_FOUND',
  'DEFINITION_INVALID',
  /** The definition file changed after the caller validated it (definitionHash mismatch). */
  'DEFINITION_CHANGED',
  'INPUTS_INVALID',
  'WORKFLOW_NOT_FOUND',
  'WORKFLOW_BROKEN',
  'WORKFLOW_INCOMPLETE',
  /** Another live Workflow Host holds the project's workflow lock. */
  'WORKFLOW_LOCKED',
  /** A workflow is RUNNING (hosted or interrupted) in this project — one active instance per project. */
  'WORKFLOW_ACTIVE',
  /** An ordinary run holds the project's run lock. */
  'RUN_ACTIVE',
  /** An ordinary run is PAUSED or recoverable (INTERRUPTED) — resume or discard it first. */
  'RUN_UNFINISHED',
  /** The WorkflowEngine refused the input in the workflow's current state. */
  'NOT_ALLOWED',
  /** The live Workflow Host serves a different workflow. */
  'NOT_HOSTED',
  /** The Workflow Host died or did not answer. */
  'HOST_UNAVAILABLE',
  'HOST_FAILED',
] as const;
export type WorkflowErrorCode = (typeof WORKFLOW_ERROR_CODES)[number];

export interface WorkflowHostError {
  code: WorkflowErrorCode;
  message: string;
  details?: string[];
}

/** HUMAN_ANSWER values the M5 decider accepts (controls.ts `M5_ANSWERS`). */
export const WORKFLOW_ANSWERS = ['fail', 'stop', 'approve-bypass'] as const;
export type WorkflowAnswer = (typeof WORKFLOW_ANSWERS)[number];

export const WORKFLOW_CONTROL_ACTIONS = ['pause', 'stop'] as const;
export type WorkflowControlAction = (typeof WORKFLOW_CONTROL_ACTIONS)[number];

export type WorkflowHostCommand =
  /** Create an instance of `<project>/.ai-bridge/workflows/definitions/<definitionId>.json` and start it.
   * `definitionHash` is the hash the caller validated; a changed file is refused (DEFINITION_CHANGED). */
  | { type: 'run'; projectPath: string; definitionId: string; definitionHash: string; inputs: Record<string, string> }
  /** Re-host an instance: reconcile it (M5.6) and continue — RESUME_REQUESTED when PAUSED/BLOCKED, START when CREATED. */
  | { type: 'resume'; projectPath: string; workflowId: string }
  | { type: 'answer'; projectPath: string; workflowId: string; answer: WorkflowAnswer }
  /** Stop an instance that no live host serves (a hosted one is stopped with a control request). */
  | { type: 'stop'; projectPath: string; workflowId: string };

export interface WorkflowHostControl {
  type: 'control';
  requestId: string;
  action: WorkflowControlAction;
}

export type WorkflowControlResult = { ok: true; state: WorkflowInstanceState } | { ok: false; error: WorkflowHostError };

export interface WorkflowHostEnd {
  workflowId: string;
  state: WorkflowInstanceState;
  /** REST = PAUSED/WAITING_HUMAN/BLOCKED/CREATED or terminal; STALLED = still RUNNING with nothing in flight. */
  reason: 'REST' | 'STALLED';
  /** Background errors the engine recorded (store/port failures), redacted by the sender. */
  errors: string[];
}

export type WorkflowHostMessage =
  | { type: 'accepted'; workflowId: string; state: WorkflowInstanceState }
  | { type: 'rejected'; error: WorkflowHostError }
  | { type: 'event'; event: WorkflowEvent }
  | { type: 'control-result'; requestId: string; result: WorkflowControlResult }
  | { type: 'ended'; end: WorkflowHostEnd }
  | { type: 'failed'; message: string };

// ---------------------------------------------------------------------------
// validation — both directions are checked; nothing received is trusted
// ---------------------------------------------------------------------------

export const DEFINITION_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const CONTROL_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Declared inputs per definition are bounded by the definition itself; this only bounds the payload. */
export const MAX_INPUT_FIELDS = 64;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOnly(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((k) => keys.includes(k));
}

export function isDefinitionId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= WORKFLOW_LIMITS.maxIdLength && KEBAB_CASE_ID.test(v);
}

/** Input values as supplied: kebab-case names, strings only (docs/36 §3.3 — `type: "string"`). */
export function isWorkflowInputValues(v: unknown): v is Record<string, string> {
  if (!isObject(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const entries = Object.entries(v);
  if (entries.length > MAX_INPUT_FIELDS) return false;
  return entries.every(([k, value]) => isDefinitionId(k) && typeof value === 'string' && value.length <= WORKFLOW_LIMITS.maxTextBytes && !value.includes('\u0000'));
}

export function isWorkflowHostCommand(v: unknown): v is WorkflowHostCommand {
  if (!isObject(v) || typeof v.projectPath !== 'string' || v.projectPath === '') return false;
  switch (v.type) {
    case 'run':
      return hasOnly(v, ['type', 'projectPath', 'definitionId', 'definitionHash', 'inputs']) && isDefinitionId(v.definitionId) && typeof v.definitionHash === 'string' && DEFINITION_HASH_PATTERN.test(v.definitionHash) && isWorkflowInputValues(v.inputs);
    case 'resume':
    case 'stop':
      return hasOnly(v, ['type', 'projectPath', 'workflowId']) && isValidWorkflowId(v.workflowId);
    case 'answer':
      return hasOnly(v, ['type', 'projectPath', 'workflowId', 'answer']) && isValidWorkflowId(v.workflowId) && (WORKFLOW_ANSWERS as readonly unknown[]).includes(v.answer);
    default:
      return false;
  }
}

export function isWorkflowHostControl(v: unknown): v is WorkflowHostControl {
  return isObject(v) && v.type === 'control' && hasOnly(v, ['type', 'requestId', 'action']) && typeof v.requestId === 'string' && CONTROL_REQUEST_ID_PATTERN.test(v.requestId) && (WORKFLOW_CONTROL_ACTIONS as readonly unknown[]).includes(v.action);
}

const isState = (v: unknown): v is WorkflowInstanceState => (WORKFLOW_INSTANCE_STATES as readonly unknown[]).includes(v);

function isHostError(v: unknown): v is WorkflowHostError {
  return isObject(v) && (WORKFLOW_ERROR_CODES as readonly unknown[]).includes(v.code) && typeof v.message === 'string' && (v.details === undefined || (Array.isArray(v.details) && v.details.every((d) => typeof d === 'string')));
}

/** Structural check of a sealed workflow event (the hash chain itself is verified on read from disk). */
export function isWorkflowEventShape(v: unknown): v is WorkflowEvent {
  return (
    isObject(v) &&
    (WORKFLOW_EVENT_TYPES as readonly unknown[]).includes(v.type) &&
    isValidWorkflowId(v.workflowId) &&
    typeof v.seq === 'number' &&
    Number.isInteger(v.seq) &&
    v.seq > 0 &&
    typeof v.eventId === 'string' &&
    typeof v.timestamp === 'string' &&
    typeof v.hash === 'string' &&
    (v.prevHash === null || typeof v.prevHash === 'string') &&
    isObject(v.payload)
  );
}

export function isWorkflowHostMessage(v: unknown): v is WorkflowHostMessage {
  if (!isObject(v)) return false;
  switch (v.type) {
    case 'accepted':
      return isValidWorkflowId(v.workflowId) && isState(v.state);
    case 'rejected':
      return isHostError(v.error);
    case 'event':
      return isWorkflowEventShape(v.event);
    case 'control-result': {
      const r = v.result;
      return typeof v.requestId === 'string' && isObject(r) && (r.ok === true ? isState(r.state) : r.ok === false && isHostError(r.error));
    }
    case 'ended': {
      const e = v.end;
      return isObject(e) && isValidWorkflowId(e.workflowId) && isState(e.state) && (e.reason === 'REST' || e.reason === 'STALLED') && Array.isArray(e.errors) && e.errors.every((x) => typeof x === 'string');
    }
    case 'failed':
      return typeof v.message === 'string';
    default:
      return false;
  }
}
