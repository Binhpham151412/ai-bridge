import path from 'node:path';
import type { BridgeEngine, BridgeRunOutcome } from '../core/bridge-engine.ts';
import type { BridgeEvent } from '../core/observability/events.ts';
import { detectUsageLimit } from '../core/providers/cli-provider.ts';
import type { SessionArtifacts } from '../core/session-history/session-history.ts';
import type { ExecutionHostExit, ExecutionHostFailureKind, ExecutionPort, ExecutionPortResult, ExecutionRequest } from '../core/workflow/execution-port.ts';
import type { ExecutionResultSummary } from '../core/workflow/types.ts';
import { isHostMessage, type HostCommand } from '../desktop/main/run-host-protocol.ts';
import type { RunHostProcess } from '../desktop/main/run-controller.ts';

/**
 * M5.4 — ExecutionPort over the Execution Host (ADR-011 option A, docs/23 §3).
 *
 * Every `start()`/`resume()` runs in its OWN child process: the existing run host
 * (`desktop/main/run-host.ts` `serveRunHost`, Electron-free), speaking the existing
 * HostCommand/HostMessage protocol — the same host Electron Main already forks. That host
 * holds the project run lock, so `BridgeEngine.stop()` — called here in-process — kills
 * exactly that host's process tree and never the caller (the Workflow Host).
 *
 * The port is thin (docs/23 §9): it forwards run events, reduces the host's typed outcome
 * to the decider's ExecutionResultSummary, and reports host failures as facts. It never
 * retries, never relaunches, never parses CLI output beyond what BridgeEngine already
 * recorded, and runs at most one execution at a time (M5 is sequential).
 */

export type ExecutionEngine = Pick<BridgeEngine, 'pause' | 'stop' | 'status' | 'checkRecovery' | 'getSessionArtifacts' | 'listSessions'>;

export interface ForkedExecutionPortOptions {
  projectPath: string;
  /** In-process BridgeEngine for the project: status/read calls and stop/pause only —
   * never start/resume (those always run in an Execution Host). */
  engine: ExecutionEngine;
  /** Creates one Execution Host process (production: `forkRunHost` with the run-host entry). */
  spawnHost: () => RunHostProcess;
}

interface Observed {
  outcome: BridgeRunOutcome | null;
  failedMessage: string | null;
  runStartedId: string | null;
  runStartedSeen: boolean;
  observedCorrelation: string | null;
  invalidMessages: number;
  exit: ExecutionHostExit | null;
}

export class ForkedExecutionPort implements ExecutionPort {
  readonly #projectPath: string;
  readonly #engine: ExecutionEngine;
  readonly #spawnHost: () => RunHostProcess;
  #active = false;
  #stopRequested = false;
  #stopping: Promise<unknown> | null = null;

  constructor(options: ForkedExecutionPortOptions) {
    this.#projectPath = options.projectPath;
    this.#engine = options.engine;
    this.#spawnHost = options.spawnHost;
  }

  start(request: ExecutionRequest, onEvent?: (event: BridgeEvent) => void, onHostSpawned?: (pid: number) => void): Promise<ExecutionPortResult> {
    const correlation = request.correlation ?? request.attemptId;
    const command: HostCommand = {
      type: 'start',
      projectPath: this.#projectPath,
      task: request.task,
      maxIterations: request.maxIterations,
      correlation,
      ...(request.permissionPolicy !== undefined ? { permissionPolicy: request.permissionPolicy } : {}),
    };
    return this.#run(command, { correlation, knownExecutionId: null, baseIteration: 0 }, onEvent, onHostSpawned);
  }

