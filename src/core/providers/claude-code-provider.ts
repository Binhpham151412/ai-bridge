import type { RunProcessResult } from '../../automation/process-runner.ts';
import { parseClaudeAuthStatus } from '../cost-guard.ts';
import { createCliProviderAdapter, describeFailure, detectUsageLimit, isPlausibleEmail, safeExcerpt, sanitizePlan, unrecognized, type AuthParse, type ProbeParse } from './cli-provider.ts';
import type { ProviderAdapter } from './provider-types.ts';

/**
 * `claude auth status` (JSON is its default output). Observed shapes:
 *   logged out → {"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}  (exit 1)
 *   logged in  → {"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro",…}
 * The exit code is 1 when logged out, so the JSON is parsed before the exit code is judged.
 * Login-mode mapping is shared with the doctor's cost guard (parseClaudeAuthStatus).
 * `email` / `subscriptionType` are used only when present and well-formed.
 */
export function parseClaudeAuthOutput(r: RunProcessResult): AuthParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    return unrecognized(r, '"claude auth status"');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).loggedIn !== 'boolean') {
    return unrecognized(r, '"claude auth status"');
  }
  const obj = parsed as Record<string, unknown>;
  const mode = parseClaudeAuthStatus(r.stdout.trim()).authMode;
  if (mode === 'none') return { kind: 'parsed', status: 'NOT_AUTHENTICATED', method: 'NONE', account: null, subscription: null };
  return {
    kind: 'parsed',
    status: 'AUTHENTICATED',
    method: mode === 'subscription' ? 'ACCOUNT_LOGIN' : mode === 'api-key' ? 'API_KEY' : 'UNKNOWN',
    account: isPlausibleEmail(obj.email) ? obj.email : null,
    subscription: sanitizePlan(obj.subscriptionType),
  };
}

function findResultEvent(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const candidate of [stdout.trim(), ...[...lines].reverse()]) {
    try {
      const o = JSON.parse(candidate) as unknown;
      if (typeof o === 'object' && o !== null && (o as Record<string, unknown>).type === 'result') return o as Record<string, unknown>;
    } catch {
      // not JSON — keep looking
    }
  }
  return null;
}

/**
 * `claude -p --output-format json` prints one result object:
 *   {"type":"result","subtype":"success","is_error":false,"result":"OK",…}
 * On failure `is_error` is true and `result` carries the CLI's error text (e.g. a usage
 * limit message). Limit detection only looks at error text, never at a successful answer.
 */
export function parseClaudeProbeOutput(r: RunProcessResult): ProbeParse {
  const result = findResultEvent(r.stdout);
  if (result !== null && result.is_error === false && r.exitCode === 0) return { kind: 'passed' };

  const resultText = result !== null && typeof result.result === 'string' ? result.result : '';
  const limit = detectUsageLimit([resultText, r.stderr, result === null ? r.stdout : ''].join('\n'));
  if (limit) return { kind: 'limited', scope: limit.scope, message: limit.message };
  if (result === null && r.exitCode === 0) return { kind: 'failed', code: 'PROVIDER_OUTPUT_INVALID', detail: `no result event in output: ${safeExcerpt(r.stdout || '(no output)')}` };
  return { kind: 'failed', code: 'PROVIDER_COMMAND_FAILED', detail: resultText ? safeExcerpt(resultText) : describeFailure(r) };
}

export function createClaudeCodeProvider(): ProviderAdapter {
  return createCliProviderAdapter({
    descriptor: {
      id: 'claude-code',
      displayName: 'Claude Code',
      roles: ['executor'],
      capabilities: ['status-check', 'execution-probe', 'cli-login', 'reports-account', 'reports-subscription'],
      executableName: 'claude',
    },
    versionArgs: ['--version'],
    authArgs: ['auth', 'status'],
    parseAuth: parseClaudeAuthOutput,
    probe: {
      // No tools, no saved session, JSON result — a single-turn "say OK" that can't touch files.
      args: ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', ''],
      input: 'This is an AI Bridge connectivity check. Reply with exactly: OK',
      parse: parseClaudeProbeOutput,
    },
    loginArgs: ['auth', 'login', '--claudeai'],
    costRiskEnvKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  });
}
