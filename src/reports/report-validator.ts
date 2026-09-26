import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export type NextAction = 'CONTINUE' | 'DONE' | 'NEED_HUMAN';

export interface ReportExpectation {
  sessionId: string;
  iteration: number;
}

export interface ReportFields {
  sessionId: string;
  iteration: number;
  reportStatus: 'COMPLETE';
  nextAction: NextAction;
}

export interface ReportIssue {
  code: string;
  message: string;
}

export interface ReportValidationResult {
  valid: boolean;
  errors: ReportIssue[];
  fields: ReportFields | null;
  text: string | null;
  sha256: string | null;
  bytes: number;
}

export interface ReportValidatorOptions {
  maxBytes?: number;
}

const HEADER = '# AI Bridge Report';
const FIELD_NAMES = ['SESSION_ID', 'ITERATION', 'REPORT_STATUS', 'NEXT_ACTION'] as const;
const REQUIRED_SECTIONS = ['TASK', 'CHANGES', 'TESTS', 'ISSUES', 'NEXT_RECOMMENDATION'] as const;
const NEXT_ACTIONS: readonly string[] = ['CONTINUE', 'DONE', 'NEED_HUMAN'];
const DEFAULT_MAX_BYTES = 256 * 1024;
const FENCE = /^\s*(```|~~~)/;

/**
 * Validates a Claude report against the M1 report contract.
 * It never modifies the report: an invalid report is reported, not repaired.
 */
export class ReportValidator {
  private readonly maxBytes: number;

  constructor(options: ReportValidatorOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async validateFile(filePath: string, expected: ReportExpectation): Promise<ReportValidationResult> {
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return { valid: false, errors: [issue('REPORT_MISSING', `Report file not found or unreadable: ${filePath}`)], fields: null, text: null, sha256: null, bytes: 0 };
    }
    // Rejects an oversized file by its size alone, before ever reading its content into
    // memory — a stat() is cheap regardless of file size, unlike readFile(). See
    // docs/09-m3.5-electron-preparation-report.md.
    if (size > this.maxBytes) {
      return { valid: false, errors: [issue('TOO_LARGE', `Report is ${size} bytes; limit is ${this.maxBytes}`)], fields: null, text: null, sha256: null, bytes: size };
    }

    let buffer: Buffer;
    try {
      buffer = await readFile(filePath);
    } catch {
      return { valid: false, errors: [issue('REPORT_MISSING', `Report file not found or unreadable: ${filePath}`)], fields: null, text: null, sha256: null, bytes: 0 };
    }
    return this.validateBuffer(buffer, expected);
  }

  validateBuffer(buffer: Uint8Array, expected: ReportExpectation): ReportValidationResult {
    const bytes = buffer.byteLength;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const fail = (errors: ReportIssue[], text: string | null): ReportValidationResult =>
      ({ valid: false, errors, fields: null, text, sha256, bytes });

    if (bytes > this.maxBytes) return fail([issue('TOO_LARGE', `Report is ${bytes} bytes; limit is ${this.maxBytes}`)], null);

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return fail([issue('INVALID_UTF8', 'Report is not valid UTF-8')], null);
    }
    if (text.trim() === '') return fail([issue('EMPTY', 'Report is empty')], text);

    const errors: ReportIssue[] = [];
    if (text.includes('\u0000')) errors.push(issue('CONTAINS_NUL', 'Report contains NUL characters'));

    const lines = text.split(/\r?\n/);
    const firstLine = lines.find((l) => l.trim() !== '') ?? '';
    if (firstLine.trimEnd() !== HEADER) errors.push(issue('BAD_HEADER', `First line must be "${HEADER}"`));

    const fields = parseFields(lines, errors);
    if (fields) {
      if (fields.sessionId !== expected.sessionId) {
        errors.push(issue('SESSION_MISMATCH', `SESSION_ID is ${fields.sessionId}; expected ${expected.sessionId}`));
      }
      if (fields.iteration !== expected.iteration) {
        errors.push(issue('ITERATION_MISMATCH', `ITERATION is ${fields.iteration}; expected ${expected.iteration}`));
      }
    }
    checkSections(lines, errors);

    return { valid: errors.length === 0, errors, fields, text, sha256, bytes };
  }
}

function issue(code: string, message: string): ReportIssue {
  return { code, message };
}

/** Reads the four contract fields from the header block (everything before the first "## " heading). */
function parseFields(lines: string[], errors: ReportIssue[]): ReportFields | null {
  const firstSection = lines.findIndex((l) => l.startsWith('## '));
  const headerBlock = firstSection === -1 ? lines : lines.slice(0, firstSection);
  const values = new Map<string, string[]>();
  for (const line of headerBlock) {
    const m = /^([A-Z_]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m && (FIELD_NAMES as readonly string[]).includes(m[1])) {
      values.set(m[1], [...(values.get(m[1]) ?? []), m[2]]);
    }
  }

  let ok = true;
  const single = (name: string): string | null => {
    const found = values.get(name) ?? [];
    if (found.length === 0) errors.push(issue(`MISSING_FIELD:${name}`, `Missing field ${name}`));
    if (found.length > 1) errors.push(issue(`DUPLICATE_FIELD:${name}`, `Field ${name} appears ${found.length} times`));
    if (found.length !== 1) ok = false;
    return found.length === 1 ? found[0] : null;
  };
  const sessionId = single('SESSION_ID');
  const iteration = single('ITERATION');
  const reportStatus = single('REPORT_STATUS');
  const nextAction = single('NEXT_ACTION');

  const invalid = (name: string, value: string) => {
    errors.push(issue(`INVALID_VALUE:${name}`, `Invalid ${name}: "${value}"`));
    ok = false;
  };
  if (sessionId !== null && sessionId === '') invalid('SESSION_ID', sessionId);
  if (iteration !== null && !/^\d+$/.test(iteration)) invalid('ITERATION', iteration);
  if (reportStatus !== null && reportStatus !== 'COMPLETE') invalid('REPORT_STATUS', reportStatus);
  if (nextAction !== null && !NEXT_ACTIONS.includes(nextAction)) invalid('NEXT_ACTION', nextAction);

  if (!ok || sessionId === null || iteration === null || nextAction === null) return null;
  return { sessionId, iteration: Number(iteration), reportStatus: 'COMPLETE', nextAction: nextAction as NextAction };
}

/** Required sections: present exactly once, in order; last one non-empty; code fences balanced. */
function checkSections(lines: string[], errors: ReportIssue[]): void {
  const headings: { name: string; line: number }[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return;
    }
    const m = inFence ? null : /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m) headings.push({ name: m[1], line: i });
  });
  if (inFence) errors.push(issue('TRUNCATED:UNCLOSED_CODE_FENCE', 'A code block is never closed; the report looks cut off'));

  const positions: number[] = [];
  for (const name of REQUIRED_SECTIONS) {
    const found = headings.filter((h) => h.name === name);
    if (found.length === 0) errors.push(issue(`MISSING_SECTION:${name}`, `Missing section ## ${name}`));
    if (found.length > 1) errors.push(issue(`DUPLICATE_SECTION:${name}`, `Section ## ${name} appears ${found.length} times`));
    if (found.length === 1) positions.push(found[0].line);
  }
  if (positions.some((p, i) => i > 0 && p < positions[i - 1])) {
    errors.push(issue('SECTION_ORDER', `Sections must appear in order: ${REQUIRED_SECTIONS.join(', ')}`));
  }

  const last = headings.filter((h) => h.name === REQUIRED_SECTIONS[REQUIRED_SECTIONS.length - 1]);
  if (last.length === 1) {
    const next = headings.find((h) => h.line > last[0].line);
    const body = lines.slice(last[0].line + 1, next ? next.line : lines.length);
    if (body.every((l) => l.trim() === '')) {
      errors.push(issue('TRUNCATED:EMPTY_LAST_SECTION', 'The last section is empty; the report looks cut off'));
    }
  }
}
