import path from 'node:path';
import type { BridgeEngine, BridgeRecoveryCheck, BridgeStatus } from '../../core/bridge-engine.ts';
import { redactSecrets } from '../../core/security/redact.ts';
import { newControlRequestId, requestWorkflowControl } from '../../hosts/workflow-control-channel.ts';
import {
  isWorkflowHostMessage,
  type WorkflowControlAction,
  type WorkflowControlResult,
  type WorkflowErrorCode,
  type WorkflowHostCommand,
  type WorkflowHostControl,
  type WorkflowHostError,
  type WorkflowHostMessage,
} from '../../hosts/workflow-host-protocol.ts';
import {
  checkWorkflowStartAvailability,
  getWorkflowAttempt,
  getWorkflowEvents,
  getWorkflowJournal,
  getWorkflowSnapshot,
  listWorkflowDefinitions,
  listWorkflowIds,
  listWorkflows,
  readWorkflowActivity,
  validateWorkflowStart,
  type WorkflowActivity,
  type WorkflowSnapshot,
} from '../../hosts/workflow-read.ts';
import type {
  ActionResponse,
  DataResponse,
  ProjectInfo,
  UiError,
  WorkflowAnswerRequest,
  WorkflowAttemptRequest,
  WorkflowAttemptView,
  WorkflowDefinitionSummary,
  WorkflowEvent,
  WorkflowEventsRequest,
  WorkflowIdRequest,
  WorkflowJournalView,
  WorkflowListItem,
  WorkflowPanelSnapshot,
  WorkflowPendingAction,
  WorkflowStartRequest,
} from '../shared/ipc-contract.ts';
import { NO_PROJECT_ERROR, unexpectedError } from '../shared/messages.ts';
import type { ChildHostProcess } from './fork-run-host.ts';
import { redactUiError } from './redaction.ts';
import type { RunHostExit } from './run-controller.ts';

/**
 * M5.8 — Electron Main's WorkflowController (docs/35 §3.1), the sibling of RunController. It
 * holds no orchestration logic: whether an action is allowed comes from Core
 * (`deriveWorkflowControls`, the workflow lock, the persisted instance), every workflow
 * decision is the WorkflowEngine's inside the Workflow Host process. This class validates
 * requests, forks at most one Workflow Host, relays typed commands/controls, and publishes
 * snapshots (read from disk) and the live events of the host it owns.
 *
 * A workflow hosted elsewhere (the CLI, or this app before a restart) is observed by polling
 * and controlled through the control channel — never by starting a second host.
 */

export type WorkflowHostProcess = ChildHostProcess<WorkflowHostCommand | WorkflowHostControl>;
export type WorkflowEngineApi = Pick<BridgeEngine, 'status' | 'checkRecovery'>;

export interface WorkflowControllerOptions {
  forkWorkflowHost: () => WorkflowHostProcess;
  /** In-process BridgeEngine reads (the ordinary run's status, for mutual exclusion and display). */
  createEngine: (projectPath: string) => WorkflowEngineApi;
  activePollMs?: number;
  idlePollMs?: number;
  /** How long a pause/stop may wait for the Workflow Host's answer (default 15 s). */
  controlTimeoutMs?: number;
}

const TITLES: Record<WorkflowErrorCode, string> = {
  INVALID_REQUEST: 'Yêu cầu không hợp lệ',
  DEFINITION_NOT_FOUND: 'Không tìm thấy workflow definition',
  DEFINITION_INVALID: 'Workflow definition không hợp lệ',
  DEFINITION_CHANGED: 'Workflow definition đã thay đổi',
  INPUTS_INVALID: 'Input không hợp lệ',
  WORKFLOW_NOT_FOUND: 'Không tìm thấy workflow',
  WORKFLOW_BROKEN: 'Nhật ký workflow không toàn vẹn',
  WORKFLOW_INCOMPLETE: 'Workflow chưa được tạo xong',
  WORKFLOW_LOCKED: 'Một Workflow Host khác đang chạy',
  WORKFLOW_ACTIVE: 'Một workflow đang hoạt động',
  RUN_ACTIVE: 'Một run đang chạy',
  RUN_UNFINISHED: 'Một run chưa kết thúc',
  NOT_ALLOWED: 'Không thực hiện được ở trạng thái hiện tại',
  NOT_HOSTED: 'Workflow không do Workflow Host này chạy',
  HOST_UNAVAILABLE: 'Workflow Host không phản hồi',
  HOST_FAILED: 'Workflow Host gặp lỗi',
};

