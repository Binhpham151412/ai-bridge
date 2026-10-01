import type { BridgeEngine, BridgeRecoveryCheck, BridgeRunOutcome, BridgeStatus, BridgeConfigView } from '../../core/bridge-engine.ts';
import type { BridgeEvent } from '../../core/observability/events.ts';
import type { DoctorReport } from '../../core/preflight/doctor.ts';
import type { ExecutionOutput, SessionArtifacts, SessionSummary } from '../../core/session-history/session-history.ts';
import type { JournalEntry, JournalIndex } from '../../core/journal/journal.ts';
import type {
  ActionResponse,
  BridgeSnapshot,
  DataResponse,
  GetJournalEntryRequest,
  PendingAction,
  ProjectInfo,
  RunOutcomeSummary,
  StartRunRequest,
  UiError,
  ExecutionOutputRequest,
} from '../shared/ipc-contract.ts';
import { deriveControls } from '../shared/controls.ts';
import { describeRunOutcome, notAllowed, NO_PROJECT_ERROR, unexpectedError } from '../shared/messages.ts';
import { redactDoctorReport, redactEvent, redactUiError } from './redaction.ts';
import { redactSecrets } from '../../core/security/redact.ts';
import { isHostMessage, type HostCommand } from './run-host-protocol.ts';

/** The subset of BridgeEngine Main calls in-process (all short/read-mostly calls). */
export type EngineApi = Pick<
  BridgeEngine,
  | 'subscribe'
  | 'status'
  | 'checkRecovery'
  | 'pause'
  | 'stop'
  | 'reset'
  | 'doctor'
  | 'recentEvents'
  | 'listSessions'
  | 'getSessionArtifacts'
  | 'getExecutionOutput'
  | 'getJournal'
  | 'getJournalEntry'
  | 'getConfig'
  | 'saveConfig'
>;

export interface RunHostExit {
  code: number | null;
  signal: string | null;
  /** Last few KB of the host's stderr, for "View details" on an unexpected exit. */
  stderrTail: string;
}

/** A forked run host (see run-host.ts), abstracted so tests can fork a fake-CLI host. */
export interface RunHostProcess {
  readonly pid: number | undefined;
  send(command: HostCommand): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (exit: RunHostExit) => void): void;
}

export interface RunControllerOptions {
  createEngine: (projectPath: string) => EngineApi;
  forkRunHost: () => RunHostProcess;
  /** Status refresh cadence while something is running (ms). */
  activePollMs?: number;
  /** Cadence while idle — slow, only to notice a run started elsewhere (e.g. the CLI). */
  idlePollMs?: number;
  /** M5.8 (docs/35 §3.1): true while a workflow owns the project's executions — derived from
   * Core (the workflow lock and persisted state); every Run control is then off. */
  workflowActivity?: (projectPath: string) => Promise<boolean>;
}

const NO_RECOVERY: BridgeRecoveryCheck = { kind: 'NONE' };

const WORKFLOW_ACTIVE_ERROR: UiError = {
  code: 'WORKFLOW_ACTIVE',
  title: 'Một workflow đang hoạt động',
  message: 'Một workflow đang dùng project này — execution của nó chỉ được điều khiển qua workflow.',
};

function fail(error: UiError): { ok: false; error: UiError } {
  return { ok: false, error: redactUiError(error) };
}

function summarizeOutcome(outcome: BridgeRunOutcome): RunOutcomeSummary {
  if (outcome.kind === 'COMPLETED') return { kind: outcome.kind, finalStatus: outcome.finalStatus, iterations: outcome.iterations, errorCode: outcome.errorCode };
  return { kind: outcome.kind, finalStatus: null, iterations: null, errorCode: null };
}

/**
 * Electron Main's single owner of "what is this app doing with the open project".
 * Holds no orchestration logic: every decision (can it start? is it recoverable? what
 * state is the run in?) comes from BridgeEngine; this class only sequences the calls,
 * owns the run-host child process lifecycle, and publishes one consolidated snapshot
 * plus the live event stream to whoever listens (Main → renderer).
 */
