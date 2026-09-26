export interface ApiKeyCheckResult {
  blocked: boolean;
  foundKeys: string[];
}

export type ClaudeAuthMode = 'subscription' | 'api-key' | 'none' | 'unknown';
export type CodexAuthMode = 'chatgpt' | 'api-key' | 'none' | 'unknown';

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMode: ClaudeAuthMode;
}

export interface CodexAuthStatus {
  loggedIn: boolean;
  authMode: CodexAuthMode;
}

/** Env vars that mean "this run would be billed via an API key," per the M1 cost-guard rule. */
const COST_RISK_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

/** Refuses to look at key values, only their presence — the result must never leak a secret. */
export function checkEnvForApiKeys(env: NodeJS.ProcessEnv): ApiKeyCheckResult {
  const foundKeys = COST_RISK_KEYS.filter((k) => (env[k] ?? '') !== '');
  return { blocked: foundKeys.length > 0, foundKeys };
}

export function parseClaudeAuthStatus(statusJson: string): ClaudeAuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    return { loggedIn: false, authMode: 'unknown' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { loggedIn: false, authMode: 'unknown' };
  const obj = parsed as Record<string, unknown>;
  const loggedIn = obj.loggedIn === true;
  const authMethod = typeof obj.authMethod === 'string' ? obj.authMethod : '';

  if (!loggedIn) return { loggedIn: false, authMode: 'none' };
  if (authMethod === 'claude.ai') return { loggedIn: true, authMode: 'subscription' };
  if (authMethod === 'console') return { loggedIn: true, authMode: 'api-key' };
  return { loggedIn: true, authMode: 'unknown' };
}

export function parseCodexLoginStatus(statusText: string): CodexAuthStatus {
  const text = statusText.trim();
  if (/^Logged in using ChatGPT/i.test(text)) return { loggedIn: true, authMode: 'chatgpt' };
  if (/^Logged in using an API key/i.test(text)) return { loggedIn: true, authMode: 'api-key' };
  if (/^Not logged in/i.test(text)) return { loggedIn: false, authMode: 'none' };
  return { loggedIn: false, authMode: 'unknown' };
}
