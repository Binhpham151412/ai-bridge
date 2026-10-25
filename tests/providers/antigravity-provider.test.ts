import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAntigravityProvider } from '../../src/core/providers/antigravity-provider.ts';
import { fakeContext, newLogPath, readInvocations } from './provider-test-helpers.ts';

const adapter = createAntigravityProvider();

test('descriptor: an executor with only a status check; the login "command" is agy itself', () => {
  assert.equal(adapter.descriptor.id, 'antigravity');
  assert.deepEqual(adapter.descriptor.roles, ['executor']);
  assert.deepEqual(adapter.descriptor.capabilities, ['status-check']);
  assert.equal(adapter.descriptor.executableName, 'agy');
  assert.equal(adapter.loginCommand('C:\\x\\agy.exe')?.displayCommand, 'agy');
});

test('installed → version read, and the sign-in is UNKNOWN (not guessed): agy has no status command', async () => {
  const s = await adapter.diagnose(fakeContext(), 'status');
  assert.equal(s.installation, 'INSTALLED');
  assert.equal(s.version, '1.3.4');
  assert.equal(s.authentication.status, 'UNKNOWN');
  assert.equal(s.readiness, 'UNKNOWN');
  assert.equal(s.state, 'UNKNOWN');
  assert.deepEqual(s.errors, []);
  assert.match(s.diagnosticMessage, /no sign-in status command/);
  assert.match(s.diagnosticMessage, /No model was called/);
});

test('only --version is ever run, even at execution depth (a model call is never made)', async () => {
  const log = newLogPath();
  await adapter.diagnose(fakeContext({ env: { FAKE_DIAG_LOG: log } }), 'execution');
  assert.deepEqual(readInvocations(log), [['--version']]);
});

test('not installed → NOT_INSTALLED without spawning anything', async () => {
  const s = await adapter.diagnose(fakeContext({ installed: false }), 'status');
  assert.equal(s.state, 'NOT_INSTALLED');
  assert.deepEqual(s.errors.map((e) => e.code), ['PROVIDER_NOT_INSTALLED']);
});

test('a failing or unreadable --version is recorded, never fatal', async () => {
  const bad = await adapter.diagnose(fakeContext({ env: { FAKE_DIAG_VERSION: 'malformed' } }), 'status');
  assert.equal(bad.version, null);
  assert.deepEqual(bad.errors.map((e) => e.code), ['PROVIDER_OUTPUT_INVALID']);
  const failed = await adapter.diagnose(fakeContext({ env: { FAKE_DIAG_VERSION: 'fail' } }), 'status');
  assert.deepEqual(failed.errors.map((e) => e.code), ['PROVIDER_COMMAND_FAILED']);
  assert.equal(failed.installation, 'INSTALLED');
});
