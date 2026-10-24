import type { PermissionPolicy, PermissionProvider, ProviderPermissionCapability } from '../permissions/permission-policy.ts';

/**
 * docs/64 — the pluggable EXECUTOR (the AI that writes the code and the report). The
 * reviewer is not pluggable: it stays Codex/ChatGPT.
 *
 * Persisted names that say "claude" (`claudeSessionId`, the `claude` permission slot, the
 * `CLAUDE_EXECUTING` state, `NNN-claude-execution.json`, …) now mean "the developer slot".
 * They are deliberately NOT renamed: state files, execution records and resume must keep
 * working across versions. Which CLI actually filled the slot is recorded as `provider`.
 *
 * Zero runtime imports on purpose: shared by Core, the adapters, Electron Main and (as
 * values/types) the renderer.
 */

export const EXECUTOR_PROVIDERS = ['claude-code', 'opencode', 'antigravity'] as const;
export type ExecutorProviderId = (typeof EXECUTOR_PROVIDERS)[number];

/** The product default — what every project that never set `executor` has always used. */
export const DEFAULT_EXECUTOR_PROVIDER: ExecutorProviderId = 'claude-code';

export function isExecutorProviderId(value: unknown): value is ExecutorProviderId {
  return typeof value === 'string' && (EXECUTOR_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Who chooses the session id of a NEW session.
 * - `caller`: AI Bridge generates it and hands it to the CLI (Claude `--session-id`).
 * - `cli`: the CLI creates it and reports it (OpenCode `ses_…`); AI Bridge may only resume
 *   with an id the CLI has already reported.
 */
export type SessionIdAssignment = 'caller' | 'cli';

/** How the prompt reaches the CLI: piped to stdin, or as an argument on its command line. */
export type PromptChannel = 'stdin' | 'argv';

export interface ExecutorProviderInfo {
  displayName: string;
  /** Used in event/log sentences: "<cliLabel> CLI process started". */
  cliLabel: string;
  /** Name looked up on PATH. */
  executableName: string;
  /** The key under `permissions` and `models` in `.ai-bridge/config.json`. */
  configKey: PermissionProvider;
  sessionIdAssignment: SessionIdAssignment;
  promptChannel: PromptChannel;
  /** false = the CLI has no flag to choose a model (it uses its own setting); AI Bridge sends none. */
  supportsModel: boolean;
  /** Short, user-facing hint about how the model is written for this CLI. */
  modelHint: string;
  /** Doctor check names for this CLI: [executable check, sign-in check]. */
  doctorChecks: readonly [string, string];
  /** Command the user runs to sign in (never run by AI Bridge itself). */
  loginHint: string;
}

export const EXECUTOR_PROVIDER_INFO: Record<ExecutorProviderId, ExecutorProviderInfo> = {
  'claude-code': {
    displayName: 'Claude Code',
    cliLabel: 'Claude',
    executableName: 'claude',
    configKey: 'claude',
    sessionIdAssignment: 'caller',
    promptChannel: 'stdin',
    supportsModel: true,
    modelHint: 'an alias or id such as "opus" or "claude-opus-5-5"',
    doctorChecks: ['claude-cli', 'claude-auth'],
    loginHint: 'claude auth login --claudeai',
  },
  opencode: {
    displayName: 'OpenCode',
    cliLabel: 'OpenCode',
    executableName: 'opencode',
    configKey: 'opencode',
    sessionIdAssignment: 'cli',
    promptChannel: 'stdin',
    supportsModel: true,
    modelHint: 'written as provider/model, e.g. "anthropic/claude-opus-5-5"',
    doctorChecks: ['opencode-cli', 'opencode-auth'],
    loginHint: 'opencode auth login',
  },
  antigravity: {
    displayName: 'Antigravity',
    cliLabel: 'Antigravity',
    executableName: 'agy',
    configKey: 'antigravity',
    sessionIdAssignment: 'cli',
    promptChannel: 'argv',
    supportsModel: false,
    modelHint: 'chosen inside Antigravity itself (the CLI has no model flag)',
    doctorChecks: ['antigravity-cli', 'antigravity-auth'],
    loginHint: 'agy (opens its interactive sign-in)',
  },
};

/** The report contract and the prompt as ONE text, for a CLI that has no separate system-prompt
 * channel. Nothing in the prompt is changed; the contract is simply put in front of it. */
export function prependReportContract(prompt: string, contract: string | undefined): string {
  if (contract === undefined || contract === '') return prompt;
  return `${contract}\n\n---\n\n${prompt}`;
}

export interface ExecutorRunOptions {
  cwd: string;
  prompt: string;
  /** The session to use (caller-assigned) or to resume. `null` = a NEW session whose id the CLI will create. */
  sessionId: string | null;
  resume: boolean;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** The report-file contract. Claude sends it on a channel separate from stdin
   * (`--append-system-prompt`); a CLI without such a flag gets it prepended to the prompt. */
  appendSystemPrompt?: string;
  /** The resolved provider-neutral policy; each adapter maps it to its own flags. Omitted → no permission flag. */
  permissionPolicy?: PermissionPolicy;
  /** Omitted → no flag: the CLI's own setting decides. */
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  onSpawn?: (pid: number) => void;
  /** The prompt was fully written to the CLI's stdin and stdin closed (see runProcess). */
  onInputFlushed?: (bytes: number) => void;
}

export type ExecutorRunErrorCode =
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'NON_ZERO_EXIT'
  | 'BAD_JSON'
  | 'NO_RESULT_EVENT'
  | 'SESSION_MISMATCH'
  /** The CLI exited 0 but its own event stream reported an error (OpenCode does this). */
  | 'CLI_REPORTED_ERROR'
  /** The prompt would not fit on the command line of a CLI that takes it as an argument. Nothing was spawned. */
  | 'INPUT_TOO_LARGE'
  /** A `cli`-assigned NEW session whose id the CLI never reported — it could never be resumed. */
  | 'NO_SESSION_ID';

export interface ExecutorRunResult {
  ok: boolean;
  sessionId: string | null;
  exitCode: number | null;
  timedOut: boolean;
  errorCode: ExecutorRunErrorCode | null;
  receivedPrompt: string | null;
  receivedSystemPrompt: string | null;
  receivedPermissionMode: string | null;
  receivedAllowedTools: string[] | null;
  receivedDisallowedTools: string[] | null;
  stderr: string;
  durationMs: number;
  /** Raw stdout (bounded by runProcess's maxBufferBytes) — the CLI's own event output,
   * persisted by the orchestrator as "CLI output". Not a transcript. */
  stdout: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** The session id the CLI itself reported, even when the run failed — null when it never
   * reported one. Never invented. */
  reportedSessionId: string | null;
  pid: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  promptBytes: number;
  /** Prompt bytes flushed to the CLI's stdin and stdin closed without error. */
  promptDelivered: boolean;
  promptDeliveryError: string | null;
  /** The CLI's final message text, when it emitted one (success or not). */
  finalMessage: string | null;
  /** Where the prompt went. Absent = stdin (the original behaviour). */
  inputChannel?: PromptChannel;
  /** The model the CLI itself reported during this call (not read from stdout by the orchestrator). */
  reportedModel?: string | null;
  executable: string;
  args: string[];
}

export interface ExecutorAdapter {
  readonly provider: ExecutorProviderId;
  readonly sessionIdAssignment: SessionIdAssignment;
  readonly promptChannel: PromptChannel;
  /** What the installed CLI declares it can do for each permission policy. */
  readonly permissionCapability: ProviderPermissionCapability;
  run(options: ExecutorRunOptions): Promise<ExecutorRunResult>;
  /** The argv a policy becomes. Throws for a policy the CLI does not declare (fail closed). */
  permissionArgs(policy: PermissionPolicy): string[];
  /** The model the CLI itself says it used, or null. Never inferred from what was requested. */
  findReportedModel(stdout: string): string | null;
  /** Human-readable command line for the audit log (no secrets, no prompt). */
  commandLabel(sessionId: string | null, resume: boolean): string;
}
