import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../core/security/redact.ts';
import type { WorkflowDecision } from '../core/workflow/decider.ts';
import { deriveWorkflowControls } from '../core/workflow/controls.ts';
import { WorkflowEngine, type EngineResult, type WorkflowEngineDeps } from '../core/workflow/engine.ts';
import { readEventLog } from '../core/workflow/event-log.ts';
import type { ExecutionPort } from '../core/workflow/execution-port.ts';
import { writeWorkflowJournal } from '../core/workflow/journal.ts';
import { WorkflowStore, type WorkflowHandle, type WorkflowStoreDeps } from '../core/workflow/store.ts';
import type { WorkflowEvent, WorkflowInstanceState } from '../core/workflow/types.ts';
import { advertiseHostedWorkflow, serveControlRequests, withdrawHostedWorkflow } from './workflow-control-channel.ts';
import {
  isWorkflowHostCommand,
  isWorkflowHostControl,
  type WorkflowControlAction,
  type WorkflowControlResult,
  type WorkflowErrorCode,
  type WorkflowHostCommand,
  type WorkflowHostEnd,
  type WorkflowHostError,
  type WorkflowHostMessage,
} from './workflow-host-protocol.ts';
import { checkWorkflowStartAvailability, formatValidationErrors, loadWorkflowDefinition, loadFailure } from './workflow-read.ts';

/**
 * M5.8 — the Workflow Host (ADR-011 option A): the process that owns one WorkflowEngine for
 * one workflow instance, from one lifecycle command until the instance rests.
 *
 *   lifecycle command → create/open the engine (it takes the workflow lock) → submit the
 *   command → forward every event the engine persists → answer pause/stop requests → once
 *   the instance is PAUSED / WAITING_HUMAN / BLOCKED / terminal and nothing is in flight:
 *   release the lock and end.
 *
 * It owns the engine's lifecycle only. Every workflow decision is the WorkflowEngine's; every
 * execution runs in its own Execution Host behind the ExecutionPort. It never spawns
 * Claude/Codex, never reads or writes BridgeEngine state, and never talks to a renderer.
 *
 * Persistence stays authoritative: after each commit (events, then snapshot) the host
 * regenerates the derived `workflow.md` (M5.7) and forwards the newly persisted events, read
 * back from the verified log. Nothing flows the other way — the journal and the forwarded
 * events never feed a decision.
 *
 * Used two ways: forked by Electron Main (serveWorkflowHost, via workflow-host-entry.ts) and
 * in-process by the CLI, which then is the Workflow Host itself (as `ai-bridge start` is the
 * run-lock holder today).
 */

export interface WorkflowHostDeps {
  projectPath: string;
  port: ExecutionPort;
  /** Engine tuning / test seams (defaults are the engine's own). */
  engine?: Pick<WorkflowEngineDeps, 'now' | 'isPidAlive' | 'preflightGraceMs' | 'pollIntervalMs'>;
  /** How often the cross-process control inbox is read while hosting (default 250 ms). */
  controlPollMs?: number;
}

export type WorkflowHostBegin = { ok: true; workflowId: string; state: WorkflowInstanceState } | { ok: false; error: WorkflowHostError };

/** One Workflow Host per process: a process hosts exactly one workflow instance at a time
 * (ADR-011). Complements the pid-based workflow lock, which cannot tell two hosts of the same
 * process apart. */
let hostingInThisProcess = false;

const hostError = (code: WorkflowErrorCode, message: string, details?: string[]): WorkflowHostError => (details?.length ? { code, message, details } : { code, message });

function engineFailure(r: Extract<EngineResult, { ok: false }>): WorkflowHostError {
  switch (r.code) {
    case 'LOCKED':
      return hostError('WORKFLOW_LOCKED', r.reason);
    case 'INVALID':
      return r.reason === 'invalid inputs' ? hostError('INPUTS_INVALID', 'the inputs do not match the definition', formatValidationErrors(r.errors ?? [])) : hostError('DEFINITION_INVALID', r.reason, formatValidationErrors(r.errors ?? []));
    case 'INVALID_ID':
      return hostError('INVALID_REQUEST', r.reason);
    case 'NOT_FOUND':
      return hostError('WORKFLOW_NOT_FOUND', r.reason);
    case 'INCOMPLETE':
      return hostError('WORKFLOW_INCOMPLETE', r.reason);
    case 'BROKEN':
      return hostError('WORKFLOW_BROKEN', `the workflow's audit log failed verification: ${r.reason}`);
  }
}

