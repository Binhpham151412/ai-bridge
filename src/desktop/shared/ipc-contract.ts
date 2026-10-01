import type { BridgeConfigView, BridgeRecoveryCheck, BridgeStatus } from '../../core/bridge-engine.ts';
import type { DoctorReport } from '../../core/preflight/doctor.ts';
import type { BridgeEvent } from '../../core/observability/events.ts';
import type { ExecutionOutput, SessionArtifacts, SessionSummary } from '../../core/session-history/session-history.ts';
import { JOURNAL_ENTRY_KINDS, type JournalEntryKind } from '../../core/journal/journal-types.ts';
import type { JournalEntry, JournalIndex } from '../../core/journal/journal.ts';
import type { WorkflowAttemptView, WorkflowDefinitionSummary, WorkflowEvent, WorkflowListItem, WorkflowSnapshot } from '../../hosts/workflow-read.ts';

/**
 * The typed IPC contract between Renderer ⇄ Preload ⇄ Main (M4 §21). Every channel the
 * renderer can reach is listed here — Main registers a handler for exactly these and
 * nothing else, and Preload exposes one fixed function per channel (never a generic
 * `invoke(channel, ...)`). Type-only imports from Core: this module has no runtime
 * dependency on Node, Electron, or Core, so the sandboxed renderer can share it.
 */

