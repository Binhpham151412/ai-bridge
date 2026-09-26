import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVOKE_CHANNELS, isInvokeChannel, validateRequest, type InvokeChannel } from '../../src/desktop/shared/ipc-contract.ts';
import { createIpcRouter, createTrustedSenderCheck, type ChannelHandlers } from '../../src/desktop/main/ipc-router.ts';

const APP_URL = 'file:///C:/app/dist-desktop/renderer/index.html';

function recordingHandlers() {
  const calls: { channel: InvokeChannel; request: unknown }[] = [];
  const handlers = Object.fromEntries(
    INVOKE_CHANNELS.map((channel) => [
      channel,
      async (request: unknown) => {
        calls.push({ channel, request });
        return { ok: true, data: null, message: 'handled' };
      },
    ]),
  ) as unknown as ChannelHandlers;
  return { calls, handlers };
}

function router(handlers: ChannelHandlers) {
  return createIpcRouter({ handlers, isTrustedSender: createTrustedSenderCheck(APP_URL) });
}

// ---------------------------------------------------------------------------
// contract validation
// ---------------------------------------------------------------------------

test('the allowlist is exactly the documented bridge:* channels', () => {
  assert.equal(INVOKE_CHANNELS.length, 14);
  for (const c of INVOKE_CHANNELS) assert.match(c, /^bridge:[a-zA-Z]+$/);
  assert.equal(isInvokeChannel('bridge:start'), true);
  for (const bad of ['bridge:exec', 'shell:openExternal', 'bridge:start ', '', null, 42, {}]) assert.equal(isInvokeChannel(bad), false);
});

test('start: accepts a task (+ optional integer maxIterations) and nothing else', () => {
  assert.deepEqual(validateRequest('bridge:start', { task: 'do it' }), { ok: true, value: { task: 'do it' } });
  assert.deepEqual(validateRequest('bridge:start', { task: 'do it', maxIterations: 3 }), { ok: true, value: { task: 'do it', maxIterations: 3 } });
  for (const bad of [
    undefined,
    'do it',
    [],
    { task: '' },
    { task: '   ' },
    { task: 5 },
    { task: 'x'.repeat(20_001) },
    { task: 'a\u0000b' },
    { task: 'x', maxIterations: 0 },
    { task: 'x', maxIterations: 1.5 },
    { task: 'x', maxIterations: 1001 },
    { task: 'x', maxIterations: '3' },
    { task: 'x', command: 'rm -rf /' },
    { task: 'x', projectPath: 'C:\\Windows' },
  ]) {
    assert.equal(validateRequest('bridge:start', bad).ok, false, JSON.stringify(bad));
  }
});

test('payload-less channels reject any payload (no smuggled arguments)', () => {
  for (const channel of ['bridge:pause', 'bridge:resume', 'bridge:stop', 'bridge:discard', 'bridge:doctor', 'bridge:selectProject', 'bridge:getSnapshot'] as const) {
    assert.equal(validateRequest(channel, undefined).ok, true);
    assert.equal(validateRequest(channel, { pid: 1234 }).ok, false, channel);
    assert.equal(validateRequest(channel, 'C:\\').ok, false, channel);
  }
});

test('session artifacts: runId must be YYYY-MM-DD_NNN — path traversal is rejected before Core is reached', () => {
  assert.equal(validateRequest('bridge:getSessionArtifacts', { runId: '2026-09-26_001' }).ok, true);
  for (const runId of ['../../state', '2026-09-26_001/..', 'C:\\x', '2026-09-26_1', '', 7]) {
    assert.equal(validateRequest('bridge:getSessionArtifacts', { runId }).ok, false, String(runId));
  }
});

test('recent events limit, config object and default-project flag are validated', () => {
  assert.equal(validateRequest('bridge:getRecentEvents', { limit: 100 }).ok, true);
  assert.equal(validateRequest('bridge:getRecentEvents', { limit: 0 }).ok, false);
  assert.equal(validateRequest('bridge:getRecentEvents', { limit: 100_000 }).ok, false);
  assert.equal(validateRequest('bridge:saveProjectConfig', { config: { maxIterations: 3 } }).ok, true);
  assert.equal(validateRequest('bridge:saveProjectConfig', { config: [] }).ok, false);
  assert.equal(validateRequest('bridge:saveProjectConfig', { config: {}, extra: 1 }).ok, false);
  assert.equal(validateRequest('bridge:setDefaultProject', { clear: false }).ok, true);
  assert.equal(validateRequest('bridge:setDefaultProject', { path: 'D:\\x' }).ok, false);
});

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

test('router: a valid request reaches exactly its handler with the validated payload', async () => {
  const { calls, handlers } = recordingHandlers();
  const res = await router(handlers)('bridge:start', { task: 'hello', maxIterations: 2 }, APP_URL);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ channel: 'bridge:start', request: { task: 'hello', maxIterations: 2 } }]);
});

test('router: unknown channels are rejected and no handler runs', async () => {
  const { calls, handlers } = recordingHandlers();
  for (const channel of ['bridge:exec', 'child_process:spawn', 'bridge:__proto__', 'constructor', 42]) {
    const res = await router(handlers)(channel, undefined, APP_URL);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'UNKNOWN_CHANNEL');
  }
  assert.equal(calls.length, 0);
});

test('router: invalid payloads are rejected with INVALID_REQUEST and no handler runs', async () => {
  const { calls, handlers } = recordingHandlers();
  const res = await router(handlers)('bridge:start', { task: '' }, APP_URL);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('router: requests from anything but the bundled renderer page are rejected', async () => {
  const { calls, handlers } = recordingHandlers();
  for (const sender of [undefined, 'https://evil.example/', 'file:///C:/other/index.html', 'devtools://devtools/bundled/index.html']) {
    const res = await router(handlers)('bridge:getSnapshot', undefined, sender);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'UNTRUSTED_SENDER');
  }
  assert.equal((await router(handlers)('bridge:getSnapshot', undefined, `${APP_URL}#/sessions`)).ok, true, 'hash is ignored');
  assert.equal(calls.length, 1);
});

test('router: a throwing handler becomes a redacted UNEXPECTED error — never a raw exception/stack', async () => {
  const { handlers } = recordingHandlers();
  handlers['bridge:doctor'] = async () => {
    throw new Error('boom ANTHROPIC_API_KEY=sk-ant-supersecretvalue123');
  };
  const res = await router(handlers)('bridge:doctor', undefined, APP_URL);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.code, 'UNEXPECTED');
    assert.ok(!JSON.stringify(res).includes('supersecretvalue'));
    assert.ok(!JSON.stringify(res).includes('    at '), 'no stack trace');
  }
});

test('router: error responses from handlers are redacted too', async () => {
  const { handlers } = recordingHandlers();
  handlers['bridge:stop'] = async () => ({ ok: false, error: { code: 'X', title: 't', message: 'm', details: 'token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
  const res = await router(handlers)('bridge:stop', undefined, APP_URL);
  assert.ok(!JSON.stringify(res).includes('ghp_AAAA'));
});
