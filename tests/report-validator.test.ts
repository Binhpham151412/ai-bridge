import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportValidator } from '../src/reports/report-validator.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/reports/', import.meta.url));
const VALID_PATH = path.join(FIXTURES, 'valid-report.md');
const VALID = readFileSync(VALID_PATH, 'utf8');
const EXPECTED = { sessionId: '2026-09-25_001', iteration: 1 };

const validator = new ReportValidator();
const check = (text: string, expected = EXPECTED) => validator.validateBuffer(Buffer.from(text, 'utf8'), expected);
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

test('accepts a complete report and extracts its fields', () => {
  const r = check(VALID);
  assert.deepEqual(codes(r), []);
  assert.equal(r.valid, true);
  assert.deepEqual(r.fields, { sessionId: '2026-09-25_001', iteration: 1, reportStatus: 'COMPLETE', nextAction: 'CONTINUE' });
});

test('rejects the fixture report that has no REPORT_STATUS', () => {
  const r = validator.validateBuffer(readFileSync(path.join(FIXTURES, 'missing-report-status.md')), EXPECTED);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MISSING_FIELD:REPORT_STATUS'), codes(r).join());
});

for (const [field, line] of [
  ['SESSION_ID', 'SESSION_ID: 2026-09-25_001'],
  ['ITERATION', 'ITERATION: 1'],
  ['NEXT_ACTION', 'NEXT_ACTION: CONTINUE'],
] as const) {
  test(`rejects a report without ${field}`, () => {
    const r = check(VALID.replace(`${line}\n`, ''));
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes(`MISSING_FIELD:${field}`), codes(r).join());
  });
}

test('rejects REPORT_STATUS other than COMPLETE', () => {
  const r = check(VALID.replace('REPORT_STATUS: COMPLETE', 'REPORT_STATUS: PARTIAL'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('INVALID_VALUE:REPORT_STATUS'), codes(r).join());
});

test('rejects NEXT_ACTION outside CONTINUE, DONE, NEED_HUMAN', () => {
  const r = check(VALID.replace('NEXT_ACTION: CONTINUE', 'NEXT_ACTION: MAYBE'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('INVALID_VALUE:NEXT_ACTION'), codes(r).join());
});

for (const action of ['DONE', 'NEED_HUMAN'] as const) {
  test(`accepts NEXT_ACTION ${action}`, () => {
    const r = check(VALID.replace('NEXT_ACTION: CONTINUE', `NEXT_ACTION: ${action}`));
    assert.equal(r.valid, true, codes(r).join());
    assert.equal(r.fields?.nextAction, action);
  });
}

test('rejects a non-numeric ITERATION', () => {
  const r = check(VALID.replace('ITERATION: 1', 'ITERATION: one'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('INVALID_VALUE:ITERATION'), codes(r).join());
});

test('rejects a report written for another session', () => {
  const r = check(VALID, { sessionId: '2026-09-25_002', iteration: 1 });
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('SESSION_MISMATCH'), codes(r).join());
});

test('rejects a report written for another iteration', () => {
  const r = check(VALID, { sessionId: '2026-09-25_001', iteration: 2 });
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('ITERATION_MISMATCH'), codes(r).join());
});

test('rejects a report with the wrong header', () => {
  const r = check(VALID.replace('# AI Bridge Report', '# Report'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('BAD_HEADER'), codes(r).join());
});

test('rejects an empty or whitespace-only file', () => {
  for (const buf of [Buffer.alloc(0), Buffer.from('  \n\r\n\t\n', 'utf8')]) {
    const r = validator.validateBuffer(buf, EXPECTED);
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes('EMPTY'), codes(r).join());
  }
});

test('rejects bytes that are not valid UTF-8', () => {
  const r = validator.validateBuffer(Buffer.concat([Buffer.from(VALID, 'utf8'), Buffer.from([0xff, 0xfe])]), EXPECTED);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('INVALID_UTF8'), codes(r).join());
});

test('rejects a report containing NUL characters', () => {
  const r = check(VALID.replace('None.', 'None.\u0000'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('CONTAINS_NUL'), codes(r).join());
});

test('rejects a report larger than maxBytes', () => {
  const r = new ReportValidator({ maxBytes: 100 }).validateBuffer(Buffer.from(VALID, 'utf8'), EXPECTED);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('TOO_LARGE'), codes(r).join());
});

