import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeProvider, parseOpenCodeCredentialCount } from '../../src/core/providers/opencode-provider.ts';
import { fakeContext, newLogPath, readInvocations } from './provider-test-helpers.ts';

const adapter = createOpenCodeProvider();
const result = (stdout: string) => ({ stdout }) as never;

test('descriptor: an executor with a status check and a login command, no execution probe', () => {
  assert.equal(adapter.descriptor.id, 'opencode');
  assert.deepEqual(adapter.descriptor.roles, ['executor']);
  assert.ok(!adapter.descriptor.capabilities.includes('execution-probe'));
  assert.equal(adapter.loginCommand('C:\\x\\opencode.exe')?.displayCommand, 'opencode auth login');
});

test('credential count is read through the colour codes; nothing else is parsed', () => {
  assert.equal(parseOpenCodeCredentialCount(result('\u001b[90m└\u001b[39m  8 credentials\n')), 8);
  assert.equal(parseOpenCodeCredentialCount(result('1 credential')), 1);
  assert.equal(parseOpenCodeCredentialCount(result('0 credentials')), 0);
  assert.equal(parseOpenCodeCredentialCount(result('no count here')), null);
});

test('installed + credentials → READY, version read, no model call, no account/plan invented', async () => {
  const s = await adapter.diagnose(fakeContext(), 'status');
  assert.equal(s.state, 'AUTHENTICATED');
  assert.equal(s.readiness, 'READY');
  assert.equal(s.version, '1.14.30');
  assert.equal(s.authentication.status, 'AUTHENTICATED');
  assert.equal(s.authentication.account, null);
  assert.equal(s.authentication.subscription, null);
  assert.equal(s.quota.status, 'UNKNOWN');
  assert.match(s.diagnosticMessage, /not verified that a model answers/);
  assert.deepEqual(s.errors, []);
});

test('only --version and auth list are ever run, even at execution depth', async () => {
  const log = newLogPath();
  await adapter.diagnose(fakeContext({ env: { FAKE_DIAG_LOG: log } }), 'execution');
  assert.deepEqual(readInvocations(log), [['--version'], ['auth', 'list']]);
});

test('not installed → NOT_INSTALLED without spawning anything', async () => {
  const s = await adapter.diagnose(fakeContext({ installed: false }), 'status');
  assert.equal(s.state, 'NOT_INSTALLED');
  assert.equal(s.installation, 'NOT_INSTALLED');
  assert.deepEqual(s.errors.map((e) => e.code), ['PROVIDER_NOT_INSTALLED']);
});

test('zero credentials → installed but not authenticated; the message names the login command', async () => {
  const s = await adapter.diagnose(fakeContext({ env: { FAKE_DIAG_AUTH: 'none' } }), 'status');
  assert.equal(s.state, 'INSTALLED_NOT_AUTHENTICATED');
  assert.equal(s.readiness, 'NOT_READY');
  assert.match(s.diagnosticMessage, /opencode auth login/);
});

test('unreadable or failing auth list → UNKNOWN / ERROR, never a guess', async () => {
  const bad = await adapter.diagnose(fakeContext({ env: { FAKE_DIAG_AUTH: 'malformed' } }), 'status');
  assert.equal(bad.readiness, 'UNKNOWN');
  assert.deepEqual(bad.errors.map((e) => e.code), ['PROVIDER_OUTPUT_INVALID']);
  const failed = await adapter.diagnose(fakeContext({ env: { FAKE_DIAG_AUTH: 'fail' } }), 'status');
  assert.equal(failed.readiness, 'ERROR');
  assert.deepEqual(failed.errors.map((e) => e.code), ['PROVIDER_COMMAND_FAILED']);
});

test('an unrecognizable version does not block readiness', async () => {
  const s = await adapter.diagnose(fakeContext({ env: { FAKE_DIAG_VERSION: 'malformed' } }), 'status');
  assert.equal(s.version, null);
  assert.equal(s.readiness, 'READY');
  assert.deepEqual(s.errors.map((e) => e.code), ['PROVIDER_OUTPUT_INVALID']);
});
