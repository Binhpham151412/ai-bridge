import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeCodeCliAdapter } from '../../adapters/claude/claude-code-cli-adapter.ts';
import type { CodexCliAdapter } from '../../adapters/chatgpt/codex-cli-adapter.ts';
import { ReportValidator } from '../../reports/report-validator.ts';
import { CodexResponseParser } from '../../reports/codex-response-parser.ts';
import { buildReportContract, buildReviewerInput } from '../../prompts/templates.ts';
import { assertSafePermissionMode } from '../preflight/permission-mode.ts';
import { checkEnvForApiKeys } from '../cost-guard.ts';
import { readFile } from 'node:fs/promises';
import { sha256Text, verifyPromptIntegrity, verifyReportTransportIntegrity } from '../integrity/integrity.ts';
import { assertValidTransition, type BridgeState } from '../state-machine/transitions.ts';
import { AtomicJsonWriter } from '../state-manager/atomic-json-writer.ts';
import { redactSecrets } from '../security/redact.ts';
import type { EventType } from '../observability/events.ts';
import {
  buildDiagnostics,
  finalizeExecutionRecord,
  newExecutionRecord,
  persistCliOutput,
  tail,
  type ExecutionDiagnostics,
  type ExecutionRecord,
} from '../execution/execution-record.ts';

/** M4.1: one execution-lifecycle observation (prompt persisted/sent, CLI process
 * started/failed, session resumed) — the caller turns these into BridgeEvents. */
export interface ExecutionEvent {
  event: EventType;
  iteration: number;
  detail: string;
  /** Small, non-secret structured facts (pid, session id, sha256, bytes, exit code). */
  data: Record<string, string | number | boolean | null>;
}

export interface LogEntry {
  iteration: number;
  adapter: 'claude' | 'codex';
  command: string;
  exitCode: number | null;
  durationMs: number;
  reportPath: string | null;
  status: 'ok' | 'error';
  error: string | null;
}

/**
 * Named points where a caller can inject a self-crash (`onTrigger`, typically
 * `process.exit()` in production wiring) to test real crash recovery deterministically.
 * Inert unless `OrchestratorOptions.crashInjection` is set — never fires in normal use.
 */
export const CRASH_POINTS = [
  'AFTER_CLAUDE_STARTED',
  'AFTER_CLAUDE_COMPLETED',
  'AFTER_REPORT_VALIDATED',
  'AFTER_CODEX_STARTED',
  'AFTER_CODEX_COMPLETED',
  'AFTER_RESPONSE_PARSED',
  'AFTER_PROMPT_PERSISTED',
  'BEFORE_PROMPT_SENT',
] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export type OrchestratorState =
  | 'IDLE'
  | 'PREFLIGHT'
  | 'CLAUDE_EXECUTING'
  | 'REPORT_DETECTED'
  | 'REPORT_VALIDATED'
  | 'CODEX_REVIEWING'
  | 'CODEX_RESPONSE_RECEIVED'
  | 'RESPONSE_PARSED'
  | 'DONE'
  | 'NEED_HUMAN'
  | 'ERROR'
  | 'STOPPED'
  | 'STOPPED_MAX_ITERATIONS'
  | 'PAUSED';

export interface Transition {
  state: OrchestratorState;
  iteration: number;
  at: string;
}

export interface IterationRecord {
  iteration: number;
  promptPath: string;
  reportPath: string;
  reportSha256: string | null;
  codexInputPath: string;
  codexReviewPath: string;
  extractedPromptPath: string | null;
  status: 'ok' | 'error';
}

export type OrchestratorFinalStatus = 'DONE' | 'NEED_HUMAN' | 'ERROR' | 'STOPPED' | 'STOPPED_MAX_ITERATIONS' | 'PAUSED';

export interface OrchestratorResult {
  finalStatus: OrchestratorFinalStatus;
  iterations: IterationRecord[];
  transitions: Transition[];
  errorCode: string | null;
  errorMessage: string | null;
  claudeSessionId: string | null;
  codexThreadId: string | null;
  /** M4.1: redacted, capped context of the CLI call behind an ERROR (or behind the report/
   * response that failed validation) — null when no CLI call is involved. */
  diagnostics: ExecutionDiagnostics | null;
}

