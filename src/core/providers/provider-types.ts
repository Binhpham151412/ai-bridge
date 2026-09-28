import type { RunProcessOptions, RunProcessResult } from '../../automation/process-runner.ts';

/**
 * M4.3 Phase 1 — typed provider model. A "provider" is an AI CLI that AI Bridge can drive
 * (Claude Code as executor, Codex as reviewer). This module only describes discovery,
 * authentication and readiness diagnostics; it is not used by the execution flow.
 *
 * Known ids are listed for autocompletion; any other string is a future provider
 * registered at runtime (see ProviderRegistry.register).
 */
export type ProviderId = 'claude-code' | 'codex' | (string & {});

export type ProviderRole = 'executor' | 'reviewer';

export type ProviderCapability =
  /** Status diagnostics (version + auth) that spend no model quota. */
  | 'status-check'
  /** Opt-in minimal prompt that proves the CLI can execute — spends a small amount of quota. */
  | 'execution-probe'
  /** The official CLI has a login command the future UI may launch on explicit user action. */
  | 'cli-login'
  | 'reports-account'
  | 'reports-subscription';

export type InstallationStatus = 'INSTALLED' | 'NOT_INSTALLED' | 'UNKNOWN';

export type AuthenticationStatus = 'AUTHENTICATED' | 'NOT_AUTHENTICATED' | 'UNKNOWN';

/** ACCOUNT_LOGIN = the CLI's own account login (claude.ai subscription / ChatGPT account),
 * which is what AI Bridge requires. API_KEY logins bill an API key and are refused. */
export type AuthMethod = 'ACCOUNT_LOGIN' | 'API_KEY' | 'NONE' | 'UNKNOWN';

/** AVAILABLE is only ever set by a passing execution probe; nothing else can know. */
export type QuotaStatus = 'AVAILABLE' | 'LIMITED' | 'UNKNOWN';

export type QuotaScope = 'WEEKLY' | 'UNSPECIFIED';

export type ProviderReadiness = 'READY' | 'LIMITED' | 'NOT_READY' | 'ERROR' | 'UNKNOWN';

/** Coarse summary combining installation, authentication and readiness (M4.3 §6). */
export type ProviderState = 'NOT_INSTALLED' | 'INSTALLED_NOT_AUTHENTICATED' | 'AUTHENTICATED' | 'AUTHENTICATED_BUT_NOT_READY' | 'UNKNOWN';

export type ProviderErrorCode =
  | 'PROVIDER_NOT_INSTALLED'
  | 'PROVIDER_NOT_AUTHENTICATED'
  /** Logged in with an API key, or an API-key env var is set — AI Bridge's cost guard refuses these. */
  | 'PROVIDER_AUTH_MODE_UNSUPPORTED'
  | 'PROVIDER_COMMAND_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_OUTPUT_INVALID'
  | 'PROVIDER_QUOTA_LIMIT'
  /** The adapter itself threw — a bug, not a CLI condition. */
  | 'PROVIDER_UNKNOWN';

export type DiagnosticStep = 'discover' | 'version' | 'auth' | 'environment' | 'probe' | 'adapter';

export interface ProviderDiagnosticError {
  code: ProviderErrorCode;
  step: DiagnosticStep;
  /** Safe, user-facing sentence. */
  message: string;
  /** Redacted, truncated technical detail (exit code, CLI excerpt); null when there is none. */
  detail: string | null;
}

export interface ProviderAuthentication {
  status: AuthenticationStatus;
  method: AuthMethod;
  /** Account identity only when the official CLI prints it; never inferred. */
  account: string | null;
  /** Plan only when the official CLI prints it (e.g. Claude's subscriptionType). */
  subscription: string | null;
}

export interface ProviderQuota {
  status: QuotaStatus;
  scope: QuotaScope | null;
  /** Redacted CLI message that reported the limit. */
  detail: string | null;
}

export type ExecutionCheckStatus = 'NOT_RUN' | 'SKIPPED' | 'PASSED' | 'FAILED' | 'LIMITED';

export interface ProviderExecutionCheck {
  status: ExecutionCheckStatus;
  durationMs: number | null;
}

/** 'status' = version + auth only (no quota spent). 'execution' also runs the probe. */
export type DiagnosticDepth = 'status' | 'execution';

export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  roles: ProviderRole[];
  capabilities: ProviderCapability[];
  /** Name looked up on PATH, e.g. "claude" (resolved to claude.exe on Windows). */
  executableName: string;
}

export interface ProviderStatus {
  provider: ProviderId;
  displayName: string;
  roles: ProviderRole[];
  capabilities: ProviderCapability[];
  executable: string | null;
  installation: InstallationStatus;
  version: string | null;
  authentication: ProviderAuthentication;
  quota: ProviderQuota;
  executionCheck: ProviderExecutionCheck;
  state: ProviderState;
  readiness: ProviderReadiness;
  diagnosticMessage: string;
  errors: ProviderDiagnosticError[];
  depth: DiagnosticDepth;
  checkedAt: string;
  durationMs: number;
}

/** Describes — never runs — the official login command, for a future explicit [Login] action. */
export interface ProviderLoginCommand {
  /** null when the CLI isn't installed (the caller must re-check first). */
  executable: string | null;
  args: string[];
  displayCommand: string;
  interactive: true;
}

export interface ProviderDiagnosticContext {
  /** PATH-aware lookup; null when not found. */
  locateExecutable: (name: string) => Promise<string | null>;
  runCommand: (options: RunProcessOptions) => Promise<RunProcessResult>;
  /** Environment given to every child process (and checked for API-key vars). */
  env: NodeJS.ProcessEnv;
  statusTimeoutMs: number;
  probeTimeoutMs: number;
  /** Neutral working directory for the probe, so no project instructions/files are involved. */
  probeCwd: string;
  now: () => Date;
  /** Test-only: prepended to argv per provider id (e.g. a fake-CLI script run via node). */
  commandArgsPrefix?: Partial<Record<string, string[]>>;
}

export interface ProviderAdapter {
  descriptor: ProviderDescriptor;
  /** Must resolve (never reject) with a complete status; the registry still guards against throws. */
  diagnose: (ctx: ProviderDiagnosticContext, depth: DiagnosticDepth) => Promise<ProviderStatus>;
  loginCommand: (executable: string | null) => ProviderLoginCommand | null;
}
