import { runProcess } from '../../automation/process-runner.ts';
import { prependReportContract, type ExecutorAdapter, type ExecutorRunErrorCode, type ExecutorRunOptions, type ExecutorRunResult } from '../../core/executor/executor-adapter.ts';
import type { PermissionPolicy, ProviderPermissionCapability } from '../../core/permissions/permission-policy.ts';

/**
 * docs/64 — how the provider-neutral permission policy maps onto the OpenCode CLI. Checked
 * against `opencode run --help` of 1.14.30 (no task was run for this mapping):
 * - bypass → `--dangerously-skip-permissions` ("auto-approve permissions that are not
 *   explicitly denied").
 * - ask → no flag: OpenCode's own permission configuration applies. A headless run cannot
 *   show a prompt, so anything that would need an approval is not approved.
 */
export const OPENCODE_PERMISSION_CAPABILITY: ProviderPermissionCapability = {
  provider: 'opencode',
  displayName: 'OpenCode',
  verifiedAgainst: 'OpenCode 1.14.30 (`opencode run --help`)',
  modes: [
    {
      policy: 'ask',
      label: 'Ask before privileged actions',
      description: "OpenCode's own permission configuration applies. An AI Bridge run is headless and cannot show a prompt, so anything that needs approval is not approved.",
      cliMechanism: '(no permission flag)',
    },
    {
      policy: 'bypass',
      label: 'Bypass permission prompts',
      description: 'OpenCode auto-approves every permission request that is not explicitly denied in its configuration.',
      cliMechanism: '--dangerously-skip-permissions',
    },
  ],
};

/** The argv for a policy. Throws for anything the capability does not declare (fail closed). */
export function opencodePermissionArgs(policy: PermissionPolicy): string[] {
  if (policy === 'bypass') return ['--dangerously-skip-permissions'];
  if (policy === 'ask') return [];
  throw new Error(`Unsupported OpenCode permission policy: ${JSON.stringify(policy)}`);
}

export interface OpenCodeCliAdapterOptions {
  executable: string;
  /** Prepended to argv before the real flags — used in tests to run `node <fake-cli.mjs>` instead of the real binary. */
  commandArgsPrefix?: string[];
}

/** One line of `opencode run --format json`. Every event carries `sessionID`; `text` events carry
 * `part.text`; failures arrive as `{"type":"error","error":{"name","data":{"message"}}}`. */
interface OpenCodeEvent {
  type?: unknown;
  sessionID?: unknown;
  part?: { text?: unknown };
  error?: { name?: unknown; message?: unknown; data?: { message?: unknown } };
}

/** Parses every JSON line; ignores lines that are not JSON (the CLI may print plain notices). */
function parseEvents(stdout: string): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t) as unknown;
      if (typeof e === 'object' && e !== null && !Array.isArray(e)) events.push(e as OpenCodeEvent);
    } catch {
      // partial/garbled line
    }
  }
  return events;
}

/** An id is later passed back as `--session <id>`, so it must look like an id and never like a flag. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The first session id the CLI reported in any event; null when it reported none (or none that is
 * safe to pass back). Never invented. */
export function findReportedOpenCodeSessionId(stdout: string): string | null {
  for (const e of parseEvents(stdout)) {
    if (typeof e.sessionID === 'string' && SESSION_ID_PATTERN.test(e.sessionID)) return e.sessionID;
  }
  return null;
}

/** The first `error` event's message (name + message), or null when the stream reported no error. */
export function findOpenCodeError(stdout: string): string | null {
  for (const e of parseEvents(stdout)) {
    if (e.type !== 'error') continue;
    const name = typeof e.error?.name === 'string' ? e.error.name : 'Error';
    const msg = e.error?.data?.message ?? e.error?.message;
    return typeof msg === 'string' && msg !== '' ? `${name}: ${msg}` : name;
  }
  return null;
}

/** The text the model wrote after its last `step_start`; null when it wrote none. */
export function findOpenCodeFinalMessage(stdout: string): string | null {
  let parts: string[] = [];
  for (const e of parseEvents(stdout)) {
    if (e.type === 'step_start') parts = [];
    else if (e.type === 'text' && typeof e.part?.text === 'string') parts.push(e.part.text);
  }
  const text = parts.join('').trim();
  return text === '' ? null : text;
}

/** OpenCode has no flag for a separate system prompt, so the report contract travels with the prompt. */
export const buildOpenCodeInput = prependReportContract;

