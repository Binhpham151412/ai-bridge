import type { RunProcessResult } from '../../automation/process-runner.ts';
import { parseCodexLoginStatus } from '../cost-guard.ts';
import { createCliProviderAdapter, describeFailure, detectUsageLimit, safeExcerpt, unrecognized, type AuthParse, type ProbeParse } from './cli-provider.ts';
import type { ProviderAdapter } from './provider-types.ts';

/**
 * `codex login status` prints plain text (to stderr in codex-cli 0.155): "Logged in using
 * ChatGPT", "Logged in using an API key …" or "Not logged in". It exposes neither the
 * account identity nor the ChatGPT plan, so both stay null. Mapping is shared with the
 * doctor's cost guard (parseCodexLoginStatus).
 */
export function parseCodexAuthOutput(r: RunProcessResult): AuthParse {
  const text = r.stdout.trim() || r.stderr.trim();
  const mode = parseCodexLoginStatus(text).authMode;
  if (mode === 'chatgpt') return { kind: 'parsed', status: 'AUTHENTICATED', method: 'ACCOUNT_LOGIN', account: null, subscription: null };
  if (mode === 'api-key') return { kind: 'parsed', status: 'AUTHENTICATED', method: 'API_KEY', account: null, subscription: null };
  if (mode === 'none') return { kind: 'parsed', status: 'NOT_AUTHENTICATED', method: 'NONE', account: null, subscription: null };
  return unrecognized(r, '"codex login status"');
}

interface CodexEvent {
  type?: unknown;
  message?: unknown;
  error?: { message?: unknown };
}

/**
 * `codex exec --json` prints JSONL events. Success = a `turn.completed` event and exit 0.
 * Failures surface as `{"type":"error","message":…}` and/or `{"type":"turn.failed",
 * "error":{"message":…}}`; only that error text (plus stderr) is checked for usage limits.
 */
export function parseCodexProbeOutput(r: RunProcessResult): ProbeParse {
  const events: CodexEvent[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as unknown;
      if (typeof e === 'object' && e !== null) events.push(e as CodexEvent);
    } catch {
      // tolerate stray non-JSON lines
    }
  }
  const completed = events.some((e) => e.type === 'turn.completed');
  if (completed && r.exitCode === 0) return { kind: 'passed' };

  const errorMessages = events.flatMap((e) => {
    if (e.type === 'error' && typeof e.message === 'string') return [e.message];
    if (e.type === 'turn.failed' && typeof e.error?.message === 'string') return [e.error.message];
    return [];
  });
  const limit = detectUsageLimit([...errorMessages, r.stderr].join('\n'));
  if (limit) return { kind: 'limited', scope: limit.scope, message: limit.message };
  if (r.exitCode === 0 && errorMessages.length === 0) {
    return { kind: 'failed', code: 'PROVIDER_OUTPUT_INVALID', detail: `no turn.completed event in output: ${safeExcerpt(r.stdout || '(no output)')}` };
  }
  return { kind: 'failed', code: 'PROVIDER_COMMAND_FAILED', detail: errorMessages.length > 0 ? safeExcerpt(errorMessages.join(' | ')) : describeFailure(r) };
}

export function createCodexProvider(): ProviderAdapter {
  return createCliProviderAdapter({
    descriptor: {
      id: 'codex',
      displayName: 'ChatGPT / Codex',
      roles: ['reviewer'],
      capabilities: ['status-check', 'execution-probe', 'cli-login'],
      executableName: 'codex',
    },
    versionArgs: ['--version'],
    authArgs: ['login', 'status'],
    parseAuth: parseCodexAuthOutput,
    probe: {
      // Read-only sandbox, no persisted session, outside any repo — prompt via stdin ("-").
      args: ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-'],
      input: 'This is an AI Bridge connectivity check. Do not run any commands. Reply with exactly: OK',
      parse: parseCodexProbeOutput,
    },
    loginArgs: ['login'],
    costRiskEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  });
}
