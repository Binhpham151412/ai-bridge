import { runProcess } from '../../automation/process-runner.ts';

export interface ClaudeCodeCliAdapterOptions {
  executable: string;
  /** Prepended to argv before the real flags — used in tests to run `node <fake-cli.mjs>` instead of the real binary. */
  commandArgsPrefix?: string[];
}

export interface ClaudeRunOptions {
  cwd: string;
  prompt: string;
  sessionId: string;
  resume: boolean;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Sent via --append-system-prompt (a channel separate from stdin) — e.g. the report-file contract. */
  appendSystemPrompt?: string;
  /** e.g. "acceptEdits" — required for headless (-p) runs to actually write files; never "bypassPermissions" for M1. */
  permissionMode?: string;
  /** Sent as --allowedTools <a> <b> ... */
  allowedTools?: string[];
  /** Sent as --disallowedTools <a> <b> ... */
  disallowedTools?: string[];
  onSpawn?: (pid: number) => void;
  /** The prompt was fully written to the CLI's stdin and stdin closed (see runProcess). */
  onInputFlushed?: (bytes: number) => void;
}

export type ClaudeRunErrorCode = 'SPAWN_FAILED' | 'TIMEOUT' | 'NON_ZERO_EXIT' | 'BAD_JSON' | 'NO_RESULT_EVENT' | 'SESSION_MISMATCH';

export interface ClaudeRunResult {
  ok: boolean;
  sessionId: string | null;
  exitCode: number | null;
  timedOut: boolean;
  errorCode: ClaudeRunErrorCode | null;
  receivedPrompt: string | null;
  receivedSystemPrompt: string | null;
  receivedPermissionMode: string | null;
  receivedAllowedTools: string[] | null;
  receivedDisallowedTools: string[] | null;
  stderr: string;
  durationMs: number;
  /** Raw stream-json stdout (bounded by runProcess's maxBufferBytes) — the CLI's own
   * event output, persisted by the orchestrator as "CLI output". Not a transcript. */
  stdout: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** The session id the CLI itself reported in any stream event (init or result), even
   * when the run failed — null when the CLI never reported one. Never invented. */
  reportedSessionId: string | null;
  pid: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  promptBytes: number;
  /** Prompt bytes flushed to the CLI's stdin and stdin closed without error. */
  promptDelivered: boolean;
  promptDeliveryError: string | null;
  /** The CLI's final `result` message text, when it emitted one (success or not). */
  finalMessage: string | null;
  executable: string;
  args: string[];
}

/** Tolerant scan (never throws, skips non-JSON lines) for the session id the CLI
 * reported — prefers the final `result` event, falls back to `system/init`. */
export function findReportedClaudeSessionId(stdout: string): string | null {
  let initId: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as StreamEvent;
      if (typeof e.session_id !== 'string') continue;
      if (e.type === 'result') return e.session_id;
      initId ??= e.session_id;
    } catch {
      // partial/garbled line — ignored here; the strict parse below reports BAD_JSON
    }
  }
  return initId;
}

/** The `result` event's text — Claude's final message for this call — or null. */
export function findClaudeFinalMessage(stdout: string): string | null {
  for (const line of stdout.split('\n').reverse()) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as { type?: unknown; result?: unknown };
      if (e.type === 'result') return typeof e.result === 'string' ? e.result : null;
    } catch {
      // skip
    }
  }
  return null;
}

interface StreamEvent {
  type?: unknown;
  session_id?: unknown;
  text?: unknown;
  tools?: unknown;
}

/**
 * Drives `claude -p --output-format stream-json` as the M1 executor: prompt goes in
 * over stdin verbatim, session id is tracked explicitly (never inferred), and every
 * ambiguity — bad JSON, a missing/mismatched session id, a non-zero exit, a timeout —
 * is surfaced as a distinct errorCode instead of being guessed at or retried.
 */
export class ClaudeCodeCliAdapter {
  private readonly executable: string;
  private readonly commandArgsPrefix: string[];

  constructor(options: ClaudeCodeCliAdapterOptions) {
    this.executable = options.executable;
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
  }