test('rejects duplicated header fields', () => {
  const r = check(VALID.replace('NEXT_ACTION: CONTINUE\n', 'NEXT_ACTION: CONTINUE\nNEXT_ACTION: DONE\n'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('DUPLICATE_FIELD:NEXT_ACTION'), codes(r).join());
});

test('ignores field-like lines inside sections', () => {
  const r = check(VALID.replace('None. Ghi chú', 'NEXT_ACTION: DONE\nREPORT_STATUS: PARTIAL\nNone. Ghi chú'));
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.fields?.nextAction, 'CONTINUE');
});

test('rejects a report missing a required section', () => {
  const r = check(VALID.replace('## TESTS\n', ''));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MISSING_SECTION:TESTS'), codes(r).join());
});

test('rejects required sections out of order', () => {
  const swapped = VALID.replace('## TASK', '## TMP').replace('## CHANGES', '## TASK').replace('## TMP', '## CHANGES');
  const r = check(swapped);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('SECTION_ORDER'), codes(r).join());
});

test('rejects a report cut off inside a code block', () => {
  const r = check(VALID.slice(0, VALID.indexOf('✔ sum adds')));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('TRUNCATED:UNCLOSED_CODE_FENCE'), codes(r).join());
});

test('rejects a report whose last section is empty', () => {
  const r = check(VALID.slice(0, VALID.indexOf('Add input validation')));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('TRUNCATED:EMPTY_LAST_SECTION'), codes(r).join());
});

test('accepts a UTF-8 byte order mark before the header', () => {
  const r = validator.validateBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VALID, 'utf8')]), EXPECTED);
  assert.equal(r.valid, true, codes(r).join());
});

test('accepts CRLF line endings', () => {
  const r = check(VALID.replace(/\n/g, '\r\n'));
  assert.equal(r.valid, true, codes(r).join());
});

test('validateFile reports a missing file', async () => {
  const r = await validator.validateFile(path.join(FIXTURES, 'does-not-exist.md'), EXPECTED);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('REPORT_MISSING'), codes(r).join());
});

test('validateFile returns the exact text and its sha256', async () => {
  const r = await validator.validateFile(VALID_PATH, EXPECTED);
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.text, VALID);
  assert.equal(r.sha256, createHash('sha256').update(readFileSync(VALID_PATH)).digest('hex'));
});

// validateFile's size check happens via stat() BEFORE the file is read into memory —
// verifying this matters for large/pathological files (see docs/09-m3.5-electron-preparation-report.md).
async function withTmpReport<T>(bytes: number, fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-report-size-'));
  try {
    const filePath = path.join(dir, 'report.md');
    await writeFile(filePath, Buffer.alloc(bytes, 'x'));
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('validateFile accepts a normal-sized report (well under maxBytes)', () =>
  withTmpReport(50, async (filePath) => {
    // Not a valid report contract, but small enough to pass the size gate and reach
    // content validation — the point of this test is the size check, not the contract.
    const r = await new ReportValidator({ maxBytes: 100 }).validateFile(filePath, EXPECTED);
    assert.ok(!codes(r).includes('TOO_LARGE'), codes(r).join());
  }));

test('validateFile accepts a report exactly at maxBytes', () =>
  withTmpReport(100, async (filePath) => {
    const r = await new ReportValidator({ maxBytes: 100 }).validateFile(filePath, EXPECTED);
    assert.ok(!codes(r).includes('TOO_LARGE'), codes(r).join());
  }));

test('validateFile rejects a report over maxBytes via stat(), without reading its content', () =>
  withTmpReport(101, async (filePath) => {
    const r = await new ReportValidator({ maxBytes: 100 }).validateFile(filePath, EXPECTED);
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes('TOO_LARGE'), codes(r).join());
    assert.equal(r.text, null, 'an oversized report must not have its content read into the result');
  }));

test('validateFile still reports REPORT_MISSING for a file that does not exist, with a size limit configured', () =>
  withTmpReport(10, async (filePath) => {
    const missingPath = path.join(path.dirname(filePath), 'does-not-exist-either.md');
    const r = await new ReportValidator({ maxBytes: 100 }).validateFile(missingPath, EXPECTED);
    assert.ok(codes(r).includes('REPORT_MISSING'), codes(r).join());
  }));
