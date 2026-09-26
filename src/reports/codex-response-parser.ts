import { createHash } from 'node:crypto';

export type BridgeStatus = 'CONTINUE' | 'DONE' | 'NEED_HUMAN';

export interface ParseIssue {
  code: string;
  message: string;
}

export interface CodexParseResult {
  valid: boolean;
  errors: ParseIssue[];
  status: BridgeStatus | null;
  prompt: string | null;
  raw: string;
  sha256: string;
}

const OPEN = '<AI_BRIDGE_RESPONSE>';
const CLOSE = '</AI_BRIDGE_RESPONSE>';
const STATUSES: readonly string[] = ['CONTINUE', 'DONE', 'NEED_HUMAN'];

/**
 * Parses a Codex reviewer response against the M1 AI_BRIDGE_RESPONSE contract.
 * On any ambiguity it reports an error rather than guessing: the orchestrator
 * must STOP on a malformed response, never repair or reinterpret one.
 */
export class CodexResponseParser {
  parse(raw: string): CodexParseResult {
    const sha256 = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
    const fail = (errors: ParseIssue[]): CodexParseResult => ({ valid: false, errors, status: null, prompt: null, raw, sha256 });

    const opens = countOccurrences(raw, OPEN);
    const closes = countOccurrences(raw, CLOSE);
    if (opens === 0 && closes === 0) return fail([issue('NO_RESPONSE_BLOCK', 'No <AI_BRIDGE_RESPONSE> block found')]);
    if (opens > 1 || closes > 1) return fail([issue('MULTIPLE_RESPONSE_BLOCKS', `Found ${opens} opening and ${closes} closing <AI_BRIDGE_RESPONSE> tags`)]);

    const openAt = raw.indexOf(OPEN);
    const closeAt = raw.indexOf(CLOSE);
    if (opens !== 1 || closes !== 1 || closeAt < openAt + OPEN.length) {
      return fail([issue('MALFORMED_RESPONSE_BLOCK', 'The <AI_BRIDGE_RESPONSE> block is not well-formed')]);
    }

    const before = raw.slice(0, openAt);
    const after = raw.slice(closeAt + CLOSE.length);
    const outsideTagPattern = /<\/?(AI_BRIDGE_RESPONSE|STATUS|PROMPT)>/;
    if (outsideTagPattern.test(before) || outsideTagPattern.test(after)) {
      return fail([issue('TAG_OUTSIDE_BLOCK', 'Found a STATUS/PROMPT/AI_BRIDGE_RESPONSE tag outside the response block')]);
    }

    const body = raw.slice(openAt + OPEN.length, closeAt);
    const errors: ParseIssue[] = [];

    const status = extractStatus(body, errors);
    const prompt = extractPrompt(body, errors);

    return { valid: errors.length === 0, errors, status: errors.length === 0 ? status : null, prompt: errors.length === 0 ? prompt : null, raw, sha256 };
  }
}

function issue(code: string, message: string): ParseIssue {
  return { code, message };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

/**
 * Locates exactly one open/close tag pair. Returns null (with an error pushed)
 * for: tag absent entirely (MISSING), more than one open or close (MULTIPLE),
 * or present-but-not-exactly-one-well-formed-pair (MALFORMED, via `malformedCode`).
 */
function locateTagPair(
  body: string,
  openTag: string,
  closeTag: string,
  missingCode: string,
  multipleCode: string,
  malformedCode: string,
  errors: ParseIssue[],
): { openAt: number; closeAt: number } | null {
  const opens = countOccurrences(body, openTag);
  const closes = countOccurrences(body, closeTag);
  if (opens === 0 && closes === 0) {
    errors.push(issue(missingCode, `Missing ${openTag} tag`));
    return null;
  }
  if (opens > 1 || closes > 1) {
    errors.push(issue(multipleCode, `Found ${opens} ${openTag} and ${closes} ${closeTag} tags`));
    return null;
  }
  if (opens !== 1 || closes !== 1) {
    errors.push(issue(malformedCode, `The ${openTag} tag is not well-formed`));
    return null;
  }
  const openAt = body.indexOf(openTag);
  const closeAt = body.indexOf(closeTag);
  if (closeAt < openAt + openTag.length) {
    errors.push(issue(malformedCode, `The ${openTag} tag is not well-formed`));
    return null;
  }
  return { openAt, closeAt };
}

function extractStatus(body: string, errors: ParseIssue[]): BridgeStatus | null {
  const loc = locateTagPair(body, '<STATUS>', '</STATUS>', 'MISSING_STATUS', 'MULTIPLE_STATUS', 'MISSING_STATUS', errors);
  if (!loc) return null;
  const value = body.slice(loc.openAt + '<STATUS>'.length, loc.closeAt).trim();
  if (!STATUSES.includes(value)) {
    errors.push(issue('INVALID_STATUS', `Invalid STATUS: "${value}"`));
    return null;
  }
  return value as BridgeStatus;
}

function extractPrompt(body: string, errors: ParseIssue[]): string | null {
  const loc = locateTagPair(body, '<PROMPT>', '</PROMPT>', 'MISSING_PROMPT', 'MULTIPLE_PROMPT', 'MALFORMED_PROMPT', errors);
  if (!loc) return null;
  let inner = body.slice(loc.openAt + '<PROMPT>'.length, loc.closeAt);
  // Strip exactly one newline (or CRLF) at each boundary, per the "PROMPT preservation" rule.
  inner = inner.replace(/^\r\n|^\n/, '').replace(/\r\n$|\n$/, '');
  if (inner.trim() === '') {
    errors.push(issue('EMPTY_PROMPT', 'PROMPT must not be empty'));
    return null;
  }
  return inner;
}
