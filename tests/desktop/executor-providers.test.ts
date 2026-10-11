import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorProviderService } from '../../src/desktop/main/executor-providers.ts';
import { createDefaultProviderRegistry } from '../../src/core/providers/provider-registry.ts';
import { EXECUTOR_PROVIDERS } from '../../src/core/executor/executor-adapter.ts';
import { validateRequest } from '../../src/desktop/shared/ipc-contract.ts';
import { fakeContext, newLogPath, readInvocations } from '../providers/provider-test-helpers.ts';

// docs/64 — Main's detection of the executor CLIs. Fake CLIs only.

test('providers:list reports every executor, in the picker order, and never the reviewer', async () => {
  const res = await new ExecutorProviderService(createDefaultProviderRegistry(fakeContext())).list();
  assert.ok(res.ok);
  assert.deepEqual(res.data.map((p) => p.id), [...EXECUTOR_PROVIDERS]);
  assert.ok(!res.data.some((p) => (p.id as string) === 'codex'));
  const claude = res.data[0];
  assert.deepEqual([claude.installed, claude.ready, claude.version], [true, true, '2.1.161']);
  const opencode = res.data[1];
  assert.deepEqual([opencode.displayName, opencode.installed, opencode.ready, opencode.version], ['OpenCode', true, true, '1.14.30']);
  assert.match(opencode.message, /2 stored credentials/);
  assert.equal(opencode.loginHint, 'opencode auth login');
  assert.match(opencode.modelHint, /provider\/model/);
});

test('a missing CLI is reported as not installed (and not ready), without hiding the other', async () => {
  const ctx = fakeContext();
  const onlyClaude = { ...ctx, locateExecutable: async (name: string) => (name === 'opencode' ? null : process.execPath) };
  const res = await new ExecutorProviderService(createDefaultProviderRegistry(onlyClaude)).list();
  assert.ok(res.ok);
  assert.deepEqual(res.data.map((p) => [p.id, p.installed, p.ready]), [['claude-code', true, true], ['opencode', false, false]]);
  assert.match(res.data[1].message, /not found on PATH/);
});

test('every call checks again (so "just installed / just logged in" shows up) and only runs status commands', async () => {
  const log = newLogPath();
  const service = new ExecutorProviderService(createDefaultProviderRegistry(fakeContext({ env: { FAKE_DIAG_LOG: log } })));
  await service.list();
  const first = readInvocations(log);
  await service.list();
  assert.equal(readInvocations(log).length, first.length * 2);
  assert.ok(!first.some((argv) => argv.includes('-p') || argv.includes('run') || argv.includes('exec')), 'no model-calling command is ever run');
  assert.ok(!first.some((argv) => argv[0] === 'codex'), 'the reviewer is not probed for the executor picker');
});

test('the providers:list channel takes no payload', () => {
  assert.equal(validateRequest('providers:list', undefined).ok, true);
  assert.equal(validateRequest('providers:list', { refresh: true }).ok, false);
});
