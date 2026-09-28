import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexProvider } from '../../src/core/providers/codex-provider.ts';
import type { DiagnosticDepth, ProviderStatus } from '../../src/core/providers/provider-types.ts';
import { fakeContext, newLogPath, readInvocations, type FakeContextOptions } from './provider-test-helpers.ts';

const codex = createCodexProvider();

function diagnose(env: Record<string, string> = {}, depth: DiagnosticDepth = 'status', opts: FakeContextOptions = {}): Promise<ProviderStatus> {
  return codex.diagnose(fakeContext({ ...opts, env: { ...opts.env, ...env } }), depth);
}

const codes = (s: ProviderStatus) => s.errors.map((e) => e.code);

test('codex: installed + ChatGPT login (stderr) → READY; account/plan not exposed so null', async () => {
  const s = await diagnose();
  assert.equal(s.provider, 'codex');
  assert.equal(s.displayName, 'ChatGPT / Codex');
  assert.deepEqual(s.roles, ['reviewer']);
  assert.equal(s.installation, 'INSTALLED');
  assert.equal(s.executable, process.execPath);
  assert.equal(s.version, '0.155.0-alpha.16.4');
  assert.deepEqual(s.authentication, { status: 'AUTHENTICATED', method: 'ACCOUNT_LOGIN', account: null, subscription: null });
  assert.equal(s.readiness, 'READY');
  assert.equal(s.state, 'AUTHENTICATED');
  assert.equal(s.quota.status, 'UNKNOWN');
  assert.deepEqual(s.errors, []);
});

test('codex: not found → NOT_INSTALLED / NOT_READY without spawning', async () => {
  const log = newLogPath();
  const s = await diagnose({ FAKE_DIAG_LOG: log }, 'status', { installed: false });
  assert.equal(s.installation, 'NOT_INSTALLED');
  assert.equal(s.readiness, 'NOT_READY');
  assert.deepEqual(codes(s), ['PROVIDER_NOT_INSTALLED']);
  assert.match(s.diagnosticMessage, /\(codex\) was not found/);
  assert.deepEqual(readInvocations(log), []);
});

test('codex: unrecognizable version → version null + OUTPUT_INVALID (non-blocking)', async () => {
  const s = await diagnose({ FAKE_DIAG_VERSION: 'malformed' });
  assert.equal(s.version, null);
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_OUTPUT_INVALID', 'version']]);
  assert.equal(s.readiness, 'READY');
});

test('codex: --version hangs → TIMEOUT on version step, auth still evaluated', async () => {
  const s = await diagnose({ FAKE_DIAG_VERSION: 'hang' }, 'status', { statusTimeoutMs: 1500 });
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_TIMEOUT', 'version']]);
  assert.equal(s.authentication.status, 'AUTHENTICATED');
});

test('codex: "Not logged in" → INSTALLED_NOT_AUTHENTICATED with "codex login" hint', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'logged-out' });
  assert.equal(s.authentication.status, 'NOT_AUTHENTICATED');
  assert.equal(s.state, 'INSTALLED_NOT_AUTHENTICATED');
  assert.equal(s.readiness, 'NOT_READY');
  assert.deepEqual(codes(s), ['PROVIDER_NOT_AUTHENTICATED']);
  assert.match(s.diagnosticMessage, /Log in with: codex login/);
});

test('codex: API-key login → NOT_READY (cost guard), and the key it prints is not echoed', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'api-key' });
  assert.equal(s.authentication.method, 'API_KEY');
  assert.equal(s.state, 'AUTHENTICATED_BUT_NOT_READY');
  assert.deepEqual(codes(s), ['PROVIDER_AUTH_MODE_UNSUPPORTED']);
  assert.doesNotMatch(JSON.stringify(s), /FAKEtoken/);
});

test('codex: unrecognized login text with exit 0 → OUTPUT_INVALID / UNKNOWN', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'malformed' });
  assert.equal(s.authentication.status, 'UNKNOWN');
  assert.equal(s.readiness, 'UNKNOWN');
  assert.deepEqual(codes(s), ['PROVIDER_OUTPUT_INVALID']);
});

test('codex: login status non-zero exit → COMMAND_FAILED / ERROR', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'fail' });
  assert.equal(s.readiness, 'ERROR');
  assert.deepEqual(codes(s), ['PROVIDER_COMMAND_FAILED']);
  assert.match(s.errors[0].detail ?? '', /exit code 2/);
});

test('codex: login status hangs → TIMEOUT / ERROR', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'hang' }, 'status', { statusTimeoutMs: 1500 });
  assert.equal(s.readiness, 'ERROR');
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_TIMEOUT', 'auth']]);
});

test('codex: OPENAI_API_KEY in env → NOT_READY on the environment step', async () => {
  const s = await diagnose({ OPENAI_API_KEY: 'sk-proj-SHOULDNEVERAPPEAR1234567890' });
  assert.equal(s.readiness, 'NOT_READY');
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_AUTH_MODE_UNSUPPORTED', 'environment']]);
  assert.doesNotMatch(JSON.stringify(s), /SHOULDNEVERAPPEAR/);
});

test('codex: execution probe passes → READY / PASSED; uses read-only, ephemeral exec with stdin prompt', async () => {
  const log = newLogPath();
  const s = await diagnose({ FAKE_DIAG_LOG: log }, 'execution');
  assert.equal(s.readiness, 'READY');
  assert.equal(s.executionCheck.status, 'PASSED');
  assert.equal(s.quota.status, 'AVAILABLE');
  assert.deepEqual(readInvocations(log), [
    ['--version'],
    ['login', 'status'],
    ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-'],
  ]);
});

test('codex: weekly usage limit → LIMITED / WEEKLY', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'weekly-limit' }, 'execution');
  assert.equal(s.readiness, 'LIMITED');
  assert.equal(s.quota.status, 'LIMITED');
  assert.equal(s.quota.scope, 'WEEKLY');
  assert.deepEqual(codes(s), ['PROVIDER_QUOTA_LIMIT']);
});

test('codex: usage limit without a scope → LIMITED / UNSPECIFIED', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'limit' }, 'execution');
  assert.equal(s.readiness, 'LIMITED');
  assert.equal(s.quota.scope, 'UNSPECIFIED');
});

test('codex: probe output without turn.completed (exit 0) → OUTPUT_INVALID', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'malformed' }, 'execution');
  assert.equal(s.readiness, 'ERROR');
  assert.deepEqual(codes(s), ['PROVIDER_OUTPUT_INVALID']);
});

test('codex: probe non-zero exit → COMMAND_FAILED', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'fail' }, 'execution');
  assert.equal(s.executionCheck.status, 'FAILED');
  assert.deepEqual(codes(s), ['PROVIDER_COMMAND_FAILED']);
});

test('codex: probe hangs → TIMEOUT', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'hang' }, 'execution', { probeTimeoutMs: 1500 });
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_TIMEOUT', 'probe']]);
});

test('codex: credentials in CLI output never reach the status', async () => {
  const statuses = [await diagnose({ FAKE_DIAG_AUTH: 'secret' }), await diagnose({ FAKE_DIAG_PROBE: 'secret' }, 'execution')];
  for (const s of statuses) {
    const json = JSON.stringify(s);
    for (const re of [/FAKEtoken/, /fakebearervalue/, /fake-refresh-value/]) assert.doesNotMatch(json, re);
  }
  assert.match(statuses[0].errors[0].detail ?? '', /\[REDACTED\]/);
  assert.match(statuses[1].errors[0].detail ?? '', /\[REDACTED\]/);
});
