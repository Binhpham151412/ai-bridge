import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../../automation/process-runner.ts';
import { prependReportContract, type ExecutorAdapter, type ExecutorRunErrorCode, type ExecutorRunOptions, type ExecutorRunResult } from '../../core/executor/executor-adapter.ts';
import type { PermissionPolicy, ProviderPermissionCapability } from '../../core/permissions/permission-policy.ts';

/**
 * docs/65 — how the provider-neutral permission policy maps onto the Antigravity CLI (`agy`).
 * Read from `agy --help` (1.0.x and 1.3.4; no task was run for this mapping):
 * - bypass → `--dangerously-skip-permissions` ("Auto-approve all tool permission requests").
 * - ask → no flag: agy's own setting applies (its log shows `toolPermission=request-review`). A headless
 *   `--print` run cannot show a prompt; what agy then does with a request was not verified.
 */
export const ANTIGRAVITY_PERMISSION_CAPABILITY: ProviderPermissionCapability = {
  provider: 'antigravity',
  displayName: 'Antigravity',
  verifiedAgainst: 'Antigravity CLI 1.3.4 (`agy --help`)',
  modes: [
    {
      policy: 'ask',
      label: 'Ask before privileged actions',
      description: "Antigravity's own permission setting applies (request-review). An AI Bridge run is headless and cannot show a prompt, so a request that needs approval is not approved.",
      cliMechanism: '(no permission flag)',
    },
    {
      policy: 'bypass',
      label: 'Bypass permission prompts',
      description: 'Antigravity auto-approves every tool permission request without prompting.',
      cliMechanism: '--dangerously-skip-permissions',
    },
  ],
};

/** The argv for a policy. Throws for anything the capability does not declare (fail closed). */
export function antigravityPermissionArgs(policy: PermissionPolicy): string[] {
  if (policy === 'bypass') return ['--dangerously-skip-permissions'];
  if (policy === 'ask') return [];
  throw new Error(`Unsupported Antigravity permission policy: ${JSON.stringify(policy)}`);
}

export interface AntigravityCliAdapterOptions {
  executable: string;
  /** Prepended to argv before the real flags — used in tests to run `node <fake-cli.mjs>` instead of the real binary. */
  commandArgsPrefix?: string[];
}

/**
 * Windows allows ~32 767 characters for a whole command line, and the prompt travels on it (agy
 * ignores stdin). Quotes and backslashes are escaped when the line is built, so they count double.
 * Over this, nothing is spawned: a truncated prompt would be worse than a clear error.
 */
export const MAX_ARGV_PROMPT_CHARS = 28_000;

