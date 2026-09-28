import type { RunProcessResult } from '../../automation/process-runner.ts';
import { redactSecrets } from '../security/redact.ts';
import type {
  AuthMethod,
  AuthenticationStatus,
  DiagnosticDepth,
  DiagnosticStep,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderDiagnosticContext,
  ProviderDiagnosticError,
  ProviderErrorCode,
  ProviderExecutionCheck,
  ProviderLoginCommand,
  ProviderQuota,
  ProviderReadiness,
  ProviderState,
  ProviderStatus,
  QuotaScope,
} from './provider-types.ts';

// ---------------------------------------------------------------------------
// Parser result shapes (what a provider-specific parser tells the pipeline)
// ---------------------------------------------------------------------------

export type AuthParse =
  | { kind: 'parsed'; status: AuthenticationStatus; method: AuthMethod; account: string | null; subscription: string | null }
  /** Exit 0 but output isn't in the documented shape. */
  | { kind: 'invalid'; detail: string }
  /** The command itself failed and printed nothing recognizable. */
  | { kind: 'failed'; detail: string };

export type ProbeParse =
  | { kind: 'passed' }
  | { kind: 'limited'; scope: QuotaScope; message: string }
  | { kind: 'failed'; code: 'PROVIDER_COMMAND_FAILED' | 'PROVIDER_OUTPUT_INVALID'; detail: string };

export interface CliProviderSpec {
  descriptor: ProviderDescriptor;
  versionArgs: string[];
  authArgs: string[];
  parseAuth: (r: RunProcessResult) => AuthParse;
  probe: { args: string[]; input: string; parse: (r: RunProcessResult) => ProbeParse };
  loginArgs: string[];
  /** Env vars whose mere presence makes this CLI bill an API key (values are never read). */
  costRiskEnvKeys: readonly string[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_DETAIL_CHARS = 300;

/** Redacts credential-shaped substrings, collapses whitespace and truncates — the only way
 * CLI output may enter a ProviderStatus. */
export function safeExcerpt(text: string, max = MAX_DETAIL_CHARS): string {
  const oneLine = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** First semver-looking token, e.g. "2.1.161 (Claude Code)" → "2.1.161",
 * "codex-cli 0.155.0-alpha.16.4" → "0.155.0-alpha.16.4". */
export function parseVersion(text: string): string | null {
  const m = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text);
  return m ? m[1] : null;
}

const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\busage limit\b/i,
  /\bhit your (?:\w+ )?limit\b/i,
  /\b(?:weekly|5-hour|session|daily) limit\b/i,
  /\blimit reached\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
];

/** Conservative: only phrases the CLIs use for plan/usage limits. A generic "rate limit"
 * (transient HTTP 429 throttling) is deliberately NOT treated as a quota limit. Only call
 * this on a CLI's *error* text, never on a successful model answer. */
export function detectUsageLimit(text: string): { scope: QuotaScope; message: string } | null {
  if (!USAGE_LIMIT_PATTERNS.some((p) => p.test(text))) return null;
  return { scope: /\bweekly\b/i.test(text) ? 'WEEKLY' : 'UNSPECIFIED', message: safeExcerpt(text) };
}

export function isPlausibleEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/.test(value);
}

/** Plan names are short identifiers ("pro", "max"); anything else is not trusted. */
export function sanitizePlan(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value.toLowerCase() : null;
}

export function describeFailure(r: RunProcessResult): string {
  const text = r.stderr.trim() || r.stdout.trim();
  const out = text ? ` — ${safeExcerpt(text)}` : '';
  if (r.exitCode === null && r.signal === null) return `process could not be started${out}`;
  return `exit code ${r.exitCode ?? `signal ${r.signal}`}${out}`;
}

/** A parser that didn't recognize the output: "failed" when the CLI exited non-zero,
 * otherwise "invalid" (exit 0 but not the documented shape). */
