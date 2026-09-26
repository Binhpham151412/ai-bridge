import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Text, verifyReportTransportIntegrity, verifyPromptIntegrity } from '../src/core/integrity/integrity.ts';

const hash = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

test('sha256Text matches a hand-computed sha256 over the UTF-8 bytes', () => {
  assert.equal(sha256Text('Xin chào'), hash('Xin chào'));
});

test('sha256Text is sensitive to every byte, including Vietnamese diacritics', () => {
  assert.notEqual(sha256Text('Xin chao'), sha256Text('Xin chào'));
});

test('report transport integrity passes when the hash matches and the text is verbatim in the input', () => {
  const reportText = '# AI Bridge Report\n\nSESSION_ID: s\n';
  const r = verifyReportTransportIntegrity(hash(reportText), reportText, `CLAUDE REPORT:\n${reportText}\nEND`);
  assert.equal(r.ok, true);
});

test('report transport integrity fails when the report hash does not match its own text', () => {
  const reportText = '# AI Bridge Report\n';
  const r = verifyReportTransportIntegrity('deadbeef', reportText, `...${reportText}...`);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /hash/i);
});

test('report transport integrity fails when the report text is not verbatim in what was sent', () => {
  const reportText = '# AI Bridge Report\nline two\n';
  const truncated = reportText.slice(0, 10);
  const r = verifyReportTransportIntegrity(hash(reportText), reportText, `wrapper...${truncated}...end`);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /verbatim|not (found|present)/i);
});

test('report transport integrity fails if even one character of the report was altered in transit', () => {
  const reportText = '# AI Bridge Report\nSTATUS: COMPLETE\n';
  const altered = reportText.replace('COMPLETE', 'complete');
  const r = verifyReportTransportIntegrity(hash(reportText), reportText, `wrapper...${altered}...end`);
  assert.equal(r.ok, false);
});

test('prompt integrity passes when the written text hashes to the same value as the source', () => {
  const prompt = 'Sửa `src/sum.js`\n\n```js\nexport const x = 1;\n```\n';
  const r = verifyPromptIntegrity(hash(prompt), prompt);
  assert.equal(r.ok, true);
});

test('prompt integrity fails when the written text does not match the source hash', () => {
  const prompt = 'Do the thing.';
  const r = verifyPromptIntegrity(hash(prompt), 'Do the thing');
  assert.equal(r.ok, false);
});

test('prompt integrity fails on a CRLF/LF mismatch introduced by disk round-trip', () => {
  const prompt = 'line one\nline two\n';
  const roundTripped = 'line one\r\nline two\r\n';
  const r = verifyPromptIntegrity(hash(prompt), roundTripped);
  assert.equal(r.ok, false);
});