export class RunController {
  private readonly opts: Required<RunControllerOptions>;
  private project: ProjectInfo | null = null;
  private engine: EngineApi | null = null;
  private engineUnsubscribe: (() => void) | null = null;

  private host: RunHostProcess | null = null;
  private hostOutcome: BridgeRunOutcome | null = null;
  private stopRequested = false;
  private waiter: ((response: ActionResponse) => void) | null = null;

  private pendingAction: PendingAction | null = null;
  private pauseRequested = false;
  private lastError: UiError | null = null;
  private lastOutcome: RunOutcomeSummary | null = null;
  private status: BridgeStatus | null = null;
  private recovery: BridgeRecoveryCheck = NO_RECOVERY;
  private workflowActive = false;

  private lastEmitted = '';
  private readonly snapshotListeners = new Set<(snapshot: BridgeSnapshot) => void>();
  private readonly eventListeners = new Set<(event: BridgeEvent) => void>();
  private refreshing: Promise<void> | null = null;
  private refreshQueued = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: RunControllerOptions) {
    this.opts = { activePollMs: 1000, idlePollMs: 5000, workflowActivity: async () => false, ...options };
  }

  // -------------------------------------------------------------------------
  // subscriptions
  // -------------------------------------------------------------------------

  onSnapshot(listener: (snapshot: BridgeSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // project
  // -------------------------------------------------------------------------

  getProject(): ProjectInfo | null {
    return this.project;
  }

  /** `info.path` must already be validated by Main (project-path.ts). */
  async setProject(info: ProjectInfo): Promise<ActionResponse> {
    if (this.isRunActive() || this.pendingAction !== null) return fail(notAllowed('đổi project khi run đang chạy', this.status?.status ?? null));
    this.engineUnsubscribe?.();
    const engine = this.opts.createEngine(info.path);
    // Events Main's own engine emits (PAUSE_REQUESTED from pause(), RUN_STOPPED from stop()).
    this.engineUnsubscribe = engine.subscribe((event) => this.emitEvent(event));
    this.engine = engine;
    this.project = info;
    this.lastError = null;
    this.lastOutcome = null;
    this.pauseRequested = false;
    await this.refresh();
    this.schedulePoll();
    return { ok: true };
  }

  /** A run is live if this app owns a run host, or Core reports RUNNING (e.g. a CLI run). */
  isRunActive(): boolean {
    return this.host !== null || this.status?.status === 'RUNNING';
  }

  /** Only a run this app instance started (its own run host). Quitting the app must
   * never stop a run someone else owns, e.g. one started from the CLI. */
  ownsActiveRun(): boolean {
    return this.host !== null;
  }

  async getSnapshot(): Promise<BridgeSnapshot> {
    await this.refresh();
    return this.buildSnapshot();
  }

  // -------------------------------------------------------------------------
  // run control — every action re-reads Core state first, then checks the controls
  // derived from it (never trusts what the renderer believed the state was)
  // -------------------------------------------------------------------------

  async start(request: StartRunRequest): Promise<ActionResponse> {
    if (!this.engine || !this.project) return fail(NO_PROJECT_ERROR);
    await this.refresh();
    if (this.workflowActive) return fail(WORKFLOW_ACTIVE_ERROR);
    if (!this.buildSnapshot().controls.canStart) return fail(notAllowed('START', this.status?.status ?? null));
    return this.launchHost({ type: 'start', projectPath: this.project.path, task: request.task, maxIterations: request.maxIterations }, 'start');
  }

  async resume(): Promise<ActionResponse> {
    if (!this.engine || !this.project) return fail(NO_PROJECT_ERROR);
    await this.refresh();
    if (!this.buildSnapshot().controls.canResume) return fail(notAllowed('RESUME', this.status?.status ?? null));
    return this.launchHost({ type: 'resume', projectPath: this.project.path }, 'resume');
  }

  async pause(): Promise<ActionResponse> {
    const engine = this.engine;
    if (!engine) return fail(NO_PROJECT_ERROR);
    await this.refresh();
    if (!this.buildSnapshot().controls.canPause) return fail(notAllowed('PAUSE', this.status?.status ?? null));

    this.pendingAction = 'pause';
    this.pauseRequested = true;
    this.publish();
    try {
      // Cooperative: Core writes the marker and the run pauses at its next safe
      // boundary. Nothing is killed; this can legitimately take a while.
      const outcome = await engine.pause();
      if (outcome.kind === 'PAUSED') return { ok: true, message: 'Đã PAUSE tại safe boundary.' };
      if (outcome.kind === 'STILL_RUNNING') return { ok: true, message: 'Đã yêu cầu PAUSE. Core sẽ dừng ở safe boundary kế tiếp — Claude/Codex đang chạy không bị ngắt.' };
      this.pauseRequested = false;
      if (outcome.kind === 'ENDED_BEFORE_PAUSE') return { ok: true, message: `Run đã kết thúc (${outcome.finalStatus}) trước khi tới safe boundary.` };
      return fail(notAllowed('PAUSE', 'NOT_RUNNING'));
    } catch (err) {
      this.pauseRequested = false;
      return fail(unexpectedError(err));
    } finally {
      if (this.pendingAction === 'pause') this.pendingAction = null;
      await this.refresh();
    }
  }

  async stop(): Promise<ActionResponse> {
    const engine = this.engine;
    if (!engine) return fail(NO_PROJECT_ERROR);
    await this.refresh();
    if (this.buildSnapshot().controls.stopMode !== 'STOP') return fail(notAllowed('STOP', this.status?.status ?? null));

    this.pendingAction = 'stop';
    this.stopRequested = true;
    this.publish();
    try {
      // Core's process management decides everything: graceful attempt, then a
      // process-tree kill of the lock holder (the run host, with Claude/Codex under it).
      const outcome = await engine.stop();
      if (outcome.kind === 'NOT_RUNNING') return { ok: true, message: 'Không có run nào đang chạy.' };
      if (!outcome.ok) return fail({ code: 'STOP_FAILED', title: 'STOP thất bại', message: 'Core không xác nhận được process tree đã dừng.', details: outcome.reason });
      return { ok: true, message: `Đã STOP (${outcome.reason}).` };
    } catch (err) {
      return fail(unexpectedError(err));
    } finally {
      this.pendingAction = null;
      this.pauseRequested = false;
      await this.refresh();
    }
  }

  /** Ends a paused/interrupted session without resuming it (Core `reset()`): clears
   * only `.ai-bridge/state`; reports, sessions and logs are kept. */
  async discard(): Promise<ActionResponse> {
    const engine = this.engine;
    if (!engine) return fail(NO_PROJECT_ERROR);
    await this.refresh();
    if (this.buildSnapshot().controls.stopMode !== 'DISCARD') return fail(notAllowed('DISCARD', this.status?.status ?? null));

    this.pendingAction = 'discard';
    this.publish();
    try {
      const outcome = await engine.reset();
      if (outcome.kind === 'REFUSED_RUNNING') return fail(notAllowed('DISCARD', 'RUNNING'));
      this.lastError = null;
      this.lastOutcome = null;
      return { ok: true, message: 'Đã kết thúc session (artifact được giữ nguyên).' };
    } catch (err) {
      return fail(unexpectedError(err));
    } finally {
      this.pendingAction = null;
      await this.refresh();
    }
  }

  // -------------------------------------------------------------------------
  // read-only Core queries
  // -------------------------------------------------------------------------

  async doctor(): Promise<DataResponse<DoctorReport>> {
    if (!this.engine) return fail(NO_PROJECT_ERROR);
    return { ok: true, data: redactDoctorReport(await this.engine.doctor()) };
  }

  async recentEvents(limit: number): Promise<DataResponse<BridgeEvent[]>> {
    if (!this.engine) return fail(NO_PROJECT_ERROR);
    return { ok: true, data: (await this.engine.recentEvents(limit)).map(redactEvent) };
  }

  async listSessions(): Promise<DataResponse<SessionSummary[]>> {
    if (!this.engine) return fail(NO_PROJECT_ERROR);
    return { ok: true, data: await this.engine.listSessions() };
  }

  async getSessionArtifacts(runId: string): Promise<DataResponse<SessionArtifacts>> {
    if (!this.engine) return fail(NO_PROJECT_ERROR);
    const artifacts = await this.engine.getSessionArtifacts(runId);
    if (!artifacts) return fail({ code: 'NOT_FOUND', title: 'Không tìm thấy session', message: `Session ${runId} không tồn tại trong project này.` });
    return { ok: true, data: { ...artifacts, events: artifacts.events.map(redactEvent) } };
  }

  async getExecutionOutput(req: ExecutionOutputRequest): Promise<DataResponse<ExecutionOutput>> {
    if (!this.engine) return fail(NO_PROJECT_ERROR);
    const out = await this.engine.getExecutionOutput(req.runId, req.iteration, req.agent, req.stream);
    if (!out) return fail({ code: 'NOT_FOUND', title: 'Không có output', message: `Không có ${req.stream} được lưu cho ${req.agent} ở iteration ${req.iteration} của session ${req.runId}.` });
    // Redacted in Core already; again here — nothing unredacted crosses into the renderer.
    return { ok: true, data: { ...out, text: redactSecrets(out.text) } };
  }

  async getJournal(runId: string): Promise<DataResponse<JournalIndex>> {
    if (!this.engine) return fail(NO_PROJECT_ERROR);
    const journal = await this.engine.getJournal(runId);
    if (!journal) return fail({ code: 'NOT_FOUND', title: 'Không tìm thấy session', message: `Session ${runId} không tồn tại trong project này.` });
    return { ok: true, data: journal };
  }

  async getJournalEntry(req: GetJournalEntryRequest): Promise<DataResponse<JournalEntry>> {
    if (!this.engine) return fail(NO_PROJECT_ERROR);
    const entry = await this.engine.getJournalEntry(req.runId, req.kind, req.iteration ?? null);
    if (!entry) return fail({ code: 'NOT_FOUND', title: 'Không có nhật ký', message: `Không có mục nhật ký (${req.kind}) cho session ${req.runId}.` });
    // Defense in depth — journal entries are rendered verbatim from reports/reviews,
    // which are not otherwise redacted before crossing into the renderer.
    return { ok: true, data: { ...entry, text: redactSecrets(entry.text) } };
  }

  async getConfig(): Promise<BridgeConfigView | null> {
    return this.engine ? this.engine.getConfig() : null;
  }

  async saveConfig(raw: Record<string, unknown>): Promise<ActionResponse> {
    if (!this.engine) return fail(NO_PROJECT_ERROR);
    const outcome = await this.engine.saveConfig(raw);
    if (outcome.kind === 'SAVED') return { ok: true, message: 'Đã lưu .ai-bridge/config.json.' };
    if (outcome.kind === 'REFUSED_RUNNING') return fail(notAllowed('lưu cấu hình khi run đang chạy', 'RUNNING'));
    return fail({ code: 'CONFIG_INVALID', title: 'Cấu hình không hợp lệ', message: outcome.errors.join('; ') });
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.engineUnsubscribe?.();
    this.engineUnsubscribe = null;
    this.snapshotListeners.clear();
    this.eventListeners.clear();
  }

  // -------------------------------------------------------------------------
  // run host lifecycle
  // -------------------------------------------------------------------------

  private async launchHost(command: HostCommand, action: 'start' | 'resume'): Promise<ActionResponse> {
    this.pendingAction = action;
    this.lastError = null;
    this.lastOutcome = null;
    this.hostOutcome = null;
    this.stopRequested = false;
    this.pauseRequested = false;

    let host: RunHostProcess;
    try {
      host = this.opts.forkRunHost();
    } catch (err) {
      this.pendingAction = null;
      this.lastError = redactUiError(unexpectedError(err));
      await this.refresh();
      return { ok: false, error: this.lastError };
    }
    this.host = host;
    // Resolved by the first RUN_STARTED event (the run is really going), by the
    // outcome (e.g. BLOCKED_PREFLIGHT), or by the host exiting.
    const accepted = new Promise<ActionResponse>((resolve) => {
      this.waiter = resolve;
    });
    host.onMessage((message) => this.onHostMessage(host, message));
    host.onExit((exit) => this.onHostExit(host, exit));
    host.send(command);
    this.publish();
    this.schedulePoll();
    return accepted;
  }

  private onHostMessage(host: RunHostProcess, message: unknown): void {
    if (host !== this.host || !isHostMessage(message)) return;
    if (message.type === 'event') {
      this.emitEvent(message.event);
      if (message.event.event === 'RUN_STARTED') this.resolveWaiter({ ok: true });
      void this.refresh();
      return;
    }
    if (message.type === 'outcome') {
      this.hostOutcome = message.outcome;
      this.lastOutcome = summarizeOutcome(message.outcome);
      const error = describeRunOutcome(message.outcome);
      this.lastError = error ? redactUiError(error) : null;
      this.resolveWaiter(this.lastError ? { ok: false, error: this.lastError } : { ok: true });
      void this.refresh();
      return;
    }
    this.lastError = redactUiError(unexpectedError(message.message));
    this.resolveWaiter({ ok: false, error: this.lastError });
  }

  private onHostExit(host: RunHostProcess, exit: RunHostExit): void {
    if (host !== this.host) return;
    this.host = null;
    this.pauseRequested = false;
    if (this.hostOutcome === null && !this.stopRequested) {
      this.lastError = redactUiError({
        code: 'CORE_PROCESS_EXITED',
        title: 'Core process kết thúc bất thường',
        message: 'Tiến trình chạy BridgeEngine đã dừng trước khi báo kết quả. Xem trạng thái recovery trên màn hình Run.',
        details: `exit code: ${exit.code ?? 'null'}, signal: ${exit.signal ?? 'null'}${exit.stderrTail ? `\n${exit.stderrTail}` : ''}`,
      });
    }
    this.resolveWaiter(this.lastError ? { ok: false, error: this.lastError } : { ok: true });
    void this.refresh();
  }

  private resolveWaiter(response: ActionResponse): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    if (this.pendingAction === 'start' || this.pendingAction === 'resume') this.pendingAction = null;
    waiter(response);
  }

  // -------------------------------------------------------------------------
  // snapshot publishing
  // -------------------------------------------------------------------------

  private emitEvent(event: BridgeEvent): void {
    const safe = redactEvent(event);
    for (const listener of this.eventListeners) listener(safe);
  }

  private buildSnapshot(): BridgeSnapshot {
    const controls = deriveControls({
      hasProject: this.project !== null,
      status: this.status?.status ?? null,
      iteration: this.status?.iteration ?? 0,
      recovery: this.recovery.kind,
      pendingAction: this.pendingAction,
      pauseRequested: this.pauseRequested,
      runAttached: this.host !== null,
      workflowActive: this.workflowActive,
    });
    return {
      project: this.project,
      status: this.status,
      recovery: this.recovery,
      controls,
      pendingAction: this.pendingAction,
      pauseRequested: this.pauseRequested,
      runAttached: this.host !== null,
      lastError: this.lastError,
      lastOutcome: this.lastOutcome,
    };
  }

  /** Emits only when something actually changed — polling never floods the renderer. */
  private publish(): void {
    const snapshot = this.buildSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastEmitted) return;
    this.lastEmitted = serialized;
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  /** Coalesces overlapping refreshes (bursts of events) into at most one extra pass. */
  private refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshQueued = false;
        await this.refreshOnce();
      } while (this.refreshQueued && !this.disposed);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    const engine = this.engine;
    if (!engine) {
      this.status = null;
      this.recovery = NO_RECOVERY;
    } else {
      try {
        const status = await engine.status();
        const recovery = await engine.checkRecovery();
        const workflowActive = this.project ? await this.opts.workflowActivity(this.project.path) : false;
        if (engine !== this.engine) return; // project switched mid-refresh
        this.status = status;
        this.recovery = recovery;
        this.workflowActive = workflowActive;
      } catch (err) {
        this.lastError = redactUiError(unexpectedError(err));
      }
    }
    if (this.host === null && this.status?.status !== 'RUNNING') this.pauseRequested = false;
    this.publish();
  }

  private schedulePoll(): void {
    if (this.disposed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const active = this.host !== null || this.pendingAction !== null || this.status?.status === 'RUNNING';
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh().finally(() => this.schedulePoll());
    }, active ? this.opts.activePollMs : this.opts.idlePollMs);
  }
}