/** The engine's store, observed: after every durable commit, a checkpoint (journal + events). */
class CheckpointStore extends WorkflowStore {
  readonly #onCommitted: (handle: WorkflowHandle) => Promise<void>;

  constructor(aiBridgeDir: string, deps: WorkflowStoreDeps, onCommitted: (handle: WorkflowHandle) => Promise<void>) {
    super(aiBridgeDir, deps);
    this.#onCommitted = onCommitted;
  }

  override async commit(handle: WorkflowHandle, decision: WorkflowDecision): Promise<WorkflowHandle> {
    const next = await super.commit(handle, decision);
    await this.#onCommitted(next);
    return next;
  }
}

export class WorkflowHost {
  readonly #deps: WorkflowHostDeps;
  readonly #aiBridgeDir: string;
  readonly #onEvent: (event: WorkflowEvent) => void;
  readonly #store: CheckpointStore;
  #engine: WorkflowEngine | null = null;
  #begun = false;
  #closing = false;
  #forwardedSeq = 0;
  #inboxTimer: ReturnType<typeof setTimeout> | null = null;
  #inbox: Promise<number> = Promise.resolve(0);
  #ended: Promise<WorkflowHostEnd> | null = null;
  /** Journal/forwarding problems: diagnostics only — they never affect the workflow. */
  readonly diagnostics: string[] = [];

  constructor(deps: WorkflowHostDeps, onEvent: (event: WorkflowEvent) => void = () => {}) {
    this.#deps = deps;
    this.#aiBridgeDir = path.join(path.resolve(deps.projectPath), '.ai-bridge');
    this.#onEvent = onEvent;
    this.#store = new CheckpointStore(this.#aiBridgeDir, deps.engine?.now ? { now: deps.engine.now } : {}, (h) => this.#checkpoint(h));
  }

  get workflowId(): string | null {
    return this.#engine?.workflowId ?? null;
  }

  /** The hosted engine (read-only use: state for callers and tests). */
  get engine(): WorkflowEngine | null {
    return this.#engine;
  }