export interface OrchestratorOptions {
  projectName: string;
  projectPath: string;
  bridgeSessionId: string;
  sessionDir: string;
  reportsDir: string;
  initialPrompt: string;
  maxIterations: number;
  claudeTimeoutMs: number;
  codexTimeoutMs: number;
  claudeAdapter: ClaudeCodeCliAdapter;
  codexAdapter: CodexCliAdapter;
  reportValidator?: ReportValidator;
  responseParser?: CodexResponseParser;
  claudeEnv?: NodeJS.ProcessEnv;
  codexEnv?: NodeJS.ProcessEnv;
  /** e.g. "acceptEdits" — never "bypassPermissions" for M1. Defaults to "acceptEdits". */
  permissionMode?: string;
  /** Called once per Claude/Codex invocation — the CLI wires this to the JSONL audit log. */
  onLog?: (entry: LogEntry) => void | Promise<void>;
  /** Called the instant Claude/Codex is actually spawned — the CLI wires this to keep a live PID in state. */
  onPidUpdate?: (info: { adapter: 'claude' | 'codex'; pid: number }) => void;
  /** Called the instant claudeSessionId/codexThreadId become known — before the *other*
   * adapter is ever invoked — so a caller can persist them for crash recovery without
   * waiting for run() to return. */
  onSessionUpdate?: (info: { claudeSessionId?: string; codexThreadId?: string }) => void | Promise<void>;
  /** M4.1: execution lifecycle events. Never required for correctness — observation only. */
  onExecutionEvent?: (e: ExecutionEvent) => void | Promise<void>;
  /** Defense-in-depth cost guard target. Defaults to process.env — override only in tests. */
  env?: NodeJS.ProcessEnv;
  /** Called synchronously the instant each state is entered — lets the caller persist
   * state incrementally (crash recovery needs to know the phase reached, not just the
   * final result). `run()`'s returned `transitions` array is the same data, but only
   * available after the whole run finishes. */
  onTransition?: (t: Transition) => void | Promise<void>;
  /** Checked before each iteration starts (including before iteration 1). Returning
   * true stops the loop cooperatively (finalStatus STOPPED) without interrupting an
   * in-flight Claude/Codex call — that's `ai-bridge stop`'s job at the process level. */
  shouldStop?: () => boolean | Promise<boolean>;
  /** Same cooperative-boundary contract as shouldStop, but produces finalStatus PAUSED
   * instead of STOPPED — a distinct outcome `resume` treats the same way it treats a
   * crash (see docs/06-recovery-design.md). Checked after shouldStop at each boundary:
   * if both report true, STOPPED wins (stop is the more decisive request). */
  shouldPause?: () => boolean | Promise<boolean>;
  /** Resumes a crashed/interrupted run at a specific iteration instead of starting
   * fresh at 1 (P2 recovery — see docs/06-recovery-design.md for the two cases this
   * supports). `initialPrompt` is still used as the prompt for `startIteration` unless
   * `skipClaudeThisIteration` is set, in which case the report already on disk for
   * that iteration is reused and Claude is not re-invoked for it. */
  resumeState?: {
    startIteration: number;
    claudeSessionId: string | null;
    codexThreadId: string | null;
    skipClaudeThisIteration: boolean;
  };
  /** Test-only hook: self-crashes at a named point to prove recovery works against a
   * real interruption, not just a simulated one. `onTrigger` is called synchronously
   * once, exactly at that point, with no further orchestrator work done after it
   * returns for that step — production wiring passes `process.exit()`; tests record
   * the call instead. Never set in normal operation. */
  crashInjection?: { at: CrashPoint; onTrigger: () => void };
}

/**
 * Drives the M1 loop: Claude executes → writes a report → the report is validated →
 * sent verbatim to Codex → Codex's response is parsed → its PROMPT goes back to
 * Claude unmodified, resuming the same Claude session and Codex thread. Any failure
 * (bad report, bad response, non-zero exit, timeout) stops the loop immediately —
 * this orchestrator never retries and never repairs malformed output.
 */
export class Orchestrator {
  private readonly o: OrchestratorOptions;
  private readonly validator: ReportValidator;
  private readonly parser: CodexResponseParser;

  constructor(options: OrchestratorOptions) {
    assertSafePermissionMode(options.permissionMode ?? 'acceptEdits');
    this.o = options;
    this.validator = options.reportValidator ?? new ReportValidator();
    this.parser = options.responseParser ?? new CodexResponseParser();
  }

