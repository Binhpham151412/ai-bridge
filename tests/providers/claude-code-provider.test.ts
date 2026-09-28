import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeCodeProvider } from '../../src/core/providers/claude-code-provider.ts';
import type { DiagnosticDepth, ProviderStatus } from '../../src/core/providers/provider-types.ts';
import { fakeContext, newLogPath, readInvocations, type FakeContextOptions } from './provider-test-helpers.ts';

const claude = createClaudeCodeProvider();

function diagnose(env: Record<string, string> = {}, depth: DiagnosticDepth = 'status', opts: FakeContextOptions = {}): Promise<ProviderStatus> {
  return claude.diagnose(fakeContext({ ...opts, env: { ...opts.env, ...env } }), depth);
}

const codes = (s: ProviderStatus) => s.errors.map((e) => e.code);

// --- installation / version ---------------------------------------------------

test('claude: installed + subscription login → READY at status depth, quota left UNKNOWN', async () => {
  const s = await diagnose();
  assert.equal(s.provider, 'claude-code');
  assert.equal(s.installation, 'INSTALLED');
  assert.equal(s.executable, process.execPath);
  assert.equal(s.version, '2.1.161');
  assert.deepEqual(s.authentication, { status: 'AUTHENTICATED', method: 'ACCOUNT_LOGIN', account: 'user@example.com', subscription: 'pro' });
  assert.equal(s.readiness, 'READY');
  assert.equal(s.state, 'AUTHENTICATED');
  assert.deepEqual(s.quota, { status: 'UNKNOWN', scope: null, detail: null });
  assert.equal(s.executionCheck.status, 'NOT_RUN');
  assert.deepEqual(s.errors, []);
  assert.equal(s.depth, 'status');
  assert.equal(s.checkedAt, '2026-09-27T12:00:00.000Z');
  assert.match(s.diagnosticMessage, /quota was not checked/);
});

test('claude: not on PATH → NOT_INSTALLED / NOT_READY without spawning anything', async () => {
  const log = newLogPath();
  const s = await diagnose({ FAKE_DIAG_LOG: log }, 'execution', { installed: false });
  assert.equal(s.installation, 'NOT_INSTALLED');
  assert.equal(s.state, 'NOT_INSTALLED');
  assert.equal(s.readiness, 'NOT_READY');
  assert.equal(s.executable, null);
  assert.equal(s.authentication.status, 'UNKNOWN');
  assert.deepEqual(codes(s), ['PROVIDER_NOT_INSTALLED']);
  assert.deepEqual(readInvocations(log), []);
});

test('claude: unrecognizable version output → version null + OUTPUT_INVALID, readiness unaffected', async () => {
  const s = await diagnose({ FAKE_DIAG_VERSION: 'malformed' });
  assert.equal(s.version, null);
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_OUTPUT_INVALID', 'version']]);
  assert.equal(s.readiness, 'READY');
});

test('claude: --version non-zero exit → COMMAND_FAILED on the version step', async () => {
  const s = await diagnose({ FAKE_DIAG_VERSION: 'fail' });
  assert.equal(s.version, null);
  assert.equal(s.errors[0].code, 'PROVIDER_COMMAND_FAILED');
  assert.match(s.errors[0].detail ?? '', /exit code 3/);
});

// --- authentication -------------------------------------------------------------

test('claude: logged out (exit 1 with valid JSON) → INSTALLED_NOT_AUTHENTICATED, with login hint', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'logged-out' });
  assert.equal(s.authentication.status, 'NOT_AUTHENTICATED');
  assert.equal(s.authentication.method, 'NONE');
  assert.equal(s.state, 'INSTALLED_NOT_AUTHENTICATED');
  assert.equal(s.readiness, 'NOT_READY');
  assert.deepEqual(codes(s), ['PROVIDER_NOT_AUTHENTICATED']);
  assert.match(s.diagnosticMessage, /claude auth login --claudeai/);
});

test('claude: account/plan stay null when the CLI does not print them', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'no-email' });
  assert.equal(s.authentication.account, null);
  assert.equal(s.authentication.subscription, null);
  assert.equal(s.readiness, 'READY');
});

test('claude: Console/API-key login → AUTHENTICATED_BUT_NOT_READY (cost guard)', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'console' });
  assert.equal(s.authentication.status, 'AUTHENTICATED');
  assert.equal(s.authentication.method, 'API_KEY');
  assert.equal(s.state, 'AUTHENTICATED_BUT_NOT_READY');
  assert.equal(s.readiness, 'NOT_READY');
  assert.deepEqual(codes(s), ['PROVIDER_AUTH_MODE_UNSUPPORTED']);
});

test('claude: unrecognized authMethod → readiness UNKNOWN, not READY', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'unknown-method' });
  assert.equal(s.authentication.method, 'UNKNOWN');
  assert.equal(s.readiness, 'UNKNOWN');
});

test('claude: non-JSON auth output with exit 0 → OUTPUT_INVALID, auth UNKNOWN', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'malformed' });
  assert.equal(s.authentication.status, 'UNKNOWN');
  assert.equal(s.authentication.account, null, 'never scrapes an email out of free text');
  assert.equal(s.readiness, 'UNKNOWN');
  assert.equal(s.state, 'UNKNOWN');
  assert.deepEqual(codes(s), ['PROVIDER_OUTPUT_INVALID']);
});

test('claude: JSON that is not the documented object → OUTPUT_INVALID', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'not-object' });
  assert.deepEqual(codes(s), ['PROVIDER_OUTPUT_INVALID']);
});

