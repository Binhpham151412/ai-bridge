import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverExecutable, pickSpawnableExecutable } from '../../src/core/providers/executable-discovery.ts';
import { detectUsageLimit, isPlausibleEmail, parseVersion, safeExcerpt, sanitizePlan } from '../../src/core/providers/cli-provider.ts';

// --- executable discovery -------------------------------------------------------------

test('discovery: on Windows the first .exe wins over an earlier extension-less npm shim / .cmd', () => {
  const hits = ['C:\\npm\\claude', 'C:\\npm\\claude.cmd', 'C:\\bin\\claude.exe', 'C:\\other\\claude.exe'];
  assert.equal(pickSpawnableExecutable(hits, 'win32'), 'C:\\bin\\claude.exe');
});

test('discovery: on Windows with no .exe, falls back to the first hit; elsewhere always the first hit', () => {
  assert.equal(pickSpawnableExecutable(['C:\\npm\\claude.cmd'], 'win32'), 'C:\\npm\\claude.cmd');
  assert.equal(pickSpawnableExecutable(['/usr/local/bin/claude', '/usr/bin/claude'], 'linux'), '/usr/local/bin/claude');
  assert.equal(pickSpawnableExecutable([], 'win32'), null);
});

test('discovery: PATH result is preferred; the fallback is only consulted when PATH has nothing', async () => {
  let fallbackCalls = 0;
  const fallback = async () => {
    fallbackCalls++;
    return ['C:\\LocalAppData\\OpenAI\\Codex\\bin\\abc\\codex.exe'];
  };
  assert.equal(await discoverExecutable('codex', { where: async () => ['C:\\PATH\\codex.exe'], fallback, platform: 'win32' }), 'C:\\PATH\\codex.exe');
  assert.equal(fallbackCalls, 0);
  assert.equal(await discoverExecutable('codex', { where: async () => [], fallback, platform: 'win32' }), 'C:\\LocalAppData\\OpenAI\\Codex\\bin\\abc\\codex.exe');
});

test('discovery: a failing `where` (not found) is treated as no hits, never thrown', async () => {
  const where = async () => {
    throw new Error('INFO: Could not find files for the given pattern(s).');
  };
  assert.equal(await discoverExecutable('claude', { where, platform: 'win32' }), null);
  assert.equal(await discoverExecutable('claude', { where, fallback: async () => { throw new Error('x'); }, platform: 'win32' }), null);
});

// --- parsing helpers -----------------------------------------------------------------

test('parseVersion extracts semver from each CLI format and returns null otherwise', () => {
  assert.equal(parseVersion('2.1.161 (Claude Code)'), '2.1.161');
  assert.equal(parseVersion('codex-cli 0.155.0-alpha.16.4'), '0.155.0-alpha.16.4');
  assert.equal(parseVersion('Claude Code (dev build)'), null);
  assert.equal(parseVersion(''), null);
});

test('detectUsageLimit: recognizes plan/usage limit phrasing, with WEEKLY only when the CLI says weekly', () => {
  assert.equal(detectUsageLimit("You've hit your weekly limit · resets Oct 3")?.scope, 'WEEKLY');
  assert.equal(detectUsageLimit('Claude AI usage limit reached|1790000000')?.scope, 'UNSPECIFIED');
  assert.equal(detectUsageLimit('5-hour limit reached ∙ resets 3pm')?.scope, 'UNSPECIFIED');
  assert.equal(detectUsageLimit("You've hit your usage limit. Upgrade to Pro")?.scope, 'UNSPECIFIED');
});

test('detectUsageLimit: transient rate limiting and ordinary errors are NOT quota limits', () => {
  assert.equal(detectUsageLimit('API Error: 429 rate limit exceeded, retrying'), null);
  assert.equal(detectUsageLimit('API Error: 500 overloaded'), null);
  assert.equal(detectUsageLimit(''), null);
});

test('safeExcerpt redacts credentials, collapses whitespace and truncates', () => {
  const s = safeExcerpt('Authorization: Bearer abcdefghijklmnop123\n\n  "refresh_token": "r-123"  sk-ant-oat01-AAAAAAAAAAAAAAAA');
  assert.doesNotMatch(s, /abcdefghijklmnop123|r-123|AAAAAAAAAAAAAAAA/);
  assert.doesNotMatch(s, /\n/);
  assert.equal(safeExcerpt('x'.repeat(1000)).length, 301);
});

test('account/plan sanitizers only accept well-formed values', () => {
  assert.equal(isPlausibleEmail('user@example.com'), true);
  assert.equal(isPlausibleEmail('not an email'), false);
  assert.equal(isPlausibleEmail(42), false);
  assert.equal(sanitizePlan('Pro'), 'pro');
  assert.equal(sanitizePlan('max_20x'), 'max_20x');
  assert.equal(sanitizePlan('pro; rm -rf /'), null);
  assert.equal(sanitizePlan(undefined), null);
});