export function argvCostOf(text: string): number {
  let extra = 0;
  for (const ch of text) if (ch === '"' || ch === '\\') extra++;
  return text.length + extra;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** What agy's own log (`--log-file`) says about the conversation — agy prints neither the id nor the
 * model on stdout. `created` = "Created conversation <id>" (a NEW conversation was made, even if a
 * resume was asked for: agy ignores an unknown `--conversation` and starts afresh, exit code 0);
 * `started` = the conversationID it began the print run with (non-empty only for a real resume). */
export interface AgyLogFacts {
  created: string | null;
  started: string | null;
  model: string | null;
}

export function parseAgyLog(log: string): AgyLogFacts {
  const created = new RegExp(`Created conversation (${UUID})`).exec(log)?.[1] ?? null;
  const started = new RegExp(`Print mode: starting \\([^)]*conversationID="(${UUID})"`).exec(log)?.[1] ?? null;
  let model: string | null = null;
  for (const m of log.matchAll(/Propagating selected model override to backend: label="([^"]+)"/g)) model = m[1];
  return { created, started, model };
}

/** The last few error-level lines of agy's log (glog `E…`), for a failed call's diagnostics. */
export function agyLogErrors(log: string, max = 12): string {
  const lines = log.split('\n').filter((l) => /^E\d{4} /.test(l)).slice(-max);
  return lines.map((l) => l.trim().slice(0, 300)).join('\n');
}

/**
 * Drives `agy --print` as the executor. Differences from the other CLIs that the contract exposes:
 * the prompt is a command-line argument (stdin is ignored); stdout is only the final answer text;
 * the conversation id and the model exist only in the log file AI Bridge points agy at; an unknown
 * `--conversation` silently starts a NEW conversation under exit code 0, so a resume is only
 * accepted when the log shows no new conversation and the very id that was asked for.
 */
export class AntigravityCliAdapter implements ExecutorAdapter {
  readonly provider = 'antigravity' as const;
  readonly sessionIdAssignment = 'cli' as const;
  readonly promptChannel = 'argv' as const;
  readonly permissionCapability = ANTIGRAVITY_PERMISSION_CAPABILITY;
  private readonly executable: string;
  private readonly commandArgsPrefix: string[];

  constructor(options: AntigravityCliAdapterOptions) {
    this.executable = options.executable;
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
  }

  permissionArgs(policy: PermissionPolicy): string[] {
    return antigravityPermissionArgs(policy);
  }

  /** agy's stdout carries no model; the log does (see `reportedModel` on the result). */
  findReportedModel(): string | null {
    return null;
  }

  commandLabel(sessionId: string | null, resume: boolean): string {
    return `agy -p <prompt>${resume && sessionId ? ` --conversation ${sessionId}` : ''}`;
  }

  async run(options: ExecutorRunOptions): Promise<ExecutorRunResult> {
    if (options.resume && options.sessionId === null) throw new Error('AntigravityCliAdapter cannot resume without a conversation id');
    const fullPrompt = prependReportContract(options.prompt, options.appendSystemPrompt);
    const logFile = path.join(tmpdir(), `ai-bridge-agy-${randomBytes(6).toString('hex')}.log`);
    const printTimeout = `${Math.max(1, Math.ceil(options.timeoutMs / 1000))}s`;
    // agy's own print timeout defaults to 5 minutes — far below a development step — so it is set to
    // ours; AI Bridge's timer (which kills the process tree) stays the one that decides.
    const args = [...this.commandArgsPrefix, '-p', fullPrompt, '--print-timeout', printTimeout, '--log-file', logFile];
    if (options.resume && options.sessionId !== null) args.push('--conversation', options.sessionId);
    if (options.permissionPolicy !== undefined) args.push(...antigravityPermissionArgs(options.permissionPolicy));

    const promptBytes = Buffer.byteLength(fullPrompt, 'utf8');
    const now = new Date().toISOString();
    const tooLarge = argvCostOf(fullPrompt) > MAX_ARGV_PROMPT_CHARS;
    const refused = (errorCode: ExecutorRunErrorCode, message: string): ExecutorRunResult => ({
      ok: false,
      sessionId: null,
      exitCode: null,
      timedOut: false,
      errorCode,
      receivedPrompt: null,
      receivedSystemPrompt: null,
      receivedPermissionMode: null,
      receivedAllowedTools: null,
      receivedDisallowedTools: null,
      stderr: message,
      durationMs: 0,
      stdout: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      reportedSessionId: null,
      pid: null,
      signal: null,
      startedAt: now,
      endedAt: now,
      promptBytes,
      promptDelivered: false,
      promptDeliveryError: null,
      finalMessage: null,
      executable: this.executable,
      args,
      inputChannel: 'argv',
    });
    if (tooLarge) {
      return refused(
        'INPUT_TOO_LARGE',
        `The prompt (${promptBytes} bytes) does not fit on agy's command line (limit ≈ ${MAX_ARGV_PROMPT_CHARS} characters after escaping), and agy does not read stdin. Nothing was started.`,
      );
    }

    const proc = await runProcess({
      command: this.executable,
      args,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      onSpawn: options.onSpawn,
    });
    const log = await readFile(logFile, 'utf8').catch(() => '');
    await rm(logFile, { force: true }).catch(() => {});
    const facts = parseAgyLog(log);
    const answer = proc.stdout.trim();
    const errorsFromLog = agyLogErrors(log);
    const failed = proc.timedOut || proc.exitCode !== 0;
    const reportedSessionId = facts.created ?? facts.started;

    const base = {
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      // On a failed call the log's error lines are the only place the reason may be; a good call keeps stderr as it was.
      stderr: failed && errorsFromLog !== '' ? `${proc.stderr}${proc.stderr === '' || proc.stderr.endsWith('\n') ? '' : '\n'}--- agy log (errors) ---\n${errorsFromLog}\n` : proc.stderr,
      durationMs: proc.durationMs,
      stdout: proc.stdout,
      stdoutTruncated: proc.stdoutTruncated,
      stderrTruncated: proc.stderrTruncated,
      reportedSessionId,
      pid: proc.pid,
      signal: proc.signal,
      startedAt: proc.startedAt,
      endedAt: proc.endedAt,
      promptBytes,
      // An argument is part of the process that was started; there is no stdin flush to wait for.
      promptDelivered: proc.pid !== null,
      promptDeliveryError: null,
      finalMessage: answer === '' ? null : answer,
      executable: this.executable,
      args,
      inputChannel: 'argv' as const,
      reportedModel: facts.model,
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
    if (/^error:/i.test(answer)) return fail('CLI_REPORTED_ERROR', reportedSessionId);
    if (reportedSessionId === null) return fail('NO_SESSION_ID');
    if (options.resume) {
      // A real resume logs the id it started with and creates nothing; "Created conversation" means agy
      // did not find the one asked for and began a new one (and said so only as a warning).
      if (facts.created !== null || facts.started !== options.sessionId) return fail('SESSION_MISMATCH', reportedSessionId);
    }

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