/** A host error → the UI's error shape (redacted; details only behind "View details"). */
export function toUiError(e: WorkflowHostError): UiError {
  return redactUiError({ code: e.code, title: TITLES[e.code], message: e.message, ...(e.details?.length ? { details: e.details.join('\n') } : {}) });
}

const hostError = (code: WorkflowErrorCode, message: string, details?: string[]): WorkflowHostError => (details?.length ? { code, message, details } : { code, message });

type Launched = { ok: true; workflowId: string } | { ok: false; error: UiError };

function fail(error: UiError): { ok: false; error: UiError } {
  return { ok: false, error: redactUiError(error) };
}

export class WorkflowController {
  readonly #opts: Required<WorkflowControllerOptions>;
  #project: ProjectInfo | null = null;
  #aiBridgeDir: string | null = null;
  #engine: WorkflowEngineApi | null = null;

  #host: WorkflowHostProcess | null = null;
  #hostWorkflowId: string | null = null;
  #waiter: ((launched: Launched) => void) | null = null;
  readonly #controlWaiters = new Map<string, (result: WorkflowControlResult) => void>();

  #focus: string | null = null;
  #pendingAction: WorkflowPendingAction | null = null;
  #lastError: UiError | null = null;
  #snapshot: WorkflowPanelSnapshot;
  #lastEmitted = '';
  readonly #snapshotListeners = new Set<(snapshot: WorkflowPanelSnapshot) => void>();
  readonly #eventListeners = new Set<(event: WorkflowEvent) => void>();
  #refreshing: Promise<void> | null = null;
  #refreshQueued = false;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: WorkflowControllerOptions) {
    this.#opts = { activePollMs: 1000, idlePollMs: 5000, controlTimeoutMs: 15_000, ...options };
    this.#snapshot = this.#emptySnapshot();
  }

  // -------------------------------------------------------------------------
  // subscriptions / project
  // -------------------------------------------------------------------------

  onSnapshot(listener: (snapshot: WorkflowPanelSnapshot) => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  onEvent(listener: (event: WorkflowEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Only a Workflow Host this app instance started. */
  ownsHost(): boolean {
    return this.#host !== null;
  }

  /** `info.path` must already be validated by Main (project-path.ts). */
  async setProject(info: ProjectInfo): Promise<ActionResponse> {
    if (this.#host !== null || this.#pendingAction !== null) return fail(toUiError(hostError('NOT_ALLOWED', 'a workflow started by this app is still running — switch the project after it rests')));
    this.#project = info;
    this.#aiBridgeDir = path.join(info.path, '.ai-bridge');
    this.#engine = this.#opts.createEngine(info.path);
    this.#focus = null;
    this.#lastError = null;
    await this.#refresh();
    this.#schedulePoll();
    return { ok: true };
  }

  async getSnapshot(): Promise<WorkflowPanelSnapshot> {
    await this.#refresh();
    return this.#snapshot;
  }

  // -------------------------------------------------------------------------
  // reads (Core, from disk; nothing here needs a Workflow Host)
  // -------------------------------------------------------------------------

  async list(): Promise<DataResponse<WorkflowListItem[]>> {
    const dir = this.#aiBridgeDir;
    if (!dir) return fail(NO_PROJECT_ERROR);
    return { ok: true, data: await listWorkflows(dir) };
  }

  async get(req: WorkflowIdRequest): Promise<DataResponse<WorkflowSnapshot>> {
    const dir = this.#aiBridgeDir;
    if (!dir) return fail(NO_PROJECT_ERROR);
    const r = await getWorkflowSnapshot(dir, req.workflowId, { execution: (await this.#runState())?.status ?? null });
    return r.ok ? { ok: true, data: r.value } : fail(toUiError(r.error));
  }

  async getEvents(req: WorkflowEventsRequest): Promise<DataResponse<WorkflowEvent[]>> {
    const dir = this.#aiBridgeDir;
    if (!dir) return fail(NO_PROJECT_ERROR);
    const r = await getWorkflowEvents(dir, req.workflowId, req.afterSeq, req.limit);
    return r.ok ? { ok: true, data: r.value } : fail(toUiError(r.error));
  }

  async getAttempt(req: WorkflowAttemptRequest): Promise<DataResponse<WorkflowAttemptView>> {
    const dir = this.#aiBridgeDir;
    if (!dir) return fail(NO_PROJECT_ERROR);
    const r = await getWorkflowAttempt(dir, req.attemptId);
    // The task text embeds user-supplied inputs: redacted before it crosses into the renderer.
    return r.ok ? { ok: true, data: { ...r.value, task: r.value.task === null ? null : redactSecrets(r.value.task) } } : fail(toUiError(r.error));
  }

  async getJournal(req: WorkflowIdRequest): Promise<DataResponse<WorkflowJournalView>> {
    const dir = this.#aiBridgeDir;
    if (!dir) return fail(NO_PROJECT_ERROR);
    const r = await getWorkflowJournal(dir, req.workflowId);
    return r.ok ? { ok: true, data: { workflowId: r.value.workflowId, markdown: redactSecrets(r.value.markdown) } } : fail(toUiError(r.error));
  }

  async listDefinitions(): Promise<DataResponse<WorkflowDefinitionSummary[]>> {
    const dir = this.#aiBridgeDir;
    if (!dir) return fail(NO_PROJECT_ERROR);
    return { ok: true, data: await listWorkflowDefinitions(dir) };
  }

  // -------------------------------------------------------------------------
  // actions — each re-reads Core first; availability is Core's, never the renderer's
  // -------------------------------------------------------------------------

  async start(req: WorkflowStartRequest): Promise<DataResponse<{ workflowId: string }>> {
    const dir = this.#aiBridgeDir;
    const project = this.#project;
    if (!dir || !project) return fail(NO_PROJECT_ERROR);
    const busy = this.#busy();
    if (busy) return fail(busy);
    const valid = await validateWorkflowStart(dir, req.definitionId, req.definitionHash, req.inputs);
    if (!valid.ok) return fail(toUiError(valid.error));
    const available = await checkWorkflowStartAvailability(dir, await this.#runState());
    if (!available.ok) return fail(toUiError(available.error));
    const launched = await this.#launch({ type: 'run', projectPath: project.path, definitionId: req.definitionId, definitionHash: req.definitionHash, inputs: req.inputs }, 'start');
    return launched.ok ? { ok: true, data: { workflowId: launched.workflowId } } : launched;
  }

  async pause(req: WorkflowIdRequest): Promise<ActionResponse> {
    const snap = await this.#instance(req.workflowId);
    if (!snap.ok) return snap;
    if (!snap.value.controls.canPause) return fail(toUiError(hostError('NOT_ALLOWED', `cannot pause ${req.workflowId} (${snap.value.displayState}${snap.value.pauseRequested ? ', a pause is already pending' : ''})`)));
    return this.#control(req.workflowId, 'pause');
  }

  async stop(req: WorkflowIdRequest): Promise<ActionResponse> {
    const snap = await this.#instance(req.workflowId);
    if (!snap.ok) return snap;
    if (!snap.value.controls.canStop) return fail(toUiError(hostError('NOT_ALLOWED', `cannot stop ${req.workflowId} (${snap.value.displayState}${snap.value.stopRequested ? ', a stop is already pending' : ''})`)));
    if (snap.value.host.alive) return this.#control(req.workflowId, 'stop');
    return this.#action({ type: 'stop', projectPath: this.#project!.path, workflowId: req.workflowId }, 'stop');
  }

  async resume(req: WorkflowIdRequest): Promise<ActionResponse> {
    const snap = await this.#instance(req.workflowId);
    if (!snap.ok) return snap;
    const c = snap.value.controls;
    if (!(c.canResume || c.canStart)) return fail(toUiError(hostError('NOT_ALLOWED', `cannot resume ${req.workflowId} (${snap.value.displayState})`)));
    return this.#action({ type: 'resume', projectPath: this.#project!.path, workflowId: req.workflowId }, 'resume');
  }

  async answer(req: WorkflowAnswerRequest): Promise<ActionResponse> {
    const snap = await this.#instance(req.workflowId);
    if (!snap.ok) return snap;
    if (!snap.value.controls.canAnswer.includes(req.answer)) return fail(toUiError(hostError('NOT_ALLOWED', `"${req.answer}" is not an accepted answer for ${req.workflowId} now (accepted: ${snap.value.controls.canAnswer.join(', ') || 'none'})`)));
    return this.#action({ type: 'answer', projectPath: this.#project!.path, workflowId: req.workflowId, answer: req.answer }, 'answer');
  }

  /**
   * M5.8.1 — a deliberate app quit while this app owns a Workflow Host: STOP the workflow through
   * the WorkflowEngine and wait until its host has ended, so a normal quit never leaves an
   * execution running unattended (the M4 quit rule for runs). A crash is different by design:
   * the Execution Host outlives the Workflow Host and is reconciled later (process-lifetime.ts).
   * Resolves false if the host did not end within `timeoutMs`.
   */
  async stopOwnedHost(timeoutMs = 120_000): Promise<boolean> {
    const host = this.#host;
    if (!host) return true;
    const deadline = Date.now() + timeoutMs;
    const ended = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      host.onExit(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    // A host that has not accepted its command yet serves no workflow to stop: wait for it.
    while (this.#host === host && this.#hostWorkflowId === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (this.#host === host && this.#hostWorkflowId !== null) await this.#controlOwnHost(host, 'stop');
    return ended;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
    this.#snapshotListeners.clear();
    this.#eventListeners.clear();
  }

  // -------------------------------------------------------------------------
  // Workflow Host lifecycle
  // -------------------------------------------------------------------------

  #busy(): UiError | null {
    if (this.#host !== null) return toUiError(hostError('WORKFLOW_LOCKED', `a Workflow Host started by this app is still running${this.#hostWorkflowId ? ` (${this.#hostWorkflowId})` : ''}`));
    if (this.#pendingAction !== null) return toUiError(hostError('NOT_ALLOWED', `another workflow action (${this.#pendingAction}) is in progress`));
    return null;
  }

  async #instance(workflowId: string): Promise<{ ok: true; value: WorkflowSnapshot } | { ok: false; error: UiError }> {
    const dir = this.#aiBridgeDir;
    if (!dir || !this.#project) return fail(NO_PROJECT_ERROR);
    const r = await getWorkflowSnapshot(dir, workflowId);
    return r.ok ? r : fail(toUiError(r.error));
  }

  async #action(command: Exclude<WorkflowHostCommand, { type: 'run' }>, action: WorkflowPendingAction): Promise<ActionResponse> {
    const busy = this.#busy();
    if (busy) return fail(busy);
    const launched = await this.#launch(command, action);
    return launched.ok ? { ok: true } : launched;
  }

  /** Forks the one Workflow Host; resolves when it accepted or refused the command, or exited. */
  async #launch(command: WorkflowHostCommand, action: WorkflowPendingAction): Promise<Launched> {
    this.#pendingAction = action;
    this.#lastError = null;
    let host: WorkflowHostProcess;
    try {
      host = this.#opts.forkWorkflowHost();
    } catch (err) {
      this.#pendingAction = null;
      this.#lastError = redactUiError(unexpectedError(err));
      await this.#refresh();
      return { ok: false, error: this.#lastError };
    }
    this.#host = host;
    this.#hostWorkflowId = command.type === 'run' ? null : command.workflowId;
    const launched = new Promise<Launched>((resolve) => {
      this.#waiter = resolve;
    });
    host.onMessage((message) => this.#onHostMessage(host, message));
    host.onExit((exit) => this.#onHostExit(host, exit));
    host.send(command);
    this.#publish();
    this.#schedulePoll();
    return launched;
  }

  async #control(workflowId: string, action: WorkflowControlAction): Promise<ActionResponse> {
    const dir = this.#aiBridgeDir;
    if (!dir) return fail(NO_PROJECT_ERROR);
    const pending: WorkflowPendingAction = action === 'pause' ? 'pause' : 'stop';
    if (this.#pendingAction !== null) return fail(toUiError(hostError('NOT_ALLOWED', `another workflow action (${this.#pendingAction}) is in progress`)));
    this.#pendingAction = pending;
    this.#publish();
    try {
      const result = this.#host !== null && this.#hostWorkflowId === workflowId ? await this.#controlOwnHost(this.#host, action) : await requestWorkflowControl(dir, workflowId, action, { timeoutMs: this.#opts.controlTimeoutMs });
      if (!result.ok) return fail(toUiError(result.error));
      this.#focus = workflowId;
      return { ok: true, message: action === 'pause' ? 'Đã yêu cầu PAUSE — workflow dừng ở safe boundary kế tiếp.' : 'Đã yêu cầu STOP — execution đang chạy được dừng qua Core.' };
    } finally {
      this.#pendingAction = null;
      await this.#refresh();
    }
  }

  #controlOwnHost(host: WorkflowHostProcess, action: WorkflowControlAction): Promise<WorkflowControlResult> {
    const requestId = newControlRequestId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#controlWaiters.delete(requestId);
        resolve({ ok: false, error: hostError('HOST_UNAVAILABLE', `the Workflow Host did not answer within ${this.#opts.controlTimeoutMs} ms`) });
      }, this.#opts.controlTimeoutMs);
      this.#controlWaiters.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      host.send({ type: 'control', requestId, action });
    });
  }

  #onHostMessage(host: WorkflowHostProcess, raw: unknown): void {
    if (host !== this.#host || !isWorkflowHostMessage(raw)) return; // stale host or malformed: never acted on
    const message: WorkflowHostMessage = raw;
    switch (message.type) {
      case 'accepted':
        this.#hostWorkflowId = message.workflowId;
        this.#focus = message.workflowId;
        this.#resolveWaiter({ ok: true, workflowId: message.workflowId });
        break;
      case 'rejected':
        this.#lastError = toUiError(message.error);
        this.#resolveWaiter({ ok: false, error: this.#lastError });
        break;
      case 'event':
        for (const listener of this.#eventListeners) listener(message.event);
        break;
      case 'control-result': {
        const waiter = this.#controlWaiters.get(message.requestId);
        this.#controlWaiters.delete(message.requestId);
        waiter?.(message.result);
        break;
      }
      case 'ended':
        if (message.end.reason === 'STALLED') {
          this.#lastError = toUiError(hostError('HOST_FAILED', `${message.end.workflowId} stopped making progress while RUNNING — resume it to reconcile`, message.end.errors));
        }
        break;
      case 'failed':
        this.#lastError = toUiError(hostError('HOST_FAILED', message.message));
        this.#resolveWaiter({ ok: false, error: this.#lastError });
        break;
    }
    void this.#refresh();
  }

  #onHostExit(host: WorkflowHostProcess, exit: RunHostExit): void {
    if (host !== this.#host) return;
    this.#host = null;
    this.#hostWorkflowId = null;
    for (const [id, waiter] of this.#controlWaiters) {
      this.#controlWaiters.delete(id);
      waiter({ ok: false, error: hostError('HOST_UNAVAILABLE', 'the Workflow Host ended before answering') });
    }
    if (this.#waiter) {
      this.#lastError = toUiError(hostError('HOST_UNAVAILABLE', 'the Workflow Host exited before it accepted the command', [`exit code: ${exit.code ?? 'null'}, signal: ${exit.signal ?? 'null'}${exit.stderrTail ? `\n${exit.stderrTail}` : ''}`]));
      this.#resolveWaiter({ ok: false, error: this.#lastError });
    }
    void this.#refresh();
  }

  #resolveWaiter(launched: Launched): void {
    const waiter = this.#waiter;
    if (!waiter) return;
    this.#waiter = null;
    this.#pendingAction = null;
    waiter(launched);
  }

  // -------------------------------------------------------------------------
  // snapshot publishing
  // -------------------------------------------------------------------------

  #emptySnapshot(): WorkflowPanelSnapshot {
    return { project: this.#project, workflow: null, activity: { hostPid: null, hostedWorkflowId: null, running: [] }, canStartNew: false, startBlockedBy: null, attached: false, pendingAction: this.#pendingAction, lastError: this.#lastError };
  }

  async #runState(): Promise<{ status: BridgeStatus; recovery: BridgeRecoveryCheck } | null> {
    const engine = this.#engine;
    if (!engine) return null;
    try {
      return { status: await engine.status(), recovery: await engine.checkRecovery() };
    } catch {
      return null;
    }
  }

  #publish(): void {
    const snapshot: WorkflowPanelSnapshot = { ...this.#snapshot, attached: this.#host !== null, pendingAction: this.#pendingAction, lastError: this.#lastError, canStartNew: this.#snapshot.canStartNew && this.#host === null && this.#pendingAction === null };
    this.#snapshot = snapshot;
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.#lastEmitted) return;
    this.#lastEmitted = serialized;
    for (const listener of this.#snapshotListeners) listener(snapshot);
  }

  #refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#refreshQueued = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      do {
        this.#refreshQueued = false;
        await this.#refreshOnce();
      } while (this.#refreshQueued && !this.#disposed);
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #refreshOnce(): Promise<void> {
    const dir = this.#aiBridgeDir;
    if (!dir) {
      this.#snapshot = this.#emptySnapshot();
      this.#publish();
      return;
    }
    try {
      const activity: WorkflowActivity = await readWorkflowActivity(dir);
      const run = await this.#runState();
      const focusId = this.#focus ?? this.#hostWorkflowId ?? activity.host?.workflowId ?? activity.running.at(-1) ?? (await listWorkflowIds(dir)).at(-1) ?? null;
      const workflow = focusId ? await getWorkflowSnapshot(dir, focusId, { activity, execution: run?.status ?? null }) : null;
      const available = await checkWorkflowStartAvailability(dir, run, activity);
      if (dir !== this.#aiBridgeDir) return; // project switched mid-refresh
      this.#snapshot = {
        project: this.#project,
        workflow: workflow?.ok ? workflow.value : null,
        activity: { hostPid: activity.host?.pid ?? null, hostedWorkflowId: activity.host?.workflowId ?? null, running: activity.running },
        canStartNew: available.ok,
        startBlockedBy: available.ok ? null : toUiError(available.error),
        attached: this.#host !== null,
        pendingAction: this.#pendingAction,
        lastError: this.#lastError,
      };
    } catch (err) {
      this.#lastError = redactUiError(unexpectedError(err));
    }
    this.#publish();
  }

  #schedulePoll(): void {
    if (this.#disposed) return;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    const active = this.#host !== null || this.#pendingAction !== null || this.#snapshot.activity.hostPid !== null || this.#snapshot.activity.running.length > 0;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.#refresh().finally(() => this.#schedulePoll());
    }, active ? this.#opts.activePollMs : this.#opts.idlePollMs);
  }
}
