import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutable } from '../src/core/preflight/executable-resolver.ts';

test('returns the first path "where" reports', async () => {
  const r = await resolveExecutable('claude', { where: async () => ['C:\\Users\\me\\.local\\bin\\claude.exe', 'C:\\other\\claude.exe'] });
  assert.equal(r, 'C:\\Users\\me\\.local\\bin\\claude.exe');
});

test('returns null when "where" finds nothing and there is no fallback', async () => {
  const r = await resolveExecutable('claude', { where: async () => [] });
  assert.equal(r, null);
});

test('returns null when "where" rejects and there is no fallback', async () => {
  const r = await resolveExecutable('claude', { where: async () => { throw new Error('not found'); } });
  assert.equal(r, null);
});

test('falls back to globCodexBin for codex when "where" finds nothing', async () => {
  const r = await resolveExecutable('codex', {
    where: async () => [],
    globCodexBin: async () => ['C:\\...\\OpenAI\\Codex\\bin\\abc\\codex.exe'],
  });
  assert.equal(r, 'C:\\...\\OpenAI\\Codex\\bin\\abc\\codex.exe');
});

test('prefers "where" over the codex fallback when both find something', async () => {
  const r = await resolveExecutable('codex', {
    where: async () => ['C:\\PATH\\codex.exe'],
    globCodexBin: async () => ['C:\\...\\OpenAI\\Codex\\bin\\abc\\codex.exe'],
  });
  assert.equal(r, 'C:\\PATH\\codex.exe');
});

test('does not use the codex fallback for a different executable name', async () => {
  const r = await resolveExecutable('claude', { where: async () => [], globCodexBin: async () => ['C:\\...\\codex.exe'] });
  assert.equal(r, null);
});

test('returns null when the codex fallback also finds nothing', async () => {
  const r = await resolveExecutable('codex', { where: async () => [], globCodexBin: async () => [] });
  assert.equal(r, null);
});
