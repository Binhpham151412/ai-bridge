import { readFile } from 'node:fs/promises';
import { runProcess } from '../../automation/process-runner.ts';
import type { PermissionPolicy, ProviderPermissionCapability } from '../../core/permissions/permission-policy.ts';

/**
 * M5.10.1 — the permission policy on the installed Codex CLI. Verified against
 * `codex exec --help` / `codex exec resume --help` of codex-cli 0.159.2 (no task was run):
 * - `codex exec` has no interactive approval channel (`-a/--ask-for-approval` exists only on
 *   the top-level interactive `codex`), so there is no real "ask" — the closest supported
 *   restricted mode is the read-only sandbox AI Bridge has always used; anything the
 *   sandbox blocks fails and is reported back to the model.
 * - bypass → `--dangerously-bypass-approvals-and-sandbox`, accepted by both `exec` and
 *   `exec resume` (no approvals, no sandbox).
 * `exec resume` rejects `-s`, so the read-only sandbox is set with `-c sandbox_mode=…` there.
 */
export const CODEX_PERMISSION_CAPABILITY: ProviderPermissionCapability = {
  provider: 'codex',
  displayName: 'Codex',
  verifiedAgainst: 'codex-cli 0.159.2 (`codex exec --help`, `codex exec resume --help`)',
  modes: [
    {
      policy: 'ask',
      label: 'Restricted: read-only sandbox (no approval prompts in codex exec)',
      description:
        '`codex exec` cannot ask for approval. Codex runs in a read-only sandbox: anything that needs more (writing files, starting servers, network) is blocked and reported back.',
      cliMechanism: '-s read-only (resume: -c sandbox_mode="read-only")',
    },
    {
      policy: 'bypass',
      label: 'Bypass approvals and sandbox (automatic mode)',
      description: 'Codex runs commands without approval prompts and without its sandbox.',
      cliMechanism: '--dangerously-bypass-approvals-and-sandbox',
    },
  ],
};

/** The argv for a policy on a fresh (`exec`) or resumed (`exec resume`) run. Fails closed. */
export function codexPermissionArgs(policy: PermissionPolicy, resume: boolean): string[] {
  if (policy === 'bypass') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (policy === 'ask') return resume ? ['-c', 'sandbox_mode="read-only"'] : ['-s', 'read-only'];
  throw new Error(`Unsupported Codex permission policy: ${JSON.stringify(policy)}`);
}

export interface CodexCliAdapterOptions {
  executable: string;
  /** Prepended to argv before the real flags — used in tests to run `node <fake-cli.mjs>` instead of the real binary. */
  commandArgsPrefix?: string[];
}

export interface CodexRunOptions {
  cwd: string;
  input: string;
  /** null starts a fresh thread; a string resumes that thread id. */
  threadId: string | null;
  outputPath: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** M5.10.1: resolved policy, mapped by `codexPermissionArgs`. Omitted → `ask` (read-only sandbox, as before). */
  permissionPolicy?: PermissionPolicy;
  onSpawn?: (pid: number) => void;
  /** The reviewer input was fully written to the CLI's stdin and stdin closed. */
  onInputFlushed?: (bytes: number) => void;
}

export type CodexRunErrorCode = 'SPAWN_FAILED' | 'TIMEOUT' | 'NON_ZERO_EXIT' | 'BAD_JSON' | 'NO_TURN_COMPLETED' | 'THREAD_MISMATCH' | 'OUTPUT_FILE_MISSING';

export interface CodexRunResult {
  ok: boolean;
  threadId: string | null;
  exitCode: number | null;
  timedOut: boolean;
  errorCode: CodexRunErrorCode | null;
  responseText: string | null;
  stderr: string;
  durationMs: number;
  /** Raw `--json` stdout events (bounded) — persisted as "CLI output", not a transcript. */
  stdout: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** thread_id the CLI reported in `thread.started`, even when the run failed; never invented. */
  reportedThreadId: string | null;
  pid: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  inputBytes: number;
  inputDelivered: boolean;
  inputDeliveryError: string | null;
  executable: string;
  args: string[];
}

