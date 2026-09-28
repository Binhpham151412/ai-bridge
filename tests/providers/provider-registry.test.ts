import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry, UnknownProviderError, createDefaultProviderRegistry } from '../../src/core/providers/provider-registry.ts';
import type { DiagnosticDepth, ProviderAdapter, ProviderDiagnosticContext, ProviderStatus } from '../../src/core/providers/provider-types.ts';
import { fakeContext, newLogPath, readInvocations } from './provider-test-helpers.ts';

/** In-memory adapter for a hypothetical future provider — proves the registry needs no core change. */
function futureAdapter(id: string, behaviour: { diagnose?: (ctx: ProviderDiagnosticContext, depth: DiagnosticDepth) => Promise<ProviderStatus> } = {}) {
  const calls: DiagnosticDepth[] = [];
  const adapter: ProviderAdapter = {
    descriptor: { id, displayName: `Future ${id}`, roles: ['reviewer'], capabilities: ['status-check'], executableName: id },
    diagnose: async (ctx, depth) => {
      calls.push(depth);
      if (behaviour.diagnose) return behaviour.diagnose(ctx, depth);
      return {
        provider: id,
        displayName: `Future ${id}`,
        roles: ['reviewer'],
        capabilities: ['status-check'],
        executable: `C:\\tools\\${id}.exe`,
        installation: 'INSTALLED',
        version: '1.0.0',
        authentication: { status: 'AUTHENTICATED', method: 'ACCOUNT_LOGIN', account: null, subscription: null },
        quota: { status: 'UNKNOWN', scope: null, detail: null },
        executionCheck: { status: 'NOT_RUN', durationMs: null },
        state: 'AUTHENTICATED',
        readiness: 'READY',
        diagnosticMessage: 'ok',
        errors: [],
        depth,
        checkedAt: ctx.now().toISOString(),
        durationMs: 0,
      };
    },
    loginCommand: (executable) => ({ executable, args: ['login'], displayCommand: `${id} login`, interactive: true }),
  };
  return { adapter, calls };
}

test('registry: default registry has Claude Code then Codex, and constructing it spawns nothing', async () => {
  let spawned = 0;
  const ctx = { ...fakeContext(), runCommand: async () => { spawned++; throw new Error('must not spawn'); } };
  const r = createDefaultProviderRegistry(ctx);
  assert.deepEqual(r.listProviders().map((d) => d.id), ['claude-code', 'codex']);
  assert.equal(r.has('claude-code'), true);
  assert.equal(r.has('grok'), false);
  assert.equal(r.getCachedStatus('codex'), null);
  assert.equal(spawned, 0);
});

test('registry: unknown provider id is a typed error on every entry point', async () => {
  const r = createDefaultProviderRegistry(fakeContext());
  assert.throws(() => r.getCachedStatus('nope'), UnknownProviderError);
  assert.throws(() => r.getLoginCommand('nope'), UnknownProviderError);
  await assert.rejects(r.checkProvider('nope'), (e: unknown) => e instanceof UnknownProviderError && e.providerId === 'nope' && e.code === 'UNKNOWN_PROVIDER_ID');
  await assert.rejects(r.getProviderStatus('nope'), UnknownProviderError);
});

test('registry: duplicate registration is rejected', () => {
  const r = new ProviderRegistry(fakeContext(), [futureAdapter('grok').adapter]);
  assert.throws(() => r.register(futureAdapter('grok').adapter), /already registered: grok/);
});

test('registry: getProviderStatus serves the cache; refresh/checkProvider re-run the adapter', async () => {
  const { adapter, calls } = futureAdapter('grok');
  const r = new ProviderRegistry(fakeContext(), [adapter]);
  await r.getProviderStatus('grok');
  await r.getProviderStatus('grok');
  assert.deepEqual(calls, ['status']);
  await r.getProviderStatus('grok', { refresh: true });
  await r.checkProvider('grok', { depth: 'execution' });
  assert.deepEqual(calls, ['status', 'status', 'execution']);
  assert.equal(r.getCachedStatus('grok')?.depth, 'execution', 'latest check wins');
  r.clearCache('grok');
  assert.equal(r.getCachedStatus('grok'), null);
});

