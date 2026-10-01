import { extractSection } from '../journal/journal.ts';
import { decideWorkflow, type WorkflowDecision } from './decider.ts';
import type { WorkflowDefinition } from './definition.ts';
import type { ExecutionPort, ExecutionPortResult } from './execution-port.ts';
import { validateAndHashWorkflowDefinition } from './hash.ts';
import { reconcileAttempt, type ReconcileFacts, type ReconcileSession } from './reconciler.ts';
import { outputFromReport, outputKey, renderTask } from './step-planner.ts';
import { WorkflowStore, type WorkflowHandle } from './store.ts';
import { LIVE_ATTEMPT_STATES, TERMINAL_ATTEMPT_STATES, type WorkflowAttempt, type WorkflowCommand, type WorkflowInput, type WorkflowInstance } from './types.ts';
import type { WorkflowValidationError } from './validator.ts';
import { outcomeOnlyVerifier, type VerificationPort } from './verification.ts';
import { acquireWorkflowLock, releaseWorkflowLock } from './workflow-lock.ts';

/**
 * M5.5 + M5.6 — the WorkflowEngine: the imperative shell around the pure decider
 * (docs/21 §3.3). The supervisor of one workflow instance, in the Workflow Host (ADR-011).
 *
 *   input → decideWorkflow (pure) → store.commit (events first, then snapshot) → commands
 *
 * Inputs are serialized through one queue, so decisions happen in a single order that the
 * event log replays exactly. Commands run only AFTER their decision is durable — the
 * write-ahead intent (attempt LAUNCHING) is on disk before ExecutionPort.start() is called.
 *
 * Execution is reached ONLY through ExecutionPort: this module spawns nothing, never touches
 * Claude/Codex, adapters, the Orchestrator or BridgeEngine state. Verification is OutcomeOnly
 * (AI_ATTESTED). There is no retry: one attempt per step; on restart the reconciler decides
 * what an unfinished attempt's execution really did, and the SAME execution is linked,
 * watched, adopted or resumed — a new execution is started only when none can exist.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EngineInput = DistributiveOmit<WorkflowInput, 'at'>;

export interface WorkflowEngineDeps {
  /** `<project>/.ai-bridge`. */
  aiBridgeDir: string;
  port: ExecutionPort;
  store?: WorkflowStore;
  verifier?: VerificationPort;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
  /** How long a launched Execution Host may still be in preflight (default 5 min). */
  preflightGraceMs?: number;
  /** Poll interval for watching, stop retries and reconciliation waits (default 1 s). */
  pollIntervalMs?: number;
}

type ResolvedDeps = Required<Omit<WorkflowEngineDeps, 'store'>> & { store: WorkflowStore };