/** Tolerant scan for the `thread.started` thread id (skips non-JSON lines, never throws). */
export function findReportedCodexThreadId(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as CodexEvent;
      if (e.type === 'thread.started' && typeof e.thread_id === 'string') return e.thread_id;
    } catch {
      // ignored here; the strict parse below reports BAD_JSON
    }
  }
  return null;
}

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
}

/**
 * Drives `codex exec` (and `codex exec resume`) as the M1 reviewer: the reviewer
 * input goes in over stdin verbatim, the response is read back from the CLI's own
 * `-o` output file (the exact markdown it wrote, not a re-serialization of stdout
 * events), and the thread id is tracked explicitly across iterations — a missing or
 * mismatched id is reported, never silently treated as "close enough."
 *
 * `codex exec resume` does not accept `-s`/`-C` (confirmed against the installed
 * CLI); the permission policy picks the sandbox/approval flags (`codexPermissionArgs`),
 * and cwd is always set via the child process's working directory rather than `-C`, so
 * the same mechanism works for both fresh and resumed runs.
 */
export class CodexCliAdapter {
  private readonly executable: string;
  private readonly commandArgsPrefix: string[];

  constructor(options: CodexCliAdapterOptions) {
    this.executable = options.executable;
    this.commandArgsPrefix = options.commandArgsPrefix ?? [];
  }

  async run(options: CodexRunOptions): Promise<CodexRunResult> {
    const policy = options.permissionPolicy ?? 'ask';
    const args =
      options.threadId === null
        ? [...this.commandArgsPrefix, 'exec', '--json', ...codexPermissionArgs(policy, false), '--skip-git-repo-check', '-o', options.outputPath, '-']
        : [
            ...this.commandArgsPrefix,
            'exec',
            'resume',
            options.threadId,
            '--json',
            ...codexPermissionArgs(policy, true),
            '--skip-git-repo-check',
            '-o',
            options.outputPath,
            '-',
          ];

    const proc = await runProcess({
      command: this.executable,
      args,
      cwd: options.cwd,
      env: options.env,
      input: options.input,
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
      reportedThreadId: findReportedCodexThreadId(proc.stdout),
      pid: proc.pid,
      signal: proc.signal,
      startedAt: proc.startedAt,
      endedAt: proc.endedAt,
      inputBytes: proc.inputBytes,
      inputDelivered: proc.inputDelivered,
      inputDeliveryError: proc.inputError,
      executable: this.executable,
      args,
    };
    const fail = (errorCode: CodexRunErrorCode, threadId: string | null = null): CodexRunResult => ({ ok: false, threadId, errorCode, responseText: null, ...base });

    if (proc.timedOut) return fail('TIMEOUT');
    if (proc.exitCode === null && proc.signal === null) return fail('SPAWN_FAILED');
    if (proc.exitCode !== 0) return fail('NON_ZERO_EXIT');

    const lines = proc.stdout.split('\n').filter((l) => l.trim() !== '');
    const events: CodexEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as CodexEvent);
      } catch {
        return fail('BAD_JSON');
      }
    }

    if (!events.some((e) => e.type === 'turn.completed')) return fail('NO_TURN_COMPLETED');

    const threadStarted = events.find((e) => e.type === 'thread.started');
    const reportedThreadId = typeof threadStarted?.thread_id === 'string' ? threadStarted.thread_id : null;
    const expectedThreadId = options.threadId; // null means "any fresh id is fine"
    if (reportedThreadId === null || (expectedThreadId !== null && reportedThreadId !== expectedThreadId)) {
      return fail('THREAD_MISMATCH', reportedThreadId);
    }

    let responseText: string;
    try {
      responseText = await readFile(options.outputPath, 'utf8');
    } catch {
      return fail('OUTPUT_FILE_MISSING', reportedThreadId);
    }

    return { ok: true, threadId: reportedThreadId, errorCode: null, responseText, ...base };
  }
}