export const INVOKE_CHANNELS = [
  'bridge:getSnapshot',
  'bridge:start',
  'bridge:pause',
  'bridge:resume',
  'bridge:stop',
  'bridge:discard',
  'bridge:doctor',
  'bridge:getRecentEvents',
  'bridge:listSessions',
  'bridge:getSessionArtifacts',
  'bridge:getExecutionOutput',
  'bridge:selectProject',
  'bridge:getSettings',
  'bridge:saveProjectConfig',
  'bridge:setDefaultProject',
  'bridge:getJournal',
  'bridge:getJournalEntry',
  // M5.8 (docs/35 §3.3): workflows — appended; the 17 channels above are unchanged.
  'workflow:getSnapshot',
  'workflow:list',
  'workflow:get',
  'workflow:getEvents',
  'workflow:getAttempt',
  'workflow:getJournal',
  'workflow:listDefinitions',
  'workflow:start',
  'workflow:pause',
  'workflow:resume',
  'workflow:stop',
  'workflow:answer',
] as const;
export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** Main → Renderer pushes. The renderer can only listen on these, never send. */
export const PUSH_CHANNELS = ['bridge:event', 'bridge:snapshot', 'workflow:event', 'workflow:snapshot'] as const;
export type PushChannel = (typeof PUSH_CHANNELS)[number];

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && (INVOKE_CHANNELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Shared payload types
// ---------------------------------------------------------------------------

/** A user-facing error: a short title, a plain message, optional technical details
 * (shown only behind "View details"). Never contains a stack trace or a secret. */
export interface UiError {
  code: string;
  title: string;
  message: string;
  details?: string;
}

export type ActionResponse = { ok: true; message?: string } | { ok: false; error: UiError };
export type DataResponse<T> = { ok: true; data: T } | { ok: false; error: UiError };

export type PendingAction = 'start' | 'pause' | 'resume' | 'stop' | 'discard';

export interface ControlState {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  /** STOP button meaning: stop a live run through Core's process management, or end a
   * paused/interrupted session (Core `reset()`, artifacts kept). Null = disabled. */
  stopMode: 'STOP' | 'DISCARD' | null;
}

export interface RunOutcomeSummary {
  kind: string;
  finalStatus: string | null;
  iterations: number | null;
  errorCode: string | null;
}

export interface ProjectInfo {
  path: string;
  name: string;
}

/** Everything the dashboard renders, assembled by Main from Core calls only. */
export interface BridgeSnapshot {
  project: ProjectInfo | null;
  status: BridgeStatus | null;
  recovery: BridgeRecoveryCheck;
  controls: ControlState;
  pendingAction: PendingAction | null;
  pauseRequested: boolean;
  /** True while a run host started by this app instance is alive (live events flow). */
  runAttached: boolean;
  lastError: UiError | null;
  lastOutcome: RunOutcomeSummary | null;
}

export interface SettingsView {
  app: { defaultProjectPath: string | null };
  project: BridgeConfigView | null;
  /** Log handling is Core's (fixed rotation, not configurable) — shown read-only. */
  logs: { maxFileBytes: number };
}

// ---------------------------------------------------------------------------
// Workflows (M5.8) — data only: states, availability (`controls`) and evidence levels all
// come from Core; the renderer never derives them (docs/35 §4, ADR-010)
// ---------------------------------------------------------------------------

export type { WorkflowAttemptView, WorkflowDefinitionSummary, WorkflowEvent, WorkflowListItem, WorkflowSnapshot };

export type WorkflowPendingAction = 'start' | 'pause' | 'resume' | 'stop' | 'answer';

/** What the workflow panel shows, assembled by Main's WorkflowController from Core reads. */
export interface WorkflowPanelSnapshot {
  project: ProjectInfo | null;
  /** The workflow followed: the one this app last acted on, else the hosted/running one, else the newest. */
  workflow: WorkflowSnapshot | null;
  /** Core-derived mutual-exclusion facts (the workflow lock + persisted RUNNING instances). */
  activity: { hostPid: number | null; hostedWorkflowId: string | null; running: string[] };
  /** Whether a NEW workflow may start now; the reason when it may not. */
  canStartNew: boolean;
  startBlockedBy: UiError | null;
  /** True while a Workflow Host started by this app instance is alive (live workflow events flow). */
  attached: boolean;
  pendingAction: WorkflowPendingAction | null;
  lastError: UiError | null;
}

export interface WorkflowJournalView {
  workflowId: string;
  markdown: string;
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface StartRunRequest {
  task: string;
  maxIterations?: number;
}
export interface RecentEventsRequest {
  limit: number;
}
export interface SessionArtifactsRequest {
  runId: string;
}
export interface ExecutionOutputRequest {
  runId: string;
  iteration: number;
  agent: 'claude' | 'codex';
  stream: 'stdout' | 'stderr';
}
export interface SaveProjectConfigRequest {
  config: Record<string, unknown>;
}
export interface SetDefaultProjectRequest {
  /** true = forget the default; false = make the currently open project the default.
   * The renderer never sends a path — only the native picker (Main) produces one. */
  clear: boolean;
}
export interface GetJournalRequest {
  runId: string;
}
export interface GetJournalEntryRequest {
  runId: string;
  kind: JournalEntryKind;
  /** Omit for SESSION_INDEX/FINAL_REPORT (session-level entries); required otherwise. */
  iteration?: number;
}

export interface WorkflowIdRequest {
  workflowId: string;
}
export interface WorkflowEventsRequest {
  workflowId: string;
  /** Events with seq > afterSeq (0 = from the start). */
  afterSeq: number;
  limit: number;
}
export interface WorkflowAttemptRequest {
  attemptId: string;
}
export interface WorkflowStartRequest {
  /** `<project>/.ai-bridge/workflows/definitions/<definitionId>.json` (ADR-018). */
  definitionId: string;
  /** The hash from workflow:listDefinitions — a definition changed since is refused. */
  definitionHash: string;
  /** Declared input values only; checked against the definition in Main before anything starts. */
  inputs: Record<string, string>;
}
export interface WorkflowAnswerRequest {
  workflowId: string;
  /** The HUMAN_ANSWER values M5 accepts. */
  /** `approve-bypass` (M5.10.1): re-run the step that asked for a human with permission bypass. */
  answer: 'fail' | 'stop' | 'approve-bypass';
}

export interface InvokeContract {
  'bridge:getSnapshot': { request: void; response: DataResponse<BridgeSnapshot> };
  'bridge:start': { request: StartRunRequest; response: ActionResponse };
  'bridge:pause': { request: void; response: ActionResponse };
  'bridge:resume': { request: void; response: ActionResponse };
  'bridge:stop': { request: void; response: ActionResponse };
  'bridge:discard': { request: void; response: ActionResponse };
  'bridge:doctor': { request: void; response: DataResponse<DoctorReport> };
  'bridge:getRecentEvents': { request: RecentEventsRequest; response: DataResponse<BridgeEvent[]> };
  'bridge:listSessions': { request: void; response: DataResponse<SessionSummary[]> };
  'bridge:getSessionArtifacts': { request: SessionArtifactsRequest; response: DataResponse<SessionArtifacts> };
  'bridge:getExecutionOutput': { request: ExecutionOutputRequest; response: DataResponse<ExecutionOutput> };
  'bridge:selectProject': { request: void; response: ActionResponse };
  'bridge:getSettings': { request: void; response: DataResponse<SettingsView> };
  'bridge:saveProjectConfig': { request: SaveProjectConfigRequest; response: ActionResponse };
  'bridge:setDefaultProject': { request: SetDefaultProjectRequest; response: ActionResponse };
  'bridge:getJournal': { request: GetJournalRequest; response: DataResponse<JournalIndex> };
  'bridge:getJournalEntry': { request: GetJournalEntryRequest; response: DataResponse<JournalEntry> };
  'workflow:getSnapshot': { request: void; response: DataResponse<WorkflowPanelSnapshot> };
  'workflow:list': { request: void; response: DataResponse<WorkflowListItem[]> };
  'workflow:get': { request: WorkflowIdRequest; response: DataResponse<WorkflowSnapshot> };
  'workflow:getEvents': { request: WorkflowEventsRequest; response: DataResponse<WorkflowEvent[]> };
  'workflow:getAttempt': { request: WorkflowAttemptRequest; response: DataResponse<WorkflowAttemptView> };
  'workflow:getJournal': { request: WorkflowIdRequest; response: DataResponse<WorkflowJournalView> };
  'workflow:listDefinitions': { request: void; response: DataResponse<WorkflowDefinitionSummary[]> };
  'workflow:start': { request: WorkflowStartRequest; response: DataResponse<{ workflowId: string }> };
  'workflow:pause': { request: WorkflowIdRequest; response: ActionResponse };
  'workflow:resume': { request: WorkflowIdRequest; response: ActionResponse };
  'workflow:stop': { request: WorkflowIdRequest; response: ActionResponse };
  'workflow:answer': { request: WorkflowAnswerRequest; response: ActionResponse };
}

export type RequestOf<C extends InvokeChannel> = InvokeContract[C]['request'];
export type ResponseOf<C extends InvokeChannel> = InvokeContract[C]['response'];

export interface PushContract {
  'bridge:event': BridgeEvent;
  'bridge:snapshot': BridgeSnapshot;
  'workflow:event': WorkflowEvent;
  'workflow:snapshot': WorkflowPanelSnapshot;
}

// ---------------------------------------------------------------------------
// Validation (run in Main on every request — the renderer is never trusted)
// ---------------------------------------------------------------------------

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

export const MAX_TASK_LENGTH = 20_000;
export const MAX_ITERATIONS_LIMIT = 100; // same cap as Core's MAX_RUN_ITERATIONS (config validation + start())
export const MAX_RECENT_EVENTS = 1000;
const RUN_ID = /^\d{4}-\d{2}-\d{2}_\d{3}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `unexpected field(s): ${extra.join(', ')}` : null;
}

function noPayload(payload: unknown): Validation<void> {
  return payload === undefined || payload === null ? { ok: true, value: undefined } : { ok: false, reason: 'this request takes no payload' };
}

function validateStart(payload: unknown): Validation<StartRunRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['task', 'maxIterations']);
  if (extra) return { ok: false, reason: extra };
  const { task, maxIterations } = payload;
  if (typeof task !== 'string' || task.trim() === '') return { ok: false, reason: 'task must be a non-empty string' };
  if (task.length > MAX_TASK_LENGTH) return { ok: false, reason: `task must be at most ${MAX_TASK_LENGTH} characters` };
  if (task.includes('\u0000')) return { ok: false, reason: 'task must not contain NUL characters' };
  if (maxIterations !== undefined && (typeof maxIterations !== 'number' || !Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > MAX_ITERATIONS_LIMIT)) {
    return { ok: false, reason: `maxIterations must be an integer between 1 and ${MAX_ITERATIONS_LIMIT}` };
  }
  return { ok: true, value: maxIterations === undefined ? { task } : { task, maxIterations } };
}