export type EngineResult = { ok: true; engine: WorkflowEngine } | { ok: false; code: 'LOCKED' | 'INVALID' | 'NOT_FOUND' | 'BROKEN' | 'INCOMPLETE' | 'INVALID_ID'; reason: string; errors?: WorkflowValidationError[] };

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class WorkflowEngine {
  readonly #deps: ResolvedDeps;
  #handle: WorkflowHandle;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #tasks = new Set<Promise<void>>();
  #disposed = false;
  /** Inputs the decider refused (stale events etc.) — diagnostics only. */
  readonly rejections: { input: WorkflowInput; reason: string }[] = [];
  /** Errors from background tasks (store/port failures) — the instance stays at its last durable state. */
  readonly errors: Error[] = [];

  private constructor(deps: ResolvedDeps, handle: WorkflowHandle) {
    this.#deps = deps;
    this.#handle = handle;
  }

  /** Validates + hashes the definition, takes the workflow lock, creates a CREATED instance. */
  static async create(deps: WorkflowEngineDeps, rawDefinition: unknown, inputs: unknown): Promise<EngineResult> {
    const v = validateAndHashWorkflowDefinition(rawDefinition);
    if (!v.valid) return { ok: false, code: 'INVALID', reason: 'invalid workflow definition', errors: v.errors };
    const resolved = resolveDeps(deps);
    const lock = await acquireWorkflowLock(deps.aiBridgeDir);
    if (!lock.ok) return { ok: false, code: 'LOCKED', reason: `another workflow host holds the workflow lock (pid ${lock.pid})` };
    const created = await resolved.store.create(v.definition, v.definitionHash, inputs);
    if (!created.ok) {
      await releaseWorkflowLock(deps.aiBridgeDir);
      return { ok: false, code: 'INVALID', reason: 'invalid inputs', errors: created.errors };
    }
    return { ok: true, engine: new WorkflowEngine(resolved, created.handle) };
  }

  /** Re-hosts an existing instance after a restart: takes the lock, loads with repair (M5.3),
   * then reconciles any attempt whose execution this host never saw finish (M5.6). */
  static async open(deps: WorkflowEngineDeps, workflowId: string): Promise<EngineResult> {
    const resolved = resolveDeps(deps);
    const lock = await acquireWorkflowLock(deps.aiBridgeDir);
    if (!lock.ok) return { ok: false, code: 'LOCKED', reason: `another workflow host holds the workflow lock (pid ${lock.pid})` };
    const loaded = await resolved.store.load(workflowId, { repair: true });
    if (!loaded.ok) {
      await releaseWorkflowLock(deps.aiBridgeDir);
      return { ok: false, code: loaded.code, reason: loaded.reason };
    }
    const engine = new WorkflowEngine(resolved, loaded.handle);
    engine.#recoverOnOpen();
    return { ok: true, engine };
  }

  get workflowId(): string {
    return this.#handle.workflowId;
  }
  get instance(): WorkflowInstance {
    return this.#handle.instance;
  }
  get definition(): WorkflowDefinition {
    return this.#handle.definition;
  }
  get handle(): WorkflowHandle {
    return this.#handle;
  }

  start() {
    return this.submit({ type: 'START' });
  }
  pause() {
    return this.submit({ type: 'PAUSE_REQUESTED' });
  }
  resume() {
    return this.submit({ type: 'RESUME_REQUESTED' });
  }
  stop(cause: 'USER' | 'DEADLINE' = 'USER') {
    return this.submit({ type: 'STOP_REQUESTED', cause });
  }
  answer(answer: 'fail' | 'stop' | 'retry' | 'resume-execution' | 'approve-bypass') {
    return this.submit({ type: 'HUMAN_ANSWER', answer });
  }

  /** Decides and commits one input, then starts its commands. Serialized with every other input. */
  submit(input: EngineInput): Promise<WorkflowDecision> {
    const run = this.#chain.then(() => this.#apply({ ...input, at: this.#deps.now().toISOString() } as WorkflowInput));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Resolves once no input is queued and no command is still running. */
  async idle(): Promise<void> {
    for (;;) {
      await this.#chain;
      if (this.#tasks.size === 0) return;
      await Promise.race(this.#tasks);
    }
  }

  /** Stops background loops and releases the workflow lock (the instance stays as persisted). */
  async close(): Promise<void> {
    this.#disposed = true;
    await releaseWorkflowLock(this.#deps.aiBridgeDir);
  }

  /** Test seam: stop all background work WITHOUT releasing the lock — a simulated host crash. */
  abandon(): void {
    this.#disposed = true;
  }

  async #apply(input: WorkflowInput): Promise<WorkflowDecision> {
    if (this.#disposed) return { accepted: false, code: 'NOT_ALLOWED', reason: 'engine closed' };
    const decision = decideWorkflow(this.#handle.definition, this.#handle.instance, input);
    if (!decision.accepted) {
      this.rejections.push({ input, reason: decision.reason });
      return decision;
    }
    this.#handle = await this.#deps.store.commit(this.#handle, decision);
    for (const command of decision.commands) this.#dispatch(command);
    return decision;
  }

  #quiet(input: EngineInput): Promise<void> {
    return this.submit(input).then(
      () => undefined,
      (err: unknown) => void this.errors.push(err instanceof Error ? err : new Error(String(err))),
    );
  }

  #track(work: Promise<void>): void {
    const task = work.catch((err: unknown) => void this.errors.push(err instanceof Error ? err : new Error(String(err))));
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  #dispatch(command: WorkflowCommand): void {
    if (this.#disposed) return;
    switch (command.type) {
      case 'START_EXECUTION':
        return this.#track(this.#launch(command.attemptId, command.stepId, command.maxIterations, command.permissionPolicy));
      case 'RESUME_EXECUTION':
        return this.#track(this.#execute(command.attemptId, (onEvent, onSpawn) => this.#deps.port.resume({ executionId: command.executionId }, onEvent, onSpawn)));
      case 'VERIFY':
        return this.#track(this.#verify(command.attemptId));
      case 'PAUSE_EXECUTION':
        return this.#track(this.#deps.port.pause().then(() => undefined));
      case 'STOP_EXECUTION':
        return this.#track(this.#stopUntilEnded(command.attemptId));
      case 'RECONCILE':
        return this.#track(this.#reconcile(command.attemptId));
      case 'WATCH_EXECUTION':
        return this.#track(this.#watch(command.attemptId, command.executionId));
    }
  }

  #attempt(attemptId: string): WorkflowAttempt | null {
    for (const s of this.#handle.instance.steps) for (const a of s.attempts) if (a.attemptId === attemptId) return a;
    return null;
  }

  async #launch(attemptId: string, stepId: string, maxIterations: number, permissionPolicy?: 'bypass'): Promise<void> {
    const attempt = this.#attempt(attemptId);
    if (!attempt) return;
    const planned = renderTask(this.#handle.definition, this.#handle.instance.inputs, stepId, await this.#stepOutputs(stepId));
    await this.#deps.store.writeAttemptTask(this.#handle, attempt, planned.task);
    // M5.10.1: omitted = inherit the project's provider setting; `bypass` only after approve-bypass.
    const request = { attemptId, task: planned.task, maxIterations, ...(permissionPolicy !== undefined ? { permissionPolicy } : {}) };
    await this.#execute(attemptId, (onEvent, onSpawn) => this.#deps.port.start(request, onEvent, onSpawn));
  }

  /** Runs one ExecutionPort call and feeds its lifecycle back as inputs, in order. */
  async #execute(attemptId: string, call: (onEvent: (e: { event: string; runId: string; iteration: number }) => void, onSpawn: (pid: number) => void) => Promise<ExecutionPortResult>): Promise<void> {
    let lastIteration = this.#attempt(attemptId)?.observedIteration ?? 0;
    const onEvent = (e: { event: string; runId: string; iteration: number }) => {
      if (e.event === 'RUN_STARTED') void this.#quiet({ type: 'EXECUTION_LINKED', attemptId, executionId: e.runId });
      else if (e.iteration > lastIteration) {
        lastIteration = e.iteration;
        void this.#quiet({ type: 'EXECUTION_PROGRESS', attemptId, iteration: e.iteration });
      }
    };
    const onSpawn = (pid: number) => void this.#quiet({ type: 'EXECUTION_HOST_SPAWNED', attemptId, hostPid: pid });
    let result: ExecutionPortResult['summary'];
    try {
      result = (await call(onEvent, onSpawn)).summary;
    } catch (err) {
      this.errors.push(err instanceof Error ? err : new Error(String(err)));
      result = { kind: 'HOST_FAILED', executionId: this.#attempt(attemptId)?.executionId ?? null };
    }
    if (this.#disposed) return;
    await this.#quiet({ type: 'EXECUTION_ENDED', attemptId, result });
  }

  async #verify(attemptId: string): Promise<void> {
    const attempt = this.#attempt(attemptId);
    if (!attempt) return;
    const outcome = await this.#deps.verifier.verify(attempt);
    await this.#quiet({ type: 'VERIFICATION_COMPLETED', attemptId, verdict: outcome.verdict, evidenceLevel: outcome.evidenceLevel, failureSummary: outcome.failureSummary });
  }

  /** M5.4 note: BridgeEngine.stop() is a no-op until the Execution Host holds the run lock
   * (its preflight window). Keep asking until the attempt's execution has actually ended;
   * the attempt is never marked STOPPED before the execution's outcome says so. */
  async #stopUntilEnded(attemptId: string): Promise<void> {
    while (!this.#disposed) {
      const attempt = this.#attempt(attemptId);
      if (!attempt || !LIVE_ATTEMPT_STATES.includes(attempt.state)) return;
      const r = await this.#deps.port.stop().catch(() => null);
      if (r?.kind === 'STOPPED') return;
      await sleep(this.#deps.pollIntervalMs);
    }
  }

  /** Follows an execution that runs in a host this engine is not attached to, then reconciles. */
  async #watch(attemptId: string, executionId: string): Promise<void> {
    while (!this.#disposed) {
      const status = await this.#deps.port.status();
      if (status.runId !== executionId || status.status !== 'RUNNING') break;
      await sleep(this.#deps.pollIntervalMs);
    }
    await this.#reconcile(attemptId);
  }

  async #reconcile(attemptId: string): Promise<void> {
    while (!this.#disposed) {
      const attempt = this.#attempt(attemptId);
      if (!attempt || !LIVE_ATTEMPT_STATES.includes(attempt.state) || this.#handle.instance.state !== 'RUNNING') return;
      const action = reconcileAttempt(attempt, await this.#facts(attempt));
      switch (action.action) {
        case 'LINK':
          await this.#quiet({ type: 'EXECUTION_LINKED', attemptId, executionId: action.executionId });
          continue;
        case 'ADOPT':
          await this.#quiet({ type: 'EXECUTION_ENDED', attemptId, result: action.result });
          return;
        case 'FINDING':
          await this.#quiet({ type: 'RECONCILED', attemptId, finding: action.finding });
          return;
        case 'WAIT':
          await sleep(this.#deps.pollIntervalMs);
          continue;
        case 'NONE':
          return;
      }
    }
  }

  async #facts(attempt: WorkflowAttempt): Promise<ReconcileFacts> {
    const port = this.#deps.port;
    const status = await port.status();
    const recovery = await port.checkRecovery();
    const summaries = await port.findExecutions({ startedAfter: attempt.launchedAt ?? attempt.plannedAt });
    if (attempt.executionId !== null && !summaries.some((s) => s.runId === attempt.executionId)) {
      const own = (await port.findExecutions({ startedAfter: '' })).find((s) => s.runId === attempt.executionId);
      if (own) summaries.push(own);
    }
    const sessions: ReconcileSession[] = [];
    for (const s of summaries) {
      const started = (await port.artifacts(s.runId))?.events.find((e) => e.event === 'RUN_STARTED');
      sessions.push({ runId: s.runId, startedAt: s.startedAt, status: s.status, iterations: s.iterations, errorCode: s.errorCode, correlation: typeof started?.correlation === 'string' ? started.correlation : null });
    }
    const alive = this.#deps.isPidAlive;
    const ownsCurrent = status.runId !== null && status.runId === attempt.executionId;
    return {
      nowMs: this.#deps.now().getTime(),
      preflightGraceMs: this.#deps.preflightGraceMs,
      current: { runId: status.runId, status: status.status },
      recoverable: recovery.kind === 'RECOVERABLE' && recovery.runId === attempt.executionId,
      sessions,
      hostAlive: typeof attempt.hostPid === 'number' ? alive(attempt.hostPid) : null,
      cliAlive: ownsCurrent && [status.claude.pid, status.codex.pid].some((pid) => pid !== null && alive(pid)),
    };
  }

  /** Earlier steps' declared outputs, read from their execution's validated report. */
  async #stepOutputs(stepId: string): Promise<Map<string, string | null>> {
    const outputs = new Map<string, string | null>();
    const def = this.#handle.definition;
    const until = def.steps.findIndex((s) => s.id === stepId);
    for (const stepDef of def.steps.slice(0, until)) {
      if (!stepDef.outputs?.length) continue;
      const passed = this.#handle.instance.steps.find((s) => s.stepId === stepDef.id)?.attempts.find((a) => a.state === 'PASSED');
      const artifacts = passed?.executionId ? await this.#deps.port.artifacts(passed.executionId) : null;
      const report = artifacts?.iterations
        .map((it) => it.report)
        .filter((r) => r.availability === 'AVAILABLE')
        .at(-1);
      const text = report && report.availability === 'AVAILABLE' ? report.text : null;
      for (const name of stepDef.outputs) outputs.set(outputKey(stepDef.id, name), text === null ? null : outputFromReport(name, (h) => extractSection(text, h)));
    }
    return outputs;
  }

  /** After a restart: finish what the dead host left open. Never starts a new execution
   * for an attempt that already has (or may have) one. */
  #recoverOnOpen(): void {
    const instance = this.#handle.instance;
    if (instance.state !== 'RUNNING') return;
    const open = instance.steps.flatMap((s) => s.attempts).find((a) => !TERMINAL_ATTEMPT_STATES.includes(a.state));
    if (!open) return;
    if (LIVE_ATTEMPT_STATES.includes(open.state)) {
      this.#dispatch({ type: 'RECONCILE', attemptId: open.attemptId });
      if (instance.stopRequested) this.#dispatch({ type: 'STOP_EXECUTION', attemptId: open.attemptId });
    } else if (open.state === 'VERIFYING') {
      this.#dispatch({ type: 'VERIFY', attemptId: open.attemptId }); // OutcomeOnly verification is idempotent
    }
  }
}

function resolveDeps(deps: WorkflowEngineDeps): ResolvedDeps {
  const now = deps.now ?? (() => new Date());
  return {
    aiBridgeDir: deps.aiBridgeDir,
    port: deps.port,
    store: deps.store ?? new WorkflowStore(deps.aiBridgeDir, { now }),
    verifier: deps.verifier ?? outcomeOnlyVerifier,
    now,
    isPidAlive: deps.isPidAlive ?? defaultIsPidAlive,
    preflightGraceMs: deps.preflightGraceMs ?? 5 * 60 * 1000,
    pollIntervalMs: deps.pollIntervalMs ?? 1000,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
