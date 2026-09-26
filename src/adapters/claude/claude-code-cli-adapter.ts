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
    });

    const base = { exitCode: proc.exitCode, timedOut: proc.timedOut, stderr: proc.stderr, durationMs: proc.durationMs };
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