/**
 * Drives `opencode run --format json` as the executor: the prompt (with the report contract in
 * front of it) goes in over stdin, the session id is created by the CLI and tracked explicitly
 * (never inferred), and every ambiguity — an `error` event under exit code 0, no session id, a
 * different session than the one resumed, a timeout — is surfaced as a distinct errorCode.
 *
 * Checked on this machine (opencode 1.14.30): exit code 0 even when the run failed (the error is
 * only in the event stream); piped stdin is read as the message; an empty message is refused.
 */
export class OpenCodeCliAdapter implements ExecutorAdapter {
  readonly provider = 'opencode' as const;
  readonly sessionIdAssignment = 'cli' as const;
  readonly promptChannel = 'stdin' as const;
  readonly permissionCapability = OPENCODE_PERMISSION_CAPABILITY;
  private readonly executable: string;
  private readonly commandArgsPrefix: string[];

  constructor(options: OpenCodeCliAdapterOptions) {
    this.executable = options.executable;
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
  }

  permissionArgs(policy: PermissionPolicy): string[] {
    return opencodePermissionArgs(policy);
  }

  /** OpenCode's event stream names no model; it is never guessed from what was requested. */
  findReportedModel(): string | null {
    return null;
  }

  commandLabel(sessionId: string | null, resume: boolean): string {
    return `opencode run --format json${resume && sessionId ? ` --session ${sessionId}` : ''}`;
  }

  async run(options: ExecutorRunOptions): Promise<ExecutorRunResult> {
    if (options.resume && options.sessionId === null) throw new Error('OpenCodeCliAdapter cannot resume without a session id');
    const args = [...this.commandArgsPrefix, 'run', '--format', 'json'];
    if (options.resume && options.sessionId !== null) args.push('--session', options.sessionId);
    if (options.permissionPolicy !== undefined) args.push(...opencodePermissionArgs(options.permissionPolicy));
    if (options.model !== undefined) args.push('--model', options.model);

    const input = buildOpenCodeInput(options.prompt, options.appendSystemPrompt);
    const proc = await runProcess({
      command: this.executable,
      args,
      cwd: options.cwd,
      env: options.env,
      input,
      timeoutMs: options.timeoutMs,
      onSpawn: options.onSpawn,
      onInputFlushed: options.onInputFlushed,
    });

    const reportedSessionId = findReportedOpenCodeSessionId(proc.stdout);
    const cliError = findOpenCodeError(proc.stdout);
    const base = {
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      stderr: proc.stderr,
      durationMs: proc.durationMs,
      stdout: proc.stdout,
      stdoutTruncated: proc.stdoutTruncated,
      stderrTruncated: proc.stderrTruncated,
      reportedSessionId,
      pid: proc.pid,
      signal: proc.signal,
      startedAt: proc.startedAt,
      endedAt: proc.endedAt,
      promptBytes: proc.inputBytes,
      promptDelivered: proc.inputDelivered,
      promptDeliveryError: proc.inputError,
      finalMessage: cliError ?? findOpenCodeFinalMessage(proc.stdout),
      executable: this.executable,
      args,
    };
    const fail = (errorCode: ExecutorRunErrorCode, sessionId: string | null = null): ExecutorRunResult => ({
      ok: false,
      sessionId,
      errorCode,
      receivedPrompt: null,
      receivedSystemPrompt: null,
      receivedPermissionMode: null,
      receivedAllowedTools: null,
      receivedDisallowedTools: null,
      ...base,
    });

    if (proc.timedOut) return fail('TIMEOUT');
    if (proc.exitCode === null && proc.signal === null) return fail('SPAWN_FAILED');
    if (proc.exitCode !== 0) return fail('NON_ZERO_EXIT');
    if (parseEvents(proc.stdout).length === 0) return fail('BAD_JSON');
    if (cliError !== null) return fail('CLI_REPORTED_ERROR', reportedSessionId);
    if (reportedSessionId === null) return fail('NO_SESSION_ID');
    if (options.resume && reportedSessionId !== options.sessionId) return fail('SESSION_MISMATCH', reportedSessionId);

    return {
      ok: true,
      sessionId: reportedSessionId,
      errorCode: null,
      receivedPrompt: null,
      receivedSystemPrompt: null,
      receivedPermissionMode: null,
      receivedAllowedTools: null,
      receivedDisallowedTools: null,
      ...base,
    };
  }
}
