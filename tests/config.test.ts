import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig, loadConfig } from '../src/core/config/config.ts';

test('the defaults match the values given in the spec', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    maxIterations: 10,
    claudeTimeoutMs: 1_800_000,
    codexTimeoutMs: 600_000,
    reportMaxBytes: 1_048_576,
    stopOnUncommittedChanges: false,
    requireGitRepository: false,
  });
});

test('accepts a fully specified valid config', () => {
  const raw = { maxIterations: 5, claudeTimeoutMs: 60000, codexTimeoutMs: 30000, reportMaxBytes: 2048, stopOnUncommittedChanges: true, requireGitRepository: true };
  const r = validateConfig(raw);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config, raw);
});

test('accepts an empty object and fills in every default', () => {
  const r = validateConfig({});
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config, DEFAULT_CONFIG);
});

test('accepts a partial config, keeping defaults for the rest', () => {
  const r = validateConfig({ maxIterations: 3 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.maxIterations, 3);
  assert.equal(r.config.claudeTimeoutMs, DEFAULT_CONFIG.claudeTimeoutMs);
});

for (const bad of [0, -1, 1.5, Infinity, NaN, 'ten', null]) {
  test(`rejects maxIterations = ${String(bad)}`, () => {
    const r = validateConfig({ maxIterations: bad });
    assert.ok(r.errors.some((e) => e.includes('maxIterations')), r.errors.join(';'));
  });
}

test('rejects maxIterations above the sanity cap (no unbounded/infinite loops)', () => {
  const r = validateConfig({ maxIterations: 100000 });
  assert.ok(r.errors.some((e) => e.includes('maxIterations')));
});

for (const field of ['claudeTimeoutMs', 'codexTimeoutMs', 'reportMaxBytes'] as const) {
  test(`rejects a negative ${field}`, () => {
    const r = validateConfig({ [field]: -1 });
    assert.ok(r.errors.some((e) => e.includes(field)), r.errors.join(';'));
  });
  test(`rejects a non-number ${field}`, () => {
    const r = validateConfig({ [field]: 'soon' });
    assert.ok(r.errors.some((e) => e.includes(field)), r.errors.join(';'));
  });
}

for (const field of ['stopOnUncommittedChanges', 'requireGitRepository'] as const) {
  test(`rejects a non-boolean ${field}`, () => {
    const r = validateConfig({ [field]: 'yes' });
    assert.ok(r.errors.some((e) => e.includes(field)), r.errors.join(';'));
  });
}

test('rejects an unknown top-level key instead of silently ignoring a typo', () => {
  const r = validateConfig({ maxIteratons: 5 });
  assert.ok(r.errors.some((e) => e.includes('maxIteratons')), r.errors.join(';'));
});

test('rejects a non-object config (array, string, null)', () => {
  for (const bad of [[], 'x', null, 42]) {
    const r = validateConfig(bad);
    assert.ok(r.errors.length > 0, JSON.stringify(bad));
  }
});

test('loadConfig returns defaults when the file does not exist', async () => {
  const r = await loadConfig('/nonexistent/config.json', { readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config, DEFAULT_CONFIG);
});

test('loadConfig parses and validates the file when it exists', async () => {
  const r = await loadConfig('/proj/.ai-bridge/config.json', { readFile: async () => JSON.stringify({ maxIterations: 3 }) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.maxIterations, 3);
});

test('loadConfig reports an error for invalid JSON instead of crashing', async () => {
  const r = await loadConfig('/proj/.ai-bridge/config.json', { readFile: async () => 'not json' });
  assert.ok(r.errors.length > 0);
});

test('loadConfig reports schema errors from a parsed-but-invalid file', async () => {
  const r = await loadConfig('/proj/.ai-bridge/config.json', { readFile: async () => JSON.stringify({ maxIterations: -5 }) });
  assert.ok(r.errors.some((e) => e.includes('maxIterations')));
});
