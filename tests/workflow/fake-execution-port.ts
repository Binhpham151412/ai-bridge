// Scripted ExecutionPort for the M5.5/M5.6 engine tests: records every call and lets a
// test decide what each start/resume "execution" does. No process, no CLI, no quota.
import type { ExecutionPort, ExecutionPortResult, ExecutionRequest } from '../../src/core/workflow/execution-port.ts';
import type { ExecutionResultSummary } from '../../src/core/workflow/types.ts';
import type { BridgeEvent } from '../../src/core/observability/events.ts';

export interface FakeCall {
  kind: 'start' | 'resume';
  request: ExecutionRequest | null;
  executionId: string | null;
  emit: (event: Partial<BridgeEvent> & { event: string; iteration?: number }) => void;
  spawn: (pid: number) => void;
}

export interface FakeSession {
  runId: string;
  startedAt: string;
  status: string;
  iterations: number;
  errorCode: string | null;
  correlation: string | null;
  report?: string;
}

const never = <T>() => new Promise<T>(() => {});

export class FakeExecutionPort implements ExecutionPort {
  readonly calls: FakeCall[] = [];
  stopCalls = 0;
  pauseCalls = 0;
  /** Default: every run emits RUN_STARTED and ends DONE after 1 iteration. */
  behave: (call: FakeCall, n: number) => Promise<ExecutionResultSummary> = async (call, n) => {
    const runId = call.executionId ?? `2026-10-01_${String(n + 1).padStart(3, '0')}`;
    call.emit({ event: 'RUN_STARTED', runId, iteration: 0, correlation: call.request?.attemptId });
    return { kind: 'ENDED', executionId: runId, finalStatus: 'DONE', errorCode: null, iterations: 1, reportedTokens: 10, usageLimitDetected: false };
  };
  stopOutcomes: ('NOT_RUNNING' | 'STOPPED')[] = [];
  statusValue = { runId: null as string | null, status: 'NOT_STARTED', iteration: 0, claudePid: null as number | null, codexPid: null as number | null };
  recoverable = false;
  sessions: FakeSession[] = [];

  get starts(): ExecutionRequest[] {
    return this.calls.filter((c) => c.kind === 'start').map((c) => c.request!);
  }
  get resumes(): string[] {
    return this.calls.filter((c) => c.kind === 'resume').map((c) => c.executionId!);
  }

  #call(kind: 'start' | 'resume', request: ExecutionRequest | null, executionId: string | null, onEvent?: (e: BridgeEvent) => void, onHostSpawned?: (pid: number) => void): Promise<ExecutionPortResult> {
    const call: FakeCall = {
      kind,
      request,
      executionId,
      emit: (e) => onEvent?.({ timestamp: '2026-10-01T09:00:00.000Z', runId: '', iteration: 0, phase: 'RUN', ...e } as BridgeEvent),
      spawn: (pid) => onHostSpawned?.(pid),
    };
    const n = this.calls.push(call) - 1;
    return this.behave(call, n).then((summary) => ({
      summary,
      outcome: null,
      executionId: summary.kind === 'ENDED' || summary.kind === 'HOST_FAILED' ? summary.executionId : null,
      correlation: request?.correlation ?? request?.attemptId ?? null,
      observedCorrelation: null,
      hostFailure: summary.kind === 'HOST_FAILED' ? { kind: 'EXITED_WITHOUT_OUTCOME', message: 'fake' } : null,
      hostExit: null,
      hostPid: null,
      invalidMessages: 0,
      stopRequested: false,
    }));
  }

  start(request: ExecutionRequest, onEvent?: (e: BridgeEvent) => void, onHostSpawned?: (pid: number) => void) {
    return this.#call('start', request, null, onEvent, onHostSpawned);
  }
  resume(ref: { executionId: string }, onEvent?: (e: BridgeEvent) => void, onHostSpawned?: (pid: number) => void) {
    return this.#call('resume', null, ref.executionId, onEvent, onHostSpawned);
  }
  async pause() {
    this.pauseCalls += 1;
    return { kind: 'PAUSED' as const };
  }
  async stop() {
    this.stopCalls += 1;
    const kind = this.stopOutcomes.shift() ?? 'STOPPED';
    return kind === 'STOPPED' ? { kind, reason: 'FORCE_KILLED' as const, ok: true } : { kind };
  }
  async status() {
    const s = this.statusValue;
    return { runId: s.runId, status: s.status, iteration: s.iteration, currentPhase: null, claude: { pid: s.claudePid, sessionId: null }, codex: { pid: s.codexPid, threadId: null }, startedAt: null, updatedAt: null, lastReportPath: null, maxIterations: null, activity: { claude: 'IDLE' as const, codex: 'IDLE' as const } };
  }
  async checkRecovery() {
    return this.recoverable && this.statusValue.runId ? { kind: 'RECOVERABLE' as const, runId: this.statusValue.runId, iteration: 1, status: this.statusValue.status, strategy: 'CONTINUE_FROM_PROMPT' as const } : { kind: 'NONE' as const };
  }
  async artifacts(executionId: string) {
    const s = this.sessions.find((x) => x.runId === executionId);
    if (!s) return null;
    return {
      runId: s.runId,
      state: null,
      events: [{ timestamp: s.startedAt, runId: s.runId, iteration: 0, phase: 'RUN', event: 'RUN_STARTED' as const, ...(s.correlation !== null ? { correlation: s.correlation } : {}) }],
      iterations: s.report === undefined ? [] : [{ iteration: 1, report: { availability: 'AVAILABLE' as const, source: 'REPORT_FILE' as const, verification: 'VERIFIED' as const, path: 'r', text: s.report, bytes: 0, truncated: false, sha256: '' } }],
    } as never;
  }
  async findExecutions(filter: { startedAfter: string }) {
    return this.sessions
      .filter((s) => s.startedAt >= filter.startedAfter)
      .map((s) => ({ runId: s.runId, startedAt: s.startedAt, endedAt: null, status: s.status, iterations: s.iterations, errorCode: s.errorCode, recovered: false, isCurrent: s.runId === this.statusValue.runId, claudeSessionId: null, codexThreadId: null }));
  }
}

export const hang = never;