test('claude: auth status non-zero exit without JSON → COMMAND_FAILED / ERROR', async () => {
  const s = await diagnose({ FAKE_DIAG_AUTH: 'fail' });
  assert.equal(s.readiness, 'ERROR');
  assert.deepEqual(codes(s), ['PROVIDER_COMMAND_FAILED']);
  assert.match(s.errors[0].detail ?? '', /exit code 2/);
});

test('claude: auth status hangs → PROVIDER_TIMEOUT / ERROR, returns promptly', async () => {
  const started = Date.now();
  const s = await diagnose({ FAKE_DIAG_AUTH: 'hang' }, 'status', { statusTimeoutMs: 1500 });
  assert.equal(s.readiness, 'ERROR');
  assert.deepEqual(codes(s), ['PROVIDER_TIMEOUT']);
  assert.ok(Date.now() - started < 8000, 'hung CLI must not hang the diagnosis');
});

test('claude: ANTHROPIC_API_KEY in env → NOT_READY; names the var, never its value', async () => {
  const s = await diagnose({ ANTHROPIC_API_KEY: 'sk-ant-api03-SHOULDNEVERAPPEAR1234567890' });
  assert.equal(s.readiness, 'NOT_READY');
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_AUTH_MODE_UNSUPPORTED', 'environment']]);
  assert.match(s.diagnosticMessage, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(JSON.stringify(s), /SHOULDNEVERAPPEAR/);
});

// --- execution probe / quota ------------------------------------------------------

test('claude: status depth never runs the execution probe', async () => {
  const log = newLogPath();
  await diagnose({ FAKE_DIAG_LOG: log });
  assert.deepEqual(readInvocations(log), [['--version'], ['auth', 'status']]);
});

test('claude: execution probe passes → READY, quota AVAILABLE, check PASSED; probe is tool-less and non-persistent', async () => {
  const log = newLogPath();
  const s = await diagnose({ FAKE_DIAG_LOG: log }, 'execution');
  assert.equal(s.readiness, 'READY');
  assert.equal(s.executionCheck.status, 'PASSED');
  assert.equal(s.quota.status, 'AVAILABLE');
  const probeArgv = readInvocations(log)[2];
  assert.deepEqual(probeArgv, ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '']);
});

test('claude: weekly limit reported by the CLI → LIMITED with WEEKLY scope', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'weekly-limit' }, 'execution');
  assert.equal(s.readiness, 'LIMITED');
  assert.equal(s.state, 'AUTHENTICATED_BUT_NOT_READY');
  assert.equal(s.authentication.subscription, 'pro');
  assert.equal(s.quota.status, 'LIMITED');
  assert.equal(s.quota.scope, 'WEEKLY');
  assert.match(s.quota.detail ?? '', /weekly limit/);
  assert.equal(s.executionCheck.status, 'LIMITED');
  assert.deepEqual(codes(s), ['PROVIDER_QUOTA_LIMIT']);
});

test('claude: "usage limit reached" → LIMITED with UNSPECIFIED scope', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'limit' }, 'execution');
  assert.equal(s.readiness, 'LIMITED');
  assert.equal(s.quota.scope, 'UNSPECIFIED');
});

test('claude: a non-limit is_error result → ERROR / COMMAND_FAILED, not LIMITED', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'is-error' }, 'execution');
  assert.equal(s.readiness, 'ERROR');
  assert.equal(s.quota.status, 'UNKNOWN');
  assert.deepEqual(codes(s), ['PROVIDER_COMMAND_FAILED']);
  assert.match(s.errors[0].detail ?? '', /500 overloaded/);
});

test('claude: probe prints no result event → OUTPUT_INVALID', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'malformed' }, 'execution');
  assert.equal(s.readiness, 'ERROR');
  assert.deepEqual(codes(s), ['PROVIDER_OUTPUT_INVALID']);
});

test('claude: probe non-zero exit → COMMAND_FAILED', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'fail' }, 'execution');
  assert.equal(s.executionCheck.status, 'FAILED');
  assert.deepEqual(codes(s), ['PROVIDER_COMMAND_FAILED']);
});

test('claude: probe hangs → PROVIDER_TIMEOUT', async () => {
  const s = await diagnose({ FAKE_DIAG_PROBE: 'hang' }, 'execution', { probeTimeoutMs: 1500 });
  assert.equal(s.readiness, 'ERROR');
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_TIMEOUT', 'probe']]);
});

test('claude: execution depth skips the probe when not logged in or when an API-key env var is set', async () => {
  const cases: Record<string, string>[] = [{ FAKE_DIAG_AUTH: 'logged-out' }, { FAKE_DIAG_AUTH: 'console' }, { ANTHROPIC_AUTH_TOKEN: 'x-y-z' }];
  for (const env of cases) {
    const log = newLogPath();
    const s = await diagnose({ ...env, FAKE_DIAG_LOG: log }, 'execution');
    assert.equal(s.executionCheck.status, 'SKIPPED');
    assert.ok(!readInvocations(log).some((a) => a[0] === '-p'), `probe must not run for ${JSON.stringify(env)}`);
  }
});

// --- redaction -----------------------------------------------------------------------

test('claude: credentials in CLI output never reach the status', async () => {
  const secrets = [/FAKEtoken/, /fakebearervalue/, /fake-refresh-value/];
  const statuses = [
    await diagnose({ FAKE_DIAG_AUTH: 'secret' }),
    await diagnose({ FAKE_DIAG_AUTH: 'extra-secrets' }, 'status'),
    await diagnose({ FAKE_DIAG_PROBE: 'secret' }, 'execution'),
  ];
  for (const s of statuses) {
    const json = JSON.stringify(s);
    for (const re of secrets) assert.doesNotMatch(json, re);
  }
  assert.match(statuses[0].errors[0].detail ?? '', /\[REDACTED\]/);
  assert.equal(statuses[1].authentication.subscription, 'max');
});
