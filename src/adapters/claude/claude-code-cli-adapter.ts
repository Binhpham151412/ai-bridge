import { runProcess } from '../../automation/process-runner.ts';
import type { ExecutorAdapter, ExecutorRunErrorCode, ExecutorRunOptions, ExecutorRunResult } from '../../core/executor/executor-adapter.ts';
import type { PermissionPolicy, ProviderPermissionCapability } from '../../core/permissions/permission-policy.ts';

/**
 * M5.10.1 — how the provider-neutral permission policy maps onto the installed Claude Code
 * CLI. Verified against `claude --help` of 2.1.161 (no task was run): `--permission-mode`
 * accepts acceptEdits | auto | bypassPermissions | default | dontAsk | plan.
 * - bypass → `--permission-mode bypassPermissions` (the CLI's own bypass mode).
 * - ask → `--permission-mode acceptEdits` — the behaviour every run had before M5.10.1:
 *   edits are accepted (a headless run must be able to write its report), anything else
 *   that needs approval is refused by the CLI because a headless run cannot prompt.
 */
export const CLAUDE_PERMISSION_CAPABILITY: ProviderPermissionCapability = {
  provider: 'claude',
  displayName: 'Claude Code',
  verifiedAgainst: 'Claude Code 2.1.161 (`claude --help`)',
  modes: [
    {
      policy: 'ask',
      label: 'Ask before privileged actions',
      description:
        'Normal Claude Code permission checks. File edits are accepted; anything else that needs approval (e.g. starting a dev server, browser tools) is refused, because an AI Bridge run is headless and cannot show a prompt.',
      cliMechanism: '--permission-mode acceptEdits',
    },
    {
      policy: 'bypass',
      label: 'Bypass permission prompts',
      description: 'Claude Code skips its permission checks and runs the operations it supports without asking.',
      cliMechanism: '--permission-mode bypassPermissions',
    },
  ],
};

/** The argv for a policy. Throws for anything the capability does not declare (fail closed). */
export function claudePermissionArgs(policy: PermissionPolicy): string[] {
  if (policy === 'bypass') return ['--permission-mode', 'bypassPermissions'];
  if (policy === 'ask') return ['--permission-mode', 'acceptEdits'];
  throw new Error(`Unsupported Claude permission policy: ${JSON.stringify(policy)}`);
}

export interface ClaudeCodeCliAdapterOptions {
  executable: string;
  /** Prepended to argv before the real flags — used in tests to run `node <fake-cli.mjs>` instead of the real binary. */
  commandArgsPrefix?: string[];
}

/** The shared executor contract (docs/64); the Claude names are kept for existing callers. */
export type ClaudeRunOptions = ExecutorRunOptions;
export type ClaudeRunErrorCode = ExecutorRunErrorCode;
export type ClaudeRunResult = ExecutorRunResult;

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

/** docs/62: the model the CLI says it used — the `system/init` event's `model`, else the first
 * real assistant message's `message.model` (never the `<synthetic>` placeholder). Null when the
 * CLI reported none; never inferred from what was requested. */
export function findReportedClaudeModel(stdout: string): string | null {
  let fromMessage: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as { type?: unknown; subtype?: unknown; model?: unknown; message?: { model?: unknown } };
      if (e.type === 'system' && e.subtype === 'init' && typeof e.model === 'string' && e.model !== '') return e.model;
      const m = e.type === 'assistant' ? e.message?.model : undefined;
      if (fromMessage === null && typeof m === 'string' && m !== '' && m !== '<synthetic>') fromMessage = m;
    } catch {
      // partial/garbled line
    }
  }
  return fromMessage;
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
export class ClaudeCodeCliAdapter implements ExecutorAdapter {
  readonly provider = 'claude-code' as const;
  readonly sessionIdAssignment = 'caller' as const;
  readonly permissionCapability = CLAUDE_PERMISSION_CAPABILITY;
  private readonly executable: string;
  private readonly commandArgsPrefix: string[];

  constructor(options: ClaudeCodeCliAdapterOptions) {
    this.executable = options.executable;
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
  }

  permissionArgs(policy: PermissionPolicy): string[] {
    return claudePermissionArgs(policy);
  }

  findReportedModel(stdout: string): string | null {
    return findReportedClaudeModel(stdout);
  }

  commandLabel(sessionId: string | null, resume: boolean): string {
    return `claude -p --output-format stream-json ${resume ? '--resume' : '--session-id'} ${sessionId ?? ''}`.trimEnd();
  }

  async run(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
    // Claude takes the session id from the caller; a null id would have no `--session-id` to send.
    if (options.sessionId === null) throw new Error('ClaudeCodeCliAdapter needs a caller-assigned sessionId');
    const sessionId = options.sessionId;
    const sessionFlag = options.resume ? '--resume' : '--session-id';
    const args = [...this.commandArgsPrefix, '-p', '--output-format', 'stream-json', '--verbose', sessionFlag, sessionId];
    if (options.appendSystemPrompt !== undefined) args.push('--append-system-prompt', options.appendSystemPrompt);
    if (options.permissionPolicy !== undefined) args.push(...claudePermissionArgs(options.permissionPolicy));
    if (options.model !== undefined) args.push('--model', options.model);
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

    if (reportedSessionId !== sessionId) return fail('SESSION_MISMATCH', reportedSessionId, receivedPrompt);

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