test('registry: concurrent identical checks share one run; different depths do not', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const base = futureAdapter('grok');
  const { adapter, calls } = futureAdapter('grok', {
    diagnose: async (ctx, depth) => {
      await gate;
      return base.adapter.diagnose(ctx, depth);
    },
  });
  const r = new ProviderRegistry(fakeContext(), [adapter]);
  const a = r.checkProvider('grok');
  const b = r.checkProvider('grok');
  const c = r.checkProvider('grok', { depth: 'execution' });
  release();
  const [sa, sb] = await Promise.all([a, b, c]);
  assert.deepEqual(calls, ['status', 'execution']);
  assert.notEqual(sa, sb, 'each caller gets its own copy');
  assert.deepEqual(sa, sb);
});

test('registry: returned statuses are copies — mutating one does not corrupt the cache', async () => {
  const r = new ProviderRegistry(fakeContext(), [futureAdapter('grok').adapter]);
  const s = await r.getProviderStatus('grok');
  s.readiness = 'ERROR';
  s.errors.push({ code: 'PROVIDER_UNKNOWN', step: 'adapter', message: 'x', detail: null });
  const again = r.getCachedStatus('grok');
  assert.equal(again?.readiness, 'READY');
  assert.deepEqual(again?.errors, []);
});

test('registry: an adapter that throws yields an ERROR status (PROVIDER_UNKNOWN), redacted, not a rejection', async () => {
  const { adapter } = futureAdapter('broken', {
    diagnose: async () => {
      throw new Error('crashed with token=sk-ant-oat01-FAKEtokenFAKEtokenFAKE1234');
    },
  });
  const r = new ProviderRegistry(fakeContext(), [adapter]);
  const s = await r.checkProvider('broken');
  assert.equal(s.readiness, 'ERROR');
  assert.equal(s.installation, 'UNKNOWN');
  assert.deepEqual(s.errors.map((e) => [e.code, e.step]), [['PROVIDER_UNKNOWN', 'adapter']]);
  assert.doesNotMatch(JSON.stringify(s), /FAKEtoken/);
});

test('registry: an adapter that never resolves is cut off by the adapter timeout', async () => {
  const { adapter } = futureAdapter('stuck', { diagnose: () => new Promise<ProviderStatus>(() => {}) });
  const r = new ProviderRegistry(fakeContext(), [adapter], { adapterTimeoutMs: 200 });
  const s = await r.checkProvider('stuck');
  assert.equal(s.readiness, 'ERROR');
  assert.deepEqual(s.errors.map((e) => e.code), ['PROVIDER_TIMEOUT']);
});

test('registry: multiple providers — getAllProviderStatuses runs real fake CLIs, in registration order, then serves cache', async () => {
  const log = newLogPath();
  const future = futureAdapter('grok');
  const r = createDefaultProviderRegistry(fakeContext({ env: { FAKE_DIAG_LOG: log } }));
  r.register(future.adapter);
  const all = await r.getAllProviderStatuses();
  assert.deepEqual(all.map((s) => [s.provider, s.readiness]), [['claude-code', 'READY'], ['codex', 'READY'], ['grok', 'READY']]);
  const spawnedAfterFirst = readInvocations(log).length;
  assert.equal(spawnedAfterFirst, 4, 'version + auth for each of the two CLI providers');

  await r.getAllProviderStatuses();
  assert.equal(readInvocations(log).length, spawnedAfterFirst, 'cached read spawns nothing');
  await r.getAllProviderStatuses({ refresh: true });
  assert.equal(readInvocations(log).length, spawnedAfterFirst * 2);
  assert.deepEqual(future.calls, ['status', 'status']);
});

test('registry: getLoginCommand describes the official login and never runs it', async () => {
  const log = newLogPath();
  const r = createDefaultProviderRegistry(fakeContext({ env: { FAKE_DIAG_LOG: log } }));
  assert.deepEqual(r.getLoginCommand('claude-code'), { executable: null, args: ['auth', 'login', '--claudeai'], displayCommand: 'claude auth login --claudeai', interactive: true });
  assert.deepEqual(readInvocations(log), []);
  await r.checkProvider('codex');
  const codexLogin = r.getLoginCommand('codex');
  assert.equal(codexLogin?.executable, process.execPath);
  assert.deepEqual(codexLogin?.args, ['login']);
  assert.ok(!readInvocations(log).some((a) => a[0] === 'login' && a.length === 1), 'login itself is never executed');
});
