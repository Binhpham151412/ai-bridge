import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, REDACTED } from '../src/core/security/redact.ts';

test('masks credential-named env assignments but keeps the variable name', () => {
  const out = redactSecrets('failed: ANTHROPIC_API_KEY=sk-ant-abc123def456ghi and OPENAI_API_KEY: "xyz789"');
  assert.ok(!out.includes('abc123def456ghi'));
  assert.ok(!out.includes('xyz789'));
  assert.match(out, /ANTHROPIC_API_KEY=\[REDACTED\]/);
  assert.match(out, /OPENAI_API_KEY: \[REDACTED\]/);
});

test('masks command-line credential flags and bearer tokens', () => {
  const out = redactSecrets('tool --api-key abcdef123456 --token=qwerty987 -H "Authorization: Bearer abc.def.ghi-123456"');
  assert.ok(!out.includes('abcdef123456'));
  assert.ok(!out.includes('qwerty987'));
  assert.ok(!out.includes('abc.def.ghi-123456'));
});

test('masks well-known token shapes anywhere in free text', () => {
  const out = redactSecrets('key sk-proj-AAAAAAAAAAAAAAAAAAAA and ghp_BBBBBBBBBBBBBBBBBBBBBBBB here');
  assert.equal(out, `key ${REDACTED} and ${REDACTED} here`);
});

test('leaves ordinary text (paths, error codes, ids) untouched', () => {
  const text = 'CLAUDE_RUN_FAILED:TIMEOUT at D:\\proj\\.ai-bridge\\reports\\001-report.md session 11cff1b5-2313-41e2-b9ef-db4ddc6f5bd1';
  assert.equal(redactSecrets(text), text);
});