  /** Runs exactly one lifecycle command. Refusals leave nothing behind: no lock, no instance. */
  async begin(command: WorkflowHostCommand): Promise<WorkflowHostBegin> {
    if (!isWorkflowHostCommand(command)) return { ok: false, error: hostError('INVALID_REQUEST', 'not a valid Workflow Host command') };
    if (this.#begun) return { ok: false, error: hostError('INVALID_REQUEST', 'a Workflow Host runs exactly one lifecycle command') };
    this.#begun = true;
    if (hostingInThisProcess) return { ok: false, error: hostError('WORKFLOW_LOCKED', 'this process already hosts a workflow') };
    hostingInThisProcess = true;
    try {
      const opened = command.type === 'run' ? await this.#create(command) : await this.#open(command);
      if (!opened.ok) {
        hostingInThisProcess = false;
        return opened;
      }
      const engine = opened.engine;
      this.#engine = engine;
      await advertiseHostedWorkflow(this.#aiBridgeDir, engine.workflowId);
      await this.#checkpoint(engine.handle);
      const decision = await this.#submit(command, engine);
      if (decision !== null && !decision.accepted) {
        await this.#release();
        return { ok: false, error: hostError('NOT_ALLOWED', decision.reason) };
      }
      this.#scheduleInbox();
      return { ok: true, workflowId: engine.workflowId, state: engine.instance.state };
    } catch (err) {
      if (this.#engine) await this.#release().catch(() => undefined);
      else hostingInThisProcess = false;
      return { ok: false, error: hostError('HOST_FAILED', redactSecrets(err instanceof Error ? err.message : String(err))) };
    }
  }

  /** Pause or stop the hosted workflow (from the parent's IPC or the control inbox). */
  async control(action: WorkflowControlAction): Promise<WorkflowControlResult> {
    const engine = this.#engine;
    if (!engine || this.#closing) return { ok: false, error: hostError('HOST_UNAVAILABLE', 'this Workflow Host is not serving a workflow (not started yet, or ending) — try again') };
    const decision = action === 'pause' ? await engine.pause() : await engine.stop('USER');
    return decision.accepted ? { ok: true, state: engine.instance.state } : { ok: false, error: hostError('NOT_ALLOWED', decision.reason) };
  }

  /** Resolves once the instance rests and the workflow lock is released. */
  finished(): Promise<WorkflowHostEnd> {
    if (!this.#engine) return Promise.reject(new Error('the Workflow Host has not begun'));
    this.#ended ??= this.#untilRest(this.#engine);
    return this.#ended;
  }

  /** Test seam: a simulated Workflow Host crash — background work stops, the lock and the host
   * record stay behind exactly as a killed process would leave them. */
  abandon(): void {
    this.#closing = true;
    if (this.#inboxTimer) clearTimeout(this.#inboxTimer);
    this.#inboxTimer = null;
    this.#engine?.abandon();
    hostingInThisProcess = false;
  }

  // -------------------------------------------------------------------------

  async #create(command: Extract<WorkflowHostCommand, { type: 'run' }>): Promise<{ ok: true; engine: WorkflowEngine } | { ok: false; error: WorkflowHostError }> {
    const def = await loadWorkflowDefinition(this.#aiBridgeDir, command.definitionId);
    if (!def.ok) return def;
    if (def.definitionHash !== command.definitionHash) return { ok: false, error: hostError('DEFINITION_CHANGED', `workflow definition ${command.definitionId} changed after it was validated (hash ${def.definitionHash})`) };
    const port = this.#deps.port;
    const available = await checkWorkflowStartAvailability(this.#aiBridgeDir, { status: await port.status(), recovery: await port.checkRecovery() });
    if (!available.ok) return available;
    const r = await WorkflowEngine.create(this.#engineDeps(), def.raw, command.inputs);
    return r.ok ? r : { ok: false, error: engineFailure(r) };
  }

  async #open(command: Exclude<WorkflowHostCommand, { type: 'run' }>): Promise<{ ok: true; engine: WorkflowEngine } | { ok: false; error: WorkflowHostError }> {
    // Checked against Core's controls BEFORE the engine is opened (opening reconciles), so a
    // refused command changes nothing. The decider re-checks after opening.
    const peek = await this.#store.load(command.workflowId, { repair: false });
    if (!peek.ok) return loadFailure(peek);
    const instance = peek.handle.instance;
    const controls = deriveWorkflowControls(instance, { hostAlive: false });
    const allowed = command.type === 'resume' ? controls.canResume || controls.canStart : command.type === 'answer' ? controls.canAnswer.includes(command.answer) : controls.canStop;
    if (!allowed) return { ok: false, error: hostError('NOT_ALLOWED', `cannot ${command.type} workflow ${command.workflowId} in state ${instance.state}${command.type === 'answer' ? ` (accepted answers: ${controls.canAnswer.join(', ') || 'none'})` : ''}`) };
    // Events persisted after the last snapshot (a store repair, then reconciliation on open)
    // are forwarded; older history is read with getWorkflowEvents.
    this.#forwardedSeq = await this.#snapshotSeq(command.workflowId);
    const r = await WorkflowEngine.open(this.#engineDeps(), command.workflowId);
    return r.ok ? r : { ok: false, error: engineFailure(r) };
  }

  #engineDeps(): WorkflowEngineDeps {
    return { aiBridgeDir: this.#aiBridgeDir, port: this.#deps.port, store: this.#store, ...this.#deps.engine };
  }

  async #snapshotSeq(workflowId: string): Promise<number> {
    try {
      const snap = JSON.parse(await readFile(this.#store.paths(workflowId).snapshot, 'utf8')) as { lastEventSeq?: unknown };
      return typeof snap.lastEventSeq === 'number' ? snap.lastEventSeq : 0;
    } catch {
      return 0;
    }
  }

  /** The lifecycle command → one engine input (null: re-hosting alone is the action). */
  #submit(command: WorkflowHostCommand, engine: WorkflowEngine): Promise<WorkflowDecision> | null {
    switch (command.type) {
      case 'run':
        return engine.start();
      case 'resume': {
        const state = engine.instance.state;
        if (state === 'CREATED') return engine.start();
        // RUNNING on disk = interrupted: opening it already reconciles (M5.6); nothing else to submit.
        if (state === 'RUNNING') return null;
        return engine.resume(); // PAUSED / BLOCKED continue; anything else is refused by the decider
      }
      case 'answer':
        return engine.answer(command.answer);
      case 'stop':
        return engine.stop('USER');
    }
  }

  /** After a durable commit: rebuild the derived journal, then forward what was persisted. */
  async #checkpoint(handle: WorkflowHandle): Promise<void> {
    try {
      await writeWorkflowJournal(this.#aiBridgeDir, handle.workflowId, { store: this.#store });
    } catch (err) {
      this.diagnostics.push(`journal: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const log = await readEventLog(handle.paths.events, handle.workflowId);
      if (!log.ok) {
        this.diagnostics.push(`events: ${log.reason}`);
        return;
      }
      for (const event of log.events) {
        if (event.seq <= this.#forwardedSeq) continue;
        this.#forwardedSeq = event.seq;
        try {
          this.#onEvent(event);
        } catch {
          // a broken observer never affects the workflow
        }
      }
    } catch (err) {
      this.diagnostics.push(`events: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #scheduleInbox(): void {
    if (this.#closing) return;
    this.#inboxTimer = setTimeout(() => {
      this.#inboxTimer = null;
      void this.#serveInbox().finally(() => this.#scheduleInbox());
    }, this.#deps.controlPollMs ?? 250);
  }

  /** Serialized: the timer and the final drain never read the inbox at the same time. */
  #serveInbox(): Promise<number> {
    const run = this.#inbox.then(async () => {
      const engine = this.#engine;
      if (!engine) return 0;
      try {
        return await serveControlRequests(this.#aiBridgeDir, engine.workflowId, (action) => this.control(action));
      } catch (err) {
        this.diagnostics.push(`control: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }
    });
    this.#inbox = run.catch(() => 0);
    return run;
  }

  async #untilRest(engine: WorkflowEngine): Promise<WorkflowHostEnd> {
    for (;;) {
      await engine.idle();
      // A request that arrived while the last work finished is still honoured.
      if ((await this.#serveInbox()) === 0) break;
    }
    const state = engine.instance.state;
    await this.#release();
    return { workflowId: engine.workflowId, state, reason: state === 'RUNNING' ? 'STALLED' : 'REST', errors: engine.errors.map((e) => redactSecrets(e.message)) };
  }

  /** Stop serving, withdraw the host record, release the workflow lock. The instance stays as persisted. */
  async #release(): Promise<void> {
    const engine = this.#engine;
    this.#closing = true;
    if (this.#inboxTimer) clearTimeout(this.#inboxTimer);
    this.#inboxTimer = null;
    try {
      if (engine) {
        await this.#checkpoint(engine.handle);
        await withdrawHostedWorkflow(this.#aiBridgeDir, engine.workflowId);
        await engine.close();
      }
    } finally {
      hostingInThisProcess = false;
    }
  }
}

// ---------------------------------------------------------------------------
// process wiring (the forked Workflow Host)
// ---------------------------------------------------------------------------

export interface ServeWorkflowHostOptions {
  createDeps: (projectPath: string) => WorkflowHostDeps;
}

/** Wires a WorkflowHost to this process's IPC channel: the first message is the lifecycle
 * command, later ones are control requests. Exits once the instance rests. If the parent goes
 * away (the app quits or crashes), the workflow keeps going; its state is persisted either way. */
export function serveWorkflowHost(options: ServeWorkflowHostOptions): void {
  const send = (message: WorkflowHostMessage, done?: () => void): void => {
    if (process.connected && process.send) process.send(message, undefined, {}, () => done?.());
    else done?.();
  };
  let host: WorkflowHost | null = null;

  process.on('message', (raw: unknown) => {
    if (host === null) {
      if (!isWorkflowHostCommand(raw)) {
        send({ type: 'rejected', error: hostError('INVALID_REQUEST', 'the Workflow Host received an invalid command') }, () => process.exit(2));
        return;
      }
      const current = new WorkflowHost(options.createDeps(raw.projectPath), (event) => send({ type: 'event', event }));
      host = current;
      current
        .begin(raw)
        .then(async (began) => {
          if (!began.ok) {
            send({ type: 'rejected', error: began.error }, () => process.exit(0));
            return;
          }
          send({ type: 'accepted', workflowId: began.workflowId, state: began.state });
          const end = await current.finished();
          send({ type: 'ended', end }, () => process.exit(0));
        })
        .catch((err: unknown) => send({ type: 'failed', message: redactSecrets(err instanceof Error ? err.message : String(err)) }, () => process.exit(1)));
      return;
    }
    if (isWorkflowHostControl(raw)) {
      void host.control(raw.action).then((result) => send({ type: 'control-result', requestId: raw.requestId, result }));
      return;
    }
    const requestId = typeof raw === 'object' && raw !== null && typeof (raw as { requestId?: unknown }).requestId === 'string' ? (raw as { requestId: string }).requestId : '';
    send({ type: 'control-result', requestId, result: { ok: false, error: hostError('INVALID_REQUEST', 'not a valid control request') } });
  });
}