function validateRecentEvents(payload: unknown): Validation<RecentEventsRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['limit']);
  if (extra) return { ok: false, reason: extra };
  const { limit } = payload;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_RECENT_EVENTS) {
    return { ok: false, reason: `limit must be an integer between 1 and ${MAX_RECENT_EVENTS}` };
  }
  return { ok: true, value: { limit } };
}

function validateSessionArtifacts(payload: unknown): Validation<SessionArtifactsRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['runId']);
  if (extra) return { ok: false, reason: extra };
  const { runId } = payload;
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return { ok: false, reason: 'runId must look like YYYY-MM-DD_NNN' };
  return { ok: true, value: { runId } };
}

function validateExecutionOutput(payload: unknown): Validation<ExecutionOutputRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['runId', 'iteration', 'agent', 'stream']);
  if (extra) return { ok: false, reason: extra };
  const { runId, iteration, agent, stream } = payload;
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return { ok: false, reason: 'runId must look like YYYY-MM-DD_NNN' };
  if (typeof iteration !== 'number' || !Number.isInteger(iteration) || iteration < 1 || iteration > 999) return { ok: false, reason: 'iteration must be an integer between 1 and 999' };
  if (agent !== 'claude' && agent !== 'codex') return { ok: false, reason: 'agent must be claude or codex' };
  if (stream !== 'stdout' && stream !== 'stderr') return { ok: false, reason: 'stream must be stdout or stderr' };
  return { ok: true, value: { runId, iteration, agent, stream } };
}