  async resume(ref: { executionId: string }, onEvent?: (event: BridgeEvent) => void, onHostSpawned?: (pid: number) => void): Promise<ExecutionPortResult> {
    this.#assertIdle();
    // BridgeEngine.resume() continues the project's CURRENT session only — never resume
    // someone else's run (docs/23 §7.3).
    const status = await this.#engine.status();
    if (status.runId !== ref.executionId) {
      return blankResult({ kind: 'RESUME_REFUSED', reason: 'NOT_CURRENT_SESSION' }, { executionId: ref.executionId });
    }
    const persisted = (await this.#engine.getSessionArtifacts(ref.executionId))?.state?.correlation;
    const correlation = typeof persisted === 'string' ? persisted : null;
    return this.#run({ type: 'resume', projectPath: this.#projectPath }, { correlation, knownExecutionId: ref.executionId, baseIteration: status.iteration }, onEvent, onHostSpawned);
  }

  pause() {
    return this.#engine.pause();
  }

  stop() {
    if (this.#active) this.#stopRequested = true;
    const stopping = this.#engine.stop();
    this.#stopping = stopping;
    return stopping;
  }

  status() {
    return this.#engine.status();
  }

  checkRecovery() {
    return this.#engine.checkRecovery();
  }

  artifacts(executionId: string) {
    return this.#engine.getSessionArtifacts(executionId);
  }

  async findExecutions(filter: { startedAfter: string }) {
    return (await this.#engine.listSessions()).filter((s) => s.startedAt !== null && s.startedAt >= filter.startedAfter);
  }

  #assertIdle(): void {
    if (this.#active) throw new Error('EXECUTION_PORT_BUSY: an execution is already running through this port (M5 runs one at a time)');
  }

  async #run(
    command: HostCommand,
    ctx: { correlation: string | null; knownExecutionId: string | null; baseIteration: number },
    onEvent?: (event: BridgeEvent) => void,
    onHostSpawned?: (pid: number) => void,
  ): Promise<ExecutionPortResult> {
    this.#assertIdle();
    this.#active = true;
    this.#stopRequested = false;
    this.#stopping = null;
    try {
      let host: RunHostProcess;
      try {
        host = this.#spawnHost();
      } catch (err) {
        return blankResult({ kind: 'HOST_FAILED', executionId: ctx.knownExecutionId }, {
          executionId: ctx.knownExecutionId,
          correlation: ctx.correlation,
          hostFailure: { kind: 'SPAWN_FAILED', message: err instanceof Error ? err.message : String(err) },
        });
      }
      if (host.pid !== undefined) {
        try {
          onHostSpawned?.(host.pid);
        } catch {
          // an observer error never affects the execution
        }
      }
      const seen = await this.#observe(host, command, onEvent);
      return await this.#finish(host.pid ?? null, seen, ctx);
    } finally {
      this.#active = false;
    }
  }

  #observe(host: RunHostProcess, command: HostCommand, onEvent?: (event: BridgeEvent) => void): Promise<Observed> {
    const seen: Observed = { outcome: null, failedMessage: null, runStartedId: null, runStartedSeen: false, observedCorrelation: null, invalidMessages: 0, exit: null };
    return new Promise((resolve) => {
      host.onMessage((raw) => {
        if (!isHostMessage(raw)) {
          seen.invalidMessages += 1; // fail safe: ignored, counted, never acted on
          return;
        }
        if (raw.type === 'event') {
          const e = raw.event;
          if (e.event === 'RUN_STARTED' && !seen.runStartedSeen) {
            seen.runStartedSeen = true;
            seen.runStartedId = e.runId;
            seen.observedCorrelation = typeof e.correlation === 'string' ? e.correlation : null;
          }
          try {
            onEvent?.(e);
          } catch {
            // a broken observer never affects the execution
          }
        } else if (raw.type === 'outcome') {
          seen.outcome ??= raw.outcome;
        } else {
          seen.failedMessage ??= raw.message;
        }
      });
      host.onExit((exit) => {
        seen.exit = { code: exit.code, signal: exit.signal, stderrTail: exit.stderrTail };
        resolve(seen);
      });
      host.send(command);
    });
  }

  async #finish(hostPid: number | null, seen: Observed, ctx: { correlation: string | null; knownExecutionId: string | null; baseIteration: number }): Promise<ExecutionPortResult> {
    const outcome = seen.outcome;
    const executionId = outcome?.kind === 'COMPLETED' ? path.basename(outcome.sessionDir) : (seen.runStartedId ?? ctx.knownExecutionId);
    const base = {
      outcome,
      executionId,
      correlation: ctx.correlation,
      observedCorrelation: seen.observedCorrelation,
      hostExit: seen.exit,
      hostPid,
      invalidMessages: seen.invalidMessages,
      stopRequested: this.#stopRequested,
    };
    const failed = (kind: ExecutionHostFailureKind, message: string): ExecutionPortResult => ({ ...base, summary: { kind: 'HOST_FAILED', executionId }, hostFailure: { kind, message } });

    if (ctx.correlation !== null && seen.runStartedSeen && seen.observedCorrelation !== ctx.correlation) {
      return failed('CORRELATION_MISMATCH', `RUN_STARTED carried correlation ${JSON.stringify(seen.observedCorrelation)}, expected ${JSON.stringify(ctx.correlation)}`);
    }
    if (outcome) return { ...base, summary: await this.#summarize(outcome, executionId, ctx.baseIteration), hostFailure: null };
    if (seen.failedMessage !== null) return failed('HOST_REPORTED_FAILURE', seen.failedMessage);
    if (hostPid === null) return failed('SPAWN_FAILED', `the execution host could not be started${seen.exit?.stderrTail ? `: ${seen.exit.stderrTail.trim()}` : ''}`);

    // A stop requested through this port kills the host before it can report an outcome;
    // BridgeEngine.stop() itself records the run as STOPPED — read that fact (ADR-014),
    // once stop() has finished recording it.
    if (this.#stopRequested && executionId !== null) {
      await this.#stopping?.catch(() => undefined);
      const status = await this.#engine.status();
      if (status.runId === executionId && status.status === 'STOPPED') {
        const summary: ExecutionResultSummary = {
          kind: 'ENDED',
          executionId,
          finalStatus: 'STOPPED',
          errorCode: null,
          iterations: Math.max(0, status.iteration - ctx.baseIteration),
          reportedTokens: sumReportedTokens(await this.#engine.getSessionArtifacts(executionId), ctx.baseIteration),
          usageLimitDetected: false,
        };
        return { ...base, summary, hostFailure: null };
      }
    }
    return failed('EXITED_WITHOUT_OUTCOME', `the execution host exited (code ${seen.exit?.code ?? 'none'}, signal ${seen.exit?.signal ?? 'none'}) without an outcome`);
  }

  async #summarize(outcome: BridgeRunOutcome, executionId: string | null, baseIteration: number): Promise<ExecutionResultSummary> {
    if (outcome.kind !== 'COMPLETED') return summarizeOutcome(outcome, null);
    return summarizeOutcome(outcome, sumReportedTokens(executionId ? await this.#engine.getSessionArtifacts(executionId) : null, baseIteration));
  }
}

/** Reduces BridgeEngine's typed outcome to the decider's input (docs/26 §3). */
export function summarizeOutcome(outcome: BridgeRunOutcome, reportedTokens: number | null): ExecutionResultSummary {
  switch (outcome.kind) {
    case 'BLOCKED_PREFLIGHT':
    case 'ALREADY_RUNNING':
    case 'INVALID_OPTIONS':
      return { kind: 'NOT_STARTED', reason: outcome.kind };
    case 'NO_STATE':
    case 'RECOVERY_BLOCKED':
      return { kind: 'RESUME_REFUSED', reason: outcome.kind };
    case 'COMPLETED': {
      const d = outcome.diagnostics;
      const errorText = outcome.errorCode !== null ? [outcome.errorMessage ?? '', d?.stderrTail ?? '', d?.finalMessage ?? ''].join('\n') : '';
      return {
        kind: 'ENDED',
        executionId: path.basename(outcome.sessionDir),
        finalStatus: outcome.finalStatus,
        errorCode: outcome.errorCode,
        iterations: outcome.iterations,
        reportedTokens,
        usageLimitDetected: errorText !== '' && detectUsageLimit(errorText) !== null,
      };
    }
  }
}

/** CLI-reported token usage of the iterations after `baseIteration` (so a resumed segment is
 * not counted twice). null = UNKNOWN: no execution record, or any record without usage —
 * never estimated (M4.2 rule). */
export function sumReportedTokens(artifacts: SessionArtifacts | null, baseIteration: number): number | null {
  if (!artifacts) return null;
  const records = artifacts.iterations
    .filter((it) => it.iteration > baseIteration)
    .flatMap((it) => [it.claudeExecution, it.codexExecution])
    .filter((v): v is NonNullable<typeof v> => v !== null);
  if (records.length === 0) return null;
  let total = 0;
  for (const view of records) {
    const usage = view.record.usage;
    if (!usage) return null;
    total += usage.totalTokens;
  }
  return total;
}

function blankResult(summary: ExecutionResultSummary, o: Partial<ExecutionPortResult>): ExecutionPortResult {
  return { summary, outcome: null, executionId: null, correlation: null, observedCorrelation: null, hostFailure: null, hostExit: null, hostPid: null, invalidMessages: 0, stopRequested: false, ...o };
}