  async run(): Promise<OrchestratorResult> {
    const o = this.o;
    const transitions: Transition[] = [];
    const iterations: IterationRecord[] = [];
    // Awaited by every call site below: an async onTransition (e.g. persisting state to
    // disk) must fully complete before the orchestrator takes its next action — a crash
    // immediately after must never be able to lose a transition that already "happened"
    // logically. Found via a real crash-recovery test where a fire-and-forget write lost
    // a transition to a synchronous process.exit(); see docs/06-recovery-design.md.
    const push = async (state: OrchestratorState, iteration: number): Promise<void> => {
      // Safety net (M3 §9-10): should never actually fire, since every push() call
      // site below is already hand-verified against src/core/state-machine/transitions.ts's
      // table — but if a future edit to this loop ever produces an impossible sequence,
      // fail loudly here rather than silently persisting a nonsensical state.
      if (transitions.length > 0) {
        assertValidTransition(transitions[transitions.length - 1].state as BridgeState, state as BridgeState);
      }
      const t: Transition = { state, iteration, at: new Date().toISOString() };
      transitions.push(t);
      await o.onTransition?.(t);
    };
    const finish = (
      finalStatus: OrchestratorFinalStatus,
      errorCode: string | null,
      errorMessage: string | null,
      claudeSessionId: string | null,
      codexThreadId: string | null,
      diagnostics: ExecutionDiagnostics | null = null,
    ): OrchestratorResult => ({ finalStatus, iterations, transitions, errorCode, errorMessage, claudeSessionId, codexThreadId, diagnostics });

    /** Awaited emit — keeps lifecycle events in order where the loop can wait. */
    const emit = async (event: EventType, iteration: number, detail: string, data: ExecutionEvent['data'] = {}): Promise<void> => {
      try {
        await o.onExecutionEvent?.({ event, iteration, detail, data });
      } catch {
        // observation must never break the run
      }
    };
    /** Fire-and-forget emit for synchronous callbacks (spawn, stdin flushed). */
    const emitNow = (event: EventType, iteration: number, detail: string, data: ExecutionEvent['data'] = {}): void => {
      void emit(event, iteration, detail, data);
    };
    const short = (sha: string) => `${sha.slice(0, 12)}…`;

    await push('IDLE', 0);

    const envCheck = checkEnvForApiKeys(o.env ?? process.env);
    if (envCheck.blocked) {
      await push('ERROR', 0);
      return finish('ERROR', 'BLOCKED_API_AUTH', `Cost-risk env vars set: ${envCheck.foundKeys.join(', ')}`, null, null);
    }

    await push('PREFLIGHT', 0);

    let claudeSessionId: string | null = o.resumeState?.claudeSessionId ?? null;
    let codexThreadId: string | null = o.resumeState?.codexThreadId ?? null;
    let prompt = o.initialPrompt;
    const startIteration = o.resumeState?.startIteration ?? 1;

    let crashFired = false;
    /** Fires onTrigger (once, ever) if it targets `point`. Does not itself stop the run. */
    const maybeCrash = (point: CrashPoint): void => {
      if (crashFired || o.crashInjection?.at !== point) return;
      crashFired = true;
      o.crashInjection.onTrigger();
    };
    /** Same, but also produces an early-return result — production's onTrigger is
     * `process.exit()`, so in real use this line never actually executes; in tests
     * (where onTrigger just records the call), it lets the caller inspect the result. */
    const maybeCrashAndStop = (point: CrashPoint): OrchestratorResult | null => {
      if (crashFired || o.crashInjection?.at !== point) return null;
      crashFired = true;
      o.crashInjection.onTrigger();
      return finish('ERROR', `CRASH_INJECTED:${point}`, null, claudeSessionId, codexThreadId);
    };

    for (let iteration = startIteration; iteration <= o.maxIterations; iteration++) {
      if (o.shouldStop && (await o.shouldStop())) {
        await push('STOPPED', iteration - 1);
        return finish('STOPPED', null, null, claudeSessionId, codexThreadId);
      }
      if (o.shouldPause && (await o.shouldPause())) {
        await push('PAUSED', iteration - 1);
        return finish('PAUSED', null, null, claudeSessionId, codexThreadId);
      }
      if (iteration > startIteration) {
        const c = maybeCrashAndStop('BEFORE_PROMPT_SENT');
        if (c) return c;
      }

      const nnn = String(iteration).padStart(3, '0');
      const reportPath = path.join(o.reportsDir, `${nnn}-report.md`);
      const promptPath = path.join(o.sessionDir, `${nnn}-claude-prompt.md`);
      const codexInputPath = path.join(o.sessionDir, `${nnn}-chatgpt-input.md`);
      const codexReviewPath = path.join(o.sessionDir, `${nnn}-chatgpt-review.md`);
      const integrityChainPath = path.join(o.sessionDir, `${nnn}-integrity.json`);
      // Populated as each artifact becomes known this iteration, then persisted as one
      // immutable audit record right after the extracted prompt is written (M3.5 §12) —
      // an independently-inspectable trail, not a new verification mechanism (the
      // in-flight checks above/below already enforce these transitions are correct).
      let claudeInputHash: string | null = null;
      let codexResponseHashForChain: string | null = null;

      const record: IterationRecord = { iteration, promptPath, reportPath, reportSha256: null, codexInputPath, codexReviewPath, extractedPromptPath: null, status: 'error' };
      iterations.push(record);

      const skipClaude = iteration === startIteration && o.resumeState?.skipClaudeThisIteration === true;
      let claudeDiagnostics: ExecutionDiagnostics | null = null;

      if (!skipClaude) {
        const promptSha256 = sha256Text(prompt);
        claudeInputHash = promptSha256;
        await writeFile(promptPath, prompt, 'utf8');
        const writtenPrompt = await readFile(promptPath, 'utf8');
        const promptIntegrity = verifyPromptIntegrity(promptSha256, writtenPrompt);
        if (!promptIntegrity.ok) {
          await push('ERROR', iteration);
          return finish('ERROR', 'PROMPT_INTEGRITY_FAILURE', promptIntegrity.reason ?? null, claudeSessionId, codexThreadId);
        }

        const promptBytes = Buffer.byteLength(prompt, 'utf8');
        await emit('PROMPT_PERSISTED', iteration, `Claude prompt persisted — ${path.basename(promptPath)}, ${promptBytes} bytes, sha256 ${short(promptSha256)}`, {
          promptFile: path.basename(promptPath),
          promptSha256,
          promptBytes,
        });

        await push('CLAUDE_EXECUTING', iteration);
        const isResume = claudeSessionId !== null;
        const sessionIdForThisRun = claudeSessionId ?? randomUUID();
        const contract = buildReportContract({ reportPath, sessionId: o.bridgeSessionId, iteration });

        // M4.1 execution record: written before spawn, rewritten when the process ends.
        const claudeExecPath = path.join(o.sessionDir, `${nnn}-claude-execution.json`);
        const claudeStdoutPath = path.join(o.sessionDir, `${nnn}-claude-stdout.jsonl`);
        const claudeStderrPath = path.join(o.sessionDir, `${nnn}-claude-stderr.log`);
        const claudeExecWriter = new AtomicJsonWriter<ExecutionRecord>(claudeExecPath);
        let claudeExec = newExecutionRecord({
          agent: 'claude',
          iteration,
          bridgeSessionId: o.bridgeSessionId,
          mode: isResume ? 'RESUME' : 'NEW',
          requestedSessionId: sessionIdForThisRun,
          inputFile: promptPath,
          inputSha256: promptSha256,
          inputBytes: promptBytes,
        });
        await claudeExecWriter.write(claudeExec);

        const claudeResult = await o.claudeAdapter.run({
          cwd: o.projectPath,
          prompt,
          sessionId: sessionIdForThisRun,
          resume: isResume,
          timeoutMs: o.claudeTimeoutMs,
          env: o.claudeEnv,
          appendSystemPrompt: contract,
          permissionMode: o.permissionMode ?? 'acceptEdits',
          onSpawn: (pid) => {
            o.onPidUpdate?.({ adapter: 'claude', pid });
            claudeExec = { ...claudeExec, process: { ...claudeExec.process, pid, startedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
            void claudeExecWriter.write(claudeExec).catch(() => {});
            emitNow(
              'CLAUDE_PROCESS_STARTED',
              iteration,
              `Claude CLI process started — pid ${pid}, ${isResume ? `resuming Claude session ${sessionIdForThisRun}` : `new Claude session ${sessionIdForThisRun} (requested)`}`,
              { pid, claudeSessionId: sessionIdForThisRun, mode: isResume ? 'RESUME' : 'NEW' },
            );
            maybeCrash('AFTER_CLAUDE_STARTED');
          },
          onInputFlushed: (bytes) => {
            claudeExec = { ...claudeExec, input: { ...claudeExec.input, delivery: 'STDIN_FLUSHED_AND_CLOSED', deliveredAt: new Date().toISOString() } };
            void claudeExecWriter.write(claudeExec).catch(() => {});
            emitNow('PROMPT_SENT', iteration, `Prompt written to Claude CLI stdin and stdin closed — ${bytes} bytes, sha256 ${short(promptSha256)}`, {
              promptBytes: bytes,
              promptSha256,
              claudeSessionId: sessionIdForThisRun,
            });
          },
        });

        await persistCliOutput(claudeStdoutPath, claudeResult.stdout);
        await persistCliOutput(claudeStderrPath, claudeResult.stderr);
        claudeExec = finalizeExecutionRecord(
          claudeExec,
          {
            ok: claudeResult.ok,
            errorCode: claudeResult.errorCode,
            exitCode: claudeResult.exitCode,
            signal: claudeResult.signal,
            timedOut: claudeResult.timedOut,
            pid: claudeResult.pid,
            startedAt: claudeResult.startedAt,
            endedAt: claudeResult.endedAt,
            durationMs: claudeResult.durationMs,
            stdout: claudeResult.stdout,
            stderr: claudeResult.stderr,
            stdoutTruncated: claudeResult.stdoutTruncated,
            stderrTruncated: claudeResult.stderrTruncated,
            reportedSessionId: claudeResult.reportedSessionId,
            inputDelivered: claudeResult.promptDelivered,
            inputDeliveryError: claudeResult.promptDeliveryError,
            executable: claudeResult.executable,
            args: claudeResult.args,
          },
          { stdoutFile: claudeStdoutPath, stderrFile: claudeStderrPath },
        );
        await claudeExecWriter.write(claudeExec);
        claudeDiagnostics = buildDiagnostics(claudeExec, { stdout: claudeResult.stdout, stderr: claudeResult.stderr, finalMessage: claudeResult.finalMessage }, claudeExecPath);
        if (isResume) {
          const c = claudeExec.continuity;
          const verdictText =
            c.verdict === 'VERIFIED'
              ? 'continuity VERIFIED (the CLI reported the same session id)'
              : c.verdict === 'MISMATCH'
                ? `continuity MISMATCH (the CLI reported ${c.reported})`
                : 'continuity UNKNOWN (the CLI reported no session id)';
          await emit('CLAUDE_SESSION_RESUMED', iteration, `Claude CLI session ${sessionIdForThisRun} resumed — ${verdictText}`, {
            claudeSessionId: sessionIdForThisRun,
            reportedSessionId: c.reported,
            continuity: c.verdict,
          });
        }
        await o.onLog?.({
          iteration,
          adapter: 'claude',
          command: `claude -p --output-format stream-json ${isResume ? '--resume' : '--session-id'} ${sessionIdForThisRun}`,
          exitCode: claudeResult.exitCode,
          durationMs: claudeResult.durationMs,
          reportPath,
          status: claudeResult.ok ? 'ok' : 'error',
          error: claudeResult.ok ? null : claudeResult.errorCode,
        });
        if (!claudeResult.ok) {
          await emit(
            'CLAUDE_FAILED',
            iteration,
            `Claude CLI failed — ${claudeResult.errorCode}, exit code ${claudeResult.exitCode ?? 'none'}, after ${claudeResult.durationMs}ms`,
            { errorCode: claudeResult.errorCode, exitCode: claudeResult.exitCode, durationMs: claudeResult.durationMs, pid: claudeResult.pid },
          );
          await push('ERROR', iteration);
          return finish(
            'ERROR',
            `CLAUDE_RUN_FAILED:${claudeResult.errorCode}`,
            claudeResult.stderr ? redactSecrets(tail(claudeResult.stderr)) : null,
            claudeSessionId,
            codexThreadId,
            claudeDiagnostics,
          );
        }
        claudeSessionId = claudeResult.sessionId;
        if (claudeSessionId) await o.onSessionUpdate?.({ claudeSessionId });
        {
          const c = maybeCrashAndStop('AFTER_CLAUDE_COMPLETED');
          if (c) return c;
        }
      }

      await push('REPORT_DETECTED', iteration);
      const reportResult = await this.validator.validateFile(reportPath, { sessionId: o.bridgeSessionId, iteration });
      if (!reportResult.valid) {
        await push('ERROR', iteration);
        const detail = reportResult.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
        return finish('ERROR', 'REPORT_INVALID', detail, claudeSessionId, codexThreadId, claudeDiagnostics);
      }
      record.reportSha256 = reportResult.sha256;
      await push('REPORT_VALIDATED', iteration);
      {
        const c = maybeCrashAndStop('AFTER_REPORT_VALIDATED');
        if (c) return c;
      }

      const codexInput = buildReviewerInput({ projectName: o.projectName, sessionId: o.bridgeSessionId, iteration, reportText: reportResult.text ?? '' });
      const transportIntegrity = verifyReportTransportIntegrity(reportResult.sha256 ?? '', reportResult.text ?? '', codexInput);
      if (!transportIntegrity.ok) {
        await push('ERROR', iteration);
        return finish('ERROR', 'REPORT_TRANSPORT_INTEGRITY_FAILURE', transportIntegrity.reason ?? null, claudeSessionId, codexThreadId);
      }
      await writeFile(codexInputPath, codexInput, 'utf8');

      await push('CODEX_REVIEWING', iteration);
      const codexExecPath = path.join(o.sessionDir, `${nnn}-codex-execution.json`);
      const codexStdoutPath = path.join(o.sessionDir, `${nnn}-codex-stdout.jsonl`);
      const codexStderrPath = path.join(o.sessionDir, `${nnn}-codex-stderr.log`);
      const codexExecWriter = new AtomicJsonWriter<ExecutionRecord>(codexExecPath);
      let codexExec = newExecutionRecord({
        agent: 'codex',
        iteration,
        bridgeSessionId: o.bridgeSessionId,
        mode: codexThreadId === null ? 'NEW' : 'RESUME',
        requestedSessionId: codexThreadId,
        inputFile: codexInputPath,
        inputSha256: sha256Text(codexInput),
        inputBytes: Buffer.byteLength(codexInput, 'utf8'),
      });
      await codexExecWriter.write(codexExec);
      const codexResult = await o.codexAdapter.run({
        cwd: o.projectPath,
        input: codexInput,
        threadId: codexThreadId,
        outputPath: codexReviewPath,
        timeoutMs: o.codexTimeoutMs,
        env: o.codexEnv,
        onSpawn: (pid) => {
          o.onPidUpdate?.({ adapter: 'codex', pid });
          codexExec = { ...codexExec, process: { ...codexExec.process, pid, startedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() };
          void codexExecWriter.write(codexExec).catch(() => {});
          emitNow('CODEX_PROCESS_STARTED', iteration, `Codex CLI process started — pid ${pid}, ${codexThreadId === null ? 'new thread' : `resuming thread ${codexThreadId}`}`, {
            pid,
            codexThreadId,
            mode: codexThreadId === null ? 'NEW' : 'RESUME',
          });
          maybeCrash('AFTER_CODEX_STARTED');
        },
        onInputFlushed: () => {
          codexExec = { ...codexExec, input: { ...codexExec.input, delivery: 'STDIN_FLUSHED_AND_CLOSED', deliveredAt: new Date().toISOString() } };
          void codexExecWriter.write(codexExec).catch(() => {});
        },
      });
      await persistCliOutput(codexStdoutPath, codexResult.stdout);
      await persistCliOutput(codexStderrPath, codexResult.stderr);
      codexExec = finalizeExecutionRecord(
        codexExec,
        {
          ok: codexResult.ok,
          errorCode: codexResult.errorCode,
          exitCode: codexResult.exitCode,
          signal: codexResult.signal,
          timedOut: codexResult.timedOut,
          pid: codexResult.pid,
          startedAt: codexResult.startedAt,
          endedAt: codexResult.endedAt,
          durationMs: codexResult.durationMs,
          stdout: codexResult.stdout,
          stderr: codexResult.stderr,
          stdoutTruncated: codexResult.stdoutTruncated,
          stderrTruncated: codexResult.stderrTruncated,
          reportedSessionId: codexResult.reportedThreadId,
          inputDelivered: codexResult.inputDelivered,
          inputDeliveryError: codexResult.inputDeliveryError,
          executable: codexResult.executable,
          args: codexResult.args,
        },
        { stdoutFile: codexStdoutPath, stderrFile: codexStderrPath },
      );
      await codexExecWriter.write(codexExec);
      const codexDiagnostics = buildDiagnostics(codexExec, { stdout: codexResult.stdout, stderr: codexResult.stderr, finalMessage: null }, codexExecPath);
      await o.onLog?.({
        iteration,
        adapter: 'codex',
        command: codexThreadId === null ? 'codex exec --json -s read-only ...' : `codex exec resume ${codexThreadId} --json ...`,
        exitCode: codexResult.exitCode,
        durationMs: codexResult.durationMs,
        reportPath: codexReviewPath,
        status: codexResult.ok ? 'ok' : 'error',
        error: codexResult.ok ? null : codexResult.errorCode,
      });
      if (!codexResult.ok) {
        await emit(
          'CODEX_FAILED',
          iteration,
          `Codex CLI failed — ${codexResult.errorCode}, exit code ${codexResult.exitCode ?? 'none'}, after ${codexResult.durationMs}ms`,
          { errorCode: codexResult.errorCode, exitCode: codexResult.exitCode, durationMs: codexResult.durationMs, pid: codexResult.pid },
        );
        await push('ERROR', iteration);
        return finish(
          'ERROR',
          `CODEX_RUN_FAILED:${codexResult.errorCode}`,
          codexResult.stderr ? redactSecrets(tail(codexResult.stderr)) : null,
          claudeSessionId,
          codexThreadId,
          codexDiagnostics,
        );
      }
      codexThreadId = codexResult.threadId;
      codexResponseHashForChain = sha256Text(codexResult.responseText ?? '');
      if (codexThreadId) await o.onSessionUpdate?.({ codexThreadId });
      await push('CODEX_RESPONSE_RECEIVED', iteration);
      {
        const c = maybeCrashAndStop('AFTER_CODEX_COMPLETED');
        if (c) return c;
      }

      const parsed = this.parser.parse(codexResult.responseText ?? '');
      await push('RESPONSE_PARSED', iteration);
      if (!parsed.valid) {
        await push('ERROR', iteration);
        const detail = parsed.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
        return finish('ERROR', 'RESPONSE_INVALID', detail, claudeSessionId, codexThreadId);
      }
      {
        const c = maybeCrashAndStop('AFTER_RESPONSE_PARSED');
        if (c) return c;
      }

      const extractedPromptPath = path.join(o.sessionDir, `${nnn}-extracted-prompt.md`);
      await writeFile(extractedPromptPath, parsed.prompt ?? '', 'utf8');
      record.extractedPromptPath = extractedPromptPath;
      record.status = 'ok';

      await writeFile(
        integrityChainPath,
        JSON.stringify(
          {
            iteration,
            claudeInputHash,
            reportHash: record.reportSha256,
            codexInputHash: sha256Text(codexInput),
            codexResponseHash: codexResponseHashForChain,
            promptHash: sha256Text(parsed.prompt ?? ''),
          },
          null,
          2,
        ),
        'utf8',
      );

      // DONE/NEED_HUMAN are checked BEFORE the AFTER_PROMPT_PERSISTED crash point,
      // deliberately: that point exists to test "crashed after persisting the next
      // prompt but before the next Claude call" — a case that only exists for CONTINUE.
      // Found via a real M3.5 integration test: crashing here for a real DONE verdict
      // and then resuming fed Claude the closing remark as if it were a work
      // instruction, producing REPORT_INVALID — not a recovery-mechanism bug (the
      // session/prompt hand-off itself was byte-for-byte correct), but a real gap in
      // when this crash point could fire.
      if (parsed.status === 'DONE') {
        await push('DONE', iteration);
        return finish('DONE', null, null, claudeSessionId, codexThreadId);
      }
      if (parsed.status === 'NEED_HUMAN') {
        await push('NEED_HUMAN', iteration);
        return finish('NEED_HUMAN', null, null, claudeSessionId, codexThreadId);
      }
      {
        const c = maybeCrashAndStop('AFTER_PROMPT_PERSISTED');
        if (c) return c;
      }
      prompt = parsed.prompt ?? '';
    }

    await push('STOPPED_MAX_ITERATIONS', o.maxIterations);
    return finish('STOPPED_MAX_ITERATIONS', null, null, claudeSessionId, codexThreadId);
  }
}