function validateSaveConfig(payload: unknown): Validation<SaveProjectConfigRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['config']);
  if (extra) return { ok: false, reason: extra };
  const { config } = payload;
  if (!isPlainObject(config)) return { ok: false, reason: 'config must be an object' };
  if (Object.keys(config).length > 32) return { ok: false, reason: 'config has too many fields' };
  // Field-level rules (names, ranges) are Core's: BridgeEngine.saveConfig → validateConfig.
  return { ok: true, value: { config } };
}

function validateSetDefault(payload: unknown): Validation<SetDefaultProjectRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['clear']);
  if (extra) return { ok: false, reason: extra };
  if (typeof payload.clear !== 'boolean') return { ok: false, reason: 'clear must be a boolean' };
  return { ok: true, value: { clear: payload.clear } };
}

function validateGetJournal(payload: unknown): Validation<GetJournalRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['runId']);
  if (extra) return { ok: false, reason: extra };
  const { runId } = payload;
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return { ok: false, reason: 'runId must look like YYYY-MM-DD_NNN' };
  return { ok: true, value: { runId } };
}

function validateGetJournalEntry(payload: unknown): Validation<GetJournalEntryRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['runId', 'kind', 'iteration']);
  if (extra) return { ok: false, reason: extra };
  const { runId, kind, iteration } = payload;
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return { ok: false, reason: 'runId must look like YYYY-MM-DD_NNN' };
  if (typeof kind !== 'string' || !(JOURNAL_ENTRY_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `kind must be one of: ${JOURNAL_ENTRY_KINDS.join(', ')}` };
  }
  if (iteration !== undefined && (typeof iteration !== 'number' || !Number.isInteger(iteration) || iteration < 1 || iteration > 999)) {
    return { ok: false, reason: 'iteration must be an integer between 1 and 999' };
  }
  return { ok: true, value: iteration === undefined ? { runId, kind: kind as JournalEntryKind } : { runId, kind: kind as JournalEntryKind, iteration } };
}

// --- workflows (M5.8): ids by strict pattern; the renderer never sends paths, commands or prompts

const WORKFLOW_ID = /^wf_\d{4}-\d{2}-\d{2}_\d{3}$/;
const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ATTEMPT_ID = /^wf_\d{4}-\d{2}-\d{2}_\d{3}\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[1-9]\d{0,2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_ID_LENGTH = 64;
export const MAX_WORKFLOW_EVENTS = 1000;
export const MAX_WORKFLOW_INPUTS = 64;
/** Same cap as Core's WORKFLOW_LIMITS.maxTextBytes. */
export const MAX_WORKFLOW_INPUT_LENGTH = 256 * 1024;
const WORKFLOW_ANSWERS: readonly string[] = ['fail', 'stop', 'approve-bypass'];

const isKebabId = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_ID_LENGTH && KEBAB_ID.test(v);

function validateWorkflowIdRequest(payload: unknown): Validation<WorkflowIdRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['workflowId']);
  if (extra) return { ok: false, reason: extra };
  if (typeof payload.workflowId !== 'string' || !WORKFLOW_ID.test(payload.workflowId)) return { ok: false, reason: 'workflowId must look like wf_YYYY-MM-DD_NNN' };
  return { ok: true, value: { workflowId: payload.workflowId } };
}

function validateWorkflowEvents(payload: unknown): Validation<WorkflowEventsRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['workflowId', 'afterSeq', 'limit']);
  if (extra) return { ok: false, reason: extra };
  const { workflowId, afterSeq, limit } = payload;
  if (typeof workflowId !== 'string' || !WORKFLOW_ID.test(workflowId)) return { ok: false, reason: 'workflowId must look like wf_YYYY-MM-DD_NNN' };
  if (typeof afterSeq !== 'number' || !Number.isInteger(afterSeq) || afterSeq < 0 || afterSeq > 1_000_000_000) return { ok: false, reason: 'afterSeq must be a non-negative integer' };
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_WORKFLOW_EVENTS) return { ok: false, reason: `limit must be an integer between 1 and ${MAX_WORKFLOW_EVENTS}` };
  return { ok: true, value: { workflowId, afterSeq, limit } };
}