  async run(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
    const sessionFlag = options.resume ? '--resume' : '--session-id';
    const args = [...this.commandArgsPrefix, '-p', '--output-format', 'stream-json', '--verbose', sessionFlag, options.sessionId];
    if (options.appendSystemPrompt !== undefined) args.push('--append-system-prompt', options.appendSystemPrompt);
    if (options.permissionMode !== undefined) args.push('--permission-mode', options.permissionMode);
    if (options.allowedTools !== undefined) args.push('--allowedTools', ...options.allowedTools);
    if (options.disallowedTools !== undefined) args.push('--disallowedTools', ...options.disallowedTools);

    const proc = await runProcess({
      command: this.executable,
      args,
      cwd: options.cwd,
      env: options.env,
      input: options.prompt,
      timeoutMs: options.timeoutMs,
      onSpawn: options.onSpawn,
      onInputFlushed: options.onInputFlushed,
    });

    const base = {
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      stderr: proc.stderr,
      durationMs: proc.durationMs,
      stdout: proc.stdout,
      stdoutTruncated: proc.stdoutTruncated,
      stderrTruncated: proc.stderrTruncated,
      reportedSessionId: findReportedClaudeSessionId(proc.stdout),
      pid: proc.pid,
      signal: proc.signal,
      startedAt: proc.startedAt,
      endedAt: proc.endedAt,
      promptBytes: proc.inputBytes,
      promptDelivered: proc.inputDelivered,
      promptDeliveryError: proc.inputError,
      finalMessage: findClaudeFinalMessage(proc.stdout),
      executable: this.executable,
      args,
    };
    const fail = (errorCode: ClaudeRunErrorCode, sessionId: string | null = null, receivedPrompt: string | null = null): ClaudeRunResult =>
      ({
        ok: false,
        sessionId,
        errorCode,
        receivedPrompt,
        receivedSystemPrompt: null,
        receivedPermissionMode: null,
        receivedAllowedTools: null,
        receivedDisallowedTools: null,
        ...base,
      });

    if (proc.timedOut) return fail('TIMEOUT');
    if (proc.exitCode === null && proc.signal === null) return fail('SPAWN_FAILED');
    if (proc.exitCode !== 0) return fail('NON_ZERO_EXIT');

    const lines = proc.stdout.split('\n').filter((l) => l.trim() !== '');
    const events: StreamEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as StreamEvent);
      } catch {
        return fail('BAD_JSON');
      }
    }

    const resultEvent = events.find((e) => e.type === 'result');
    if (!resultEvent) return fail('NO_RESULT_EVENT');

    const reportedSessionId = typeof resultEvent.session_id === 'string' ? resultEvent.session_id : null;
    const stdinEvent = events.find((e) => e.type === 'debug_stdin');
    const receivedPrompt = typeof stdinEvent?.text === 'string' ? stdinEvent.text : null;
    const systemPromptEvent = events.find((e) => e.type === 'debug_system_prompt');
    const receivedSystemPrompt = typeof systemPromptEvent?.text === 'string' ? systemPromptEvent.text : null;
    const permissionModeEvent = events.find((e) => e.type === 'debug_permission_mode');
    const receivedPermissionMode = typeof permissionModeEvent?.text === 'string' ? permissionModeEvent.text : null;
    const allowedToolsEvent = events.find((e) => e.type === 'debug_allowed_tools');
    const receivedAllowedTools = Array.isArray(allowedToolsEvent?.tools) ? (allowedToolsEvent.tools as string[]) : null;
    const disallowedToolsEvent = events.find((e) => e.type === 'debug_disallowed_tools');
    const receivedDisallowedTools = Array.isArray(disallowedToolsEvent?.tools) ? (disallowedToolsEvent.tools as string[]) : null;

    if (reportedSessionId !== options.sessionId) return fail('SESSION_MISMATCH', reportedSessionId, receivedPrompt);

    return {
      ok: true,
      sessionId: reportedSessionId,
      errorCode: null,
      receivedPrompt,
      receivedSystemPrompt,
      receivedPermissionMode,
      receivedAllowedTools,
      receivedDisallowedTools,
      ...base,
    };
  }
}
