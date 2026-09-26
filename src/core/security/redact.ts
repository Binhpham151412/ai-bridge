/**
 * Best-effort masking of credential-shaped substrings before text is shown in a UI or
 * written to a log (M4 §24). Core never puts a secret into an event/error on purpose —
 * this is defense in depth for free-text that originates outside AI Bridge (e.g. a
 * CLI's stderr surfaced as `errorMessage`). Never used on artifacts (prompts/reports),
 * which must be shown byte-for-byte.
 */
const NAMED_ASSIGNMENT = /\b([A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|PASSWD|TOKEN)[A-Z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/g;
const CREDENTIAL_FLAG = /(--(?:api-key|token|password|secret)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g;

const TOKEN_SHAPES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(NAMED_ASSIGNMENT, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  out = out.replace(CREDENTIAL_FLAG, (_m, flag: string) => `${flag}${REDACTED}`);
  out = out.replace(BEARER, (_m, prefix: string) => `${prefix}${REDACTED}`);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}