export function unrecognized(r: RunProcessResult, what: string): AuthParse {
  const excerpt = safeExcerpt(r.stdout.trim() || r.stderr.trim() || '(no output)');
  return r.exitCode === 0 ? { kind: 'invalid', detail: `unrecognized ${what} output: ${excerpt}` } : { kind: 'failed', detail: describeFailure(r) };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const UNKNOWN_AUTH = { status: 'UNKNOWN', method: 'UNKNOWN', account: null, subscription: null } as const;
const UNKNOWN_QUOTA: ProviderQuota = { status: 'UNKNOWN', scope: null, detail: null };

function stateFor(installed: boolean, auth: AuthenticationStatus, readiness: ProviderReadiness): ProviderState {
  if (!installed) return 'NOT_INSTALLED';
  if (auth === 'NOT_AUTHENTICATED') return 'INSTALLED_NOT_AUTHENTICATED';
  if (auth === 'UNKNOWN') return 'UNKNOWN';
  return readiness === 'READY' ? 'AUTHENTICATED' : 'AUTHENTICATED_BUT_NOT_READY';
}

type StatusFields = Pick<ProviderStatus, 'executable' | 'installation' | 'version' | 'authentication' | 'quota' | 'executionCheck' | 'readiness' | 'diagnosticMessage'>;

/**
 * discover → version → auth → environment → (probe, only at depth "execution").
 * Never throws for CLI conditions, and never spawns the probe unless the login is an
 * account login and no API-key env var is set (so a probe can never bill an API key).
 */
export async function diagnoseCliProvider(spec: CliProviderSpec, ctx: ProviderDiagnosticContext, depth: DiagnosticDepth): Promise<ProviderStatus> {
  const d = spec.descriptor;
  const startedMs = Date.now();
  const checkedAt = ctx.now().toISOString();
  const errors: ProviderDiagnosticError[] = [];
  const cmd = d.executableName;
  // At depth "execution", a probe withheld because an earlier step failed is SKIPPED.
  const probeNotRun: ProviderExecutionCheck = { status: depth === 'execution' ? 'SKIPPED' : 'NOT_RUN', durationMs: null };
  const addError = (code: ProviderErrorCode, step: DiagnosticStep, message: string, detail: string | null = null) => {
    errors.push({ code, step, message, detail });
  };

  const finish = (fields: StatusFields): ProviderStatus => ({
    provider: d.id,
    displayName: d.displayName,
    roles: [...d.roles],
    capabilities: [...d.capabilities],
    ...fields,
    state: stateFor(fields.installation === 'INSTALLED', fields.authentication.status, fields.readiness),
    errors,
    depth,
    checkedAt,
    durationMs: Date.now() - startedMs,
  });

  // 1. discover
  const executable = await ctx.locateExecutable(cmd).catch(() => null);
  if (executable === null) {
    const message = `${d.displayName} CLI (${cmd}) was not found on PATH.`;
    addError('PROVIDER_NOT_INSTALLED', 'discover', message);
    return finish({
      executable: null,
      installation: 'NOT_INSTALLED',
      version: null,
      authentication: { ...UNKNOWN_AUTH },
      quota: { ...UNKNOWN_QUOTA },
      executionCheck: probeNotRun,
      readiness: 'NOT_READY',
      diagnosticMessage: message,
    });
  }

  const prefix = ctx.commandArgsPrefix?.[d.id] ?? [];
  const run = (args: string[], timeoutMs: number, extra: { input?: string; cwd?: string } = {}) =>
    ctx.runCommand({ command: executable, args: [...prefix, ...args], env: ctx.env, timeoutMs, maxBufferBytes: 1024 * 1024, ...extra });
  const shown = (args: string[]) => [cmd, ...args].join(' ');

  // 2. version — informational; a failure here is recorded but doesn't decide readiness.
  let version: string | null = null;
  const v = await run(spec.versionArgs, ctx.statusTimeoutMs);
  if (v.timedOut) addError('PROVIDER_TIMEOUT', 'version', `"${shown(spec.versionArgs)}" timed out after ${ctx.statusTimeoutMs} ms.`);
  else if (v.exitCode !== 0) addError('PROVIDER_COMMAND_FAILED', 'version', `"${shown(spec.versionArgs)}" failed.`, describeFailure(v));
  else {
    version = parseVersion(v.stdout) ?? parseVersion(v.stderr);
    if (version === null) addError('PROVIDER_OUTPUT_INVALID', 'version', `"${shown(spec.versionArgs)}" printed no recognizable version.`, safeExcerpt(v.stdout || v.stderr || '(no output)'));
  }

  const base = { executable, installation: 'INSTALLED' as const, version };

  // 3. auth
  const a = await run(spec.authArgs, ctx.statusTimeoutMs);
  if (a.timedOut) {
    const message = `"${shown(spec.authArgs)}" timed out after ${ctx.statusTimeoutMs} ms.`;
    addError('PROVIDER_TIMEOUT', 'auth', message);
    return finish({ ...base, authentication: { ...UNKNOWN_AUTH }, quota: { ...UNKNOWN_QUOTA }, executionCheck: probeNotRun, readiness: 'ERROR', diagnosticMessage: message });
  }
  const auth = spec.parseAuth(a);
  if (auth.kind !== 'parsed') {
    const invalid = auth.kind === 'invalid';
    const message = invalid ? `Could not interpret "${shown(spec.authArgs)}" output.` : `"${shown(spec.authArgs)}" failed.`;
    addError(invalid ? 'PROVIDER_OUTPUT_INVALID' : 'PROVIDER_COMMAND_FAILED', 'auth', message, auth.detail);
    return finish({
      ...base,
      authentication: { ...UNKNOWN_AUTH },
      quota: { ...UNKNOWN_QUOTA },
      executionCheck: probeNotRun,
      readiness: invalid ? 'UNKNOWN' : 'ERROR',
      diagnosticMessage: message,
    });
  }
  const authentication = { status: auth.status, method: auth.method, account: auth.account, subscription: auth.subscription };
  const loginHint = `Log in with: ${[cmd, ...spec.loginArgs].join(' ')}`;
  const stop = (code: ProviderErrorCode, step: DiagnosticStep, message: string, readiness: ProviderReadiness = 'NOT_READY') => {
    addError(code, step, message);
    return finish({ ...base, authentication, quota: { ...UNKNOWN_QUOTA }, executionCheck: probeNotRun, readiness, diagnosticMessage: message });
  };

  if (auth.status === 'NOT_AUTHENTICATED') return stop('PROVIDER_NOT_AUTHENTICATED', 'auth', `${d.displayName} is installed but not logged in. ${loginHint}`);
  if (auth.status === 'UNKNOWN' || auth.method === 'UNKNOWN') {
    return stop('PROVIDER_OUTPUT_INVALID', 'auth', `${d.displayName} reported an unrecognized login method; readiness cannot be determined.`, 'UNKNOWN');
  }
  if (auth.method === 'API_KEY') {
    return stop('PROVIDER_AUTH_MODE_UNSUPPORTED', 'auth', `${d.displayName} is logged in with an API key; AI Bridge only uses account/subscription logins. ${loginHint}`);
  }

  // 4. environment — presence only; values are never read or returned.
  const riskyEnv = spec.costRiskEnvKeys.filter((k) => (ctx.env[k] ?? '') !== '');
  if (riskyEnv.length > 0) {
    return stop('PROVIDER_AUTH_MODE_UNSUPPORTED', 'environment', `${riskyEnv.join(', ')} is set in the environment, so ${d.displayName} would bill an API key. Unset it to use the account login.`);
  }

  const who = [authentication.account, authentication.subscription ? `plan ${authentication.subscription}` : null].filter(Boolean).join(', ');
  const loggedIn = `${d.displayName} is installed and logged in${who ? ` (${who})` : ''}.`;

  if (depth === 'status') {
    return finish({ ...base, authentication, quota: { ...UNKNOWN_QUOTA }, executionCheck: probeNotRun, readiness: 'READY', diagnosticMessage: `${loggedIn} Usage quota was not checked.` });
  }

  // 5. execution probe (opt-in)
  const p = await run(spec.probe.args, ctx.probeTimeoutMs, { input: spec.probe.input, cwd: ctx.probeCwd });
  if (p.timedOut) {
    const message = `${d.displayName} diagnostic prompt timed out after ${ctx.probeTimeoutMs} ms.`;
    addError('PROVIDER_TIMEOUT', 'probe', message);
    return finish({ ...base, authentication, quota: { ...UNKNOWN_QUOTA }, executionCheck: { status: 'FAILED', durationMs: p.durationMs }, readiness: 'ERROR', diagnosticMessage: message });
  }
  const probe = spec.probe.parse(p);
  if (probe.kind === 'passed') {
    return finish({
      ...base,
      authentication,
      quota: { status: 'AVAILABLE', scope: null, detail: null },
      executionCheck: { status: 'PASSED', durationMs: p.durationMs },
      readiness: 'READY',
      diagnosticMessage: `${loggedIn} A minimal diagnostic prompt completed.`,
    });
  }
  if (probe.kind === 'limited') {
    const message = `${d.displayName} reported a ${probe.scope === 'WEEKLY' ? 'weekly ' : ''}usage limit: ${probe.message}`;
    addError('PROVIDER_QUOTA_LIMIT', 'probe', message, probe.message);
    return finish({
      ...base,
      authentication,
      quota: { status: 'LIMITED', scope: probe.scope, detail: probe.message },
      executionCheck: { status: 'LIMITED', durationMs: p.durationMs },
      readiness: 'LIMITED',
      diagnosticMessage: message,
    });
  }
  const message = `${d.displayName} diagnostic prompt did not complete.`;
  addError(probe.code, 'probe', message, probe.detail);
  return finish({ ...base, authentication, quota: { ...UNKNOWN_QUOTA }, executionCheck: { status: 'FAILED', durationMs: p.durationMs }, readiness: 'ERROR', diagnosticMessage: message });
}

export function createCliProviderAdapter(spec: CliProviderSpec): ProviderAdapter {
  return {
    descriptor: spec.descriptor,
    diagnose: (ctx, depth) => diagnoseCliProvider(spec, ctx, depth),
    loginCommand: (executable): ProviderLoginCommand => ({
      executable,
      args: [...spec.loginArgs],
      displayCommand: [spec.descriptor.executableName, ...spec.loginArgs].join(' '),
      interactive: true,
    }),
  };
}