function validateWorkflowAttempt(payload: unknown): Validation<WorkflowAttemptRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['attemptId']);
  if (extra) return { ok: false, reason: extra };
  const { attemptId } = payload;
  if (typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId) || attemptId.split('/')[1].length > MAX_ID_LENGTH) return { ok: false, reason: 'attemptId must look like wf_YYYY-MM-DD_NNN/<step-id>/<n>' };
  return { ok: true, value: { attemptId } };
}

function validateWorkflowStart(payload: unknown): Validation<WorkflowStartRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['definitionId', 'definitionHash', 'inputs']);
  if (extra) return { ok: false, reason: extra };
  const { definitionId, definitionHash, inputs } = payload;
  if (!isKebabId(definitionId)) return { ok: false, reason: 'definitionId must be a kebab-case id of at most 64 characters' };
  if (typeof definitionHash !== 'string' || !SHA256_HEX.test(definitionHash)) return { ok: false, reason: 'definitionHash must be a sha256 hex digest' };
  if (!isPlainObject(inputs)) return { ok: false, reason: 'inputs must be an object' };
  const entries = Object.entries(inputs);
  if (entries.length > MAX_WORKFLOW_INPUTS) return { ok: false, reason: 'inputs has too many fields' };
  const values: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!isKebabId(name)) return { ok: false, reason: `input name ${JSON.stringify(name)} must be a kebab-case id` };
    if (typeof value !== 'string') return { ok: false, reason: `input ${name} must be a string` };
    if (value.length > MAX_WORKFLOW_INPUT_LENGTH) return { ok: false, reason: `input ${name} must be at most ${MAX_WORKFLOW_INPUT_LENGTH} characters` };
    if (value.includes('\u0000')) return { ok: false, reason: `input ${name} must not contain NUL characters` };
    values[name] = value;
  }
  // Which inputs the definition declares, and their limits, are checked in Main against the definition itself.
  return { ok: true, value: { definitionId, definitionHash, inputs: values } };
}

function validateWorkflowAnswer(payload: unknown): Validation<WorkflowAnswerRequest> {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload must be an object' };
  const extra = onlyKeys(payload, ['workflowId', 'answer']);
  if (extra) return { ok: false, reason: extra };
  const { workflowId, answer } = payload;
  if (typeof workflowId !== 'string' || !WORKFLOW_ID.test(workflowId)) return { ok: false, reason: 'workflowId must look like wf_YYYY-MM-DD_NNN' };
  if (typeof answer !== 'string' || !WORKFLOW_ANSWERS.includes(answer)) return { ok: false, reason: `answer must be one of: ${WORKFLOW_ANSWERS.join(', ')}` };
  return { ok: true, value: { workflowId, answer: answer as WorkflowAnswerRequest['answer'] } };
}

const VALIDATORS: { [C in InvokeChannel]: (payload: unknown) => Validation<RequestOf<C>> } = {
  'bridge:getSnapshot': noPayload,
  'bridge:start': validateStart,
  'bridge:pause': noPayload,
  'bridge:resume': noPayload,
  'bridge:stop': noPayload,
  'bridge:discard': noPayload,
  'bridge:doctor': noPayload,
  'bridge:getRecentEvents': validateRecentEvents,
  'bridge:listSessions': noPayload,
  'bridge:getSessionArtifacts': validateSessionArtifacts,
  'bridge:getExecutionOutput': validateExecutionOutput,
  'bridge:selectProject': noPayload,
  'bridge:getSettings': noPayload,
  'bridge:saveProjectConfig': validateSaveConfig,
  'bridge:setDefaultProject': validateSetDefault,
  'bridge:getJournal': validateGetJournal,
  'bridge:getJournalEntry': validateGetJournalEntry,
  'workflow:getSnapshot': noPayload,
  'workflow:list': noPayload,
  'workflow:get': validateWorkflowIdRequest,
  'workflow:getEvents': validateWorkflowEvents,
  'workflow:getAttempt': validateWorkflowAttempt,
  'workflow:getJournal': validateWorkflowIdRequest,
  'workflow:listDefinitions': noPayload,
  'workflow:start': validateWorkflowStart,
  'workflow:pause': validateWorkflowIdRequest,
  'workflow:resume': validateWorkflowIdRequest,
  'workflow:stop': validateWorkflowIdRequest,
  'workflow:answer': validateWorkflowAnswer,
};

export function validateRequest<C extends InvokeChannel>(channel: C, payload: unknown): Validation<RequestOf<C>> {
  return VALIDATORS[channel](payload);
}
