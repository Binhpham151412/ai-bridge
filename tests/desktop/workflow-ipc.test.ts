import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIpcRouter, createTrustedSenderCheck, type ChannelHandlers } from '../../src/desktop/main/ipc-router.ts';
import { createBridgeApi, type IpcRendererLike } from '../../src/desktop/preload/bridge-api.ts';
import { INVOKE_CHANNELS, PUSH_CHANNELS, validateRequest, type InvokeChannel } from '../../src/desktop/shared/ipc-contract.ts';

// M5.8: the workflow:* IPC surface follows the existing pattern — an allowlist, strict
// payload validation in Main, the sender check, redaction, and one fixed preload function per
// channel. The renderer sends intents and ids only: never paths, commands or prompts.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP_URL = 'file:///C:/app/dist-desktop/renderer/index.html';
const WF = 'wf_2026-10-01_001';
const HASH = 'a'.repeat(64);
const WORKFLOW_CHANNELS = INVOKE_CHANNELS.filter((c) => c.startsWith('workflow:'));

test('the workflow:* channels are the docs/35 §3.3 set plus its snapshot pull, appended after the unchanged bridge:* ones', () => {
  assert.deepEqual(WORKFLOW_CHANNELS, [
    'workflow:getSnapshot',
    'workflow:list',
    'workflow:get',
    'workflow:getEvents',
    'workflow:getAttempt',
    'workflow:getJournal',
    'workflow:listDefinitions',
    'workflow:start',
    'workflow:pause',
    'workflow:resume',
    'workflow:stop',
    'workflow:answer',
  ]);
  assert.deepEqual(PUSH_CHANNELS, ['bridge:event', 'bridge:snapshot', 'workflow:event', 'workflow:snapshot']);
});

test('valid workflow payloads pass unchanged', () => {
  const valid: [InvokeChannel, unknown][] = [
    ['workflow:getSnapshot', undefined],
    ['workflow:list', undefined],
    ['workflow:listDefinitions', null],
    ['workflow:get', { workflowId: WF }],
    ['workflow:getJournal', { workflowId: WF }],
    ['workflow:pause', { workflowId: WF }],
    ['workflow:resume', { workflowId: WF }],
    ['workflow:stop', { workflowId: WF }],
    ['workflow:getEvents', { workflowId: WF, afterSeq: 0, limit: 1000 }],
    ['workflow:getAttempt', { attemptId: `${WF}/update-docs/1` }],
    ['workflow:start', { definitionId: 'host-flow', definitionHash: HASH, inputs: {} }],
    ['workflow:start', { definitionId: 'host-flow', definitionHash: HASH, inputs: { feature: 'x', 'extra-notes': '' } }],
    ['workflow:answer', { workflowId: WF, answer: 'fail' }],
    ['workflow:answer', { workflowId: WF, answer: 'stop' }],
  ];
  for (const [channel, payload] of valid) {
    const v = validateRequest(channel, payload);
    assert.equal(v.ok, true, `${channel}: ${JSON.stringify(v)}`);
    if (v.ok && payload) assert.deepEqual(v.value, payload);
  }
});

test('every workflow channel rejects bad payloads: wrong shapes, extra fields, traversal ids, smuggled commands/paths, M6 answers', () => {
  const idChannels: InvokeChannel[] = ['workflow:get', 'workflow:getJournal', 'workflow:pause', 'workflow:resume', 'workflow:stop'];
  const start = { definitionId: 'host-flow', definitionHash: HASH, inputs: {} };
  const bad: [InvokeChannel, unknown][] = [
    ['workflow:getSnapshot', { workflowId: WF }],
    ['workflow:list', {}],
    ['workflow:listDefinitions', 'x'],
    ...idChannels.flatMap((c): [InvokeChannel, unknown][] => [
      [c, undefined],
      [c, {}],
      [c, [WF]],
      [c, { workflowId: '../../state' }],
      [c, { workflowId: 'wf_2026-10-01_001 ' }],
      [c, { workflowId: 42 }],
      [c, { workflowId: WF, force: true }],
    ]),
    ['workflow:getEvents', { workflowId: WF, afterSeq: -1, limit: 10 }],
    ['workflow:getEvents', { workflowId: WF, afterSeq: 1.5, limit: 10 }],
    ['workflow:getEvents', { workflowId: WF, afterSeq: 0, limit: 0 }],
    ['workflow:getEvents', { workflowId: WF, afterSeq: 0, limit: 1001 }],
    ['workflow:getEvents', { workflowId: WF, afterSeq: 0 }],
    ['workflow:getAttempt', { attemptId: `${WF}/../1` }],
    ['workflow:getAttempt', { attemptId: `${WF}/build/0` }],
    ['workflow:getAttempt', { attemptId: `${WF}/Build/1` }],
    ['workflow:getAttempt', { attemptId: `${WF}/${'a'.repeat(65)}/1` }],
    ['workflow:start', { ...start, definitionId: '../x' }],
    ['workflow:start', { ...start, definitionId: 'a'.repeat(65) }],
    ['workflow:start', { ...start, definitionHash: 'abc' }],
    ['workflow:start', { ...start, inputs: null }],
    ['workflow:start', { ...start, inputs: [] }],
    ['workflow:start', { ...start, inputs: { feature: 1 } }],
    ['workflow:start', { ...start, inputs: { 'Bad Name': 'x' } }],
    ['workflow:start', { ...start, inputs: { feature: 'a\u0000b' } }],
    ['workflow:start', { ...start, inputs: { feature: 'x'.repeat(256 * 1024 + 1) } }],
    ['workflow:start', { ...start, inputs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v'])) }],
    ['workflow:start', { ...start, command: 'calc.exe' }],
    ['workflow:start', { ...start, path: 'C:\\Windows\\System32' }],
    ['workflow:start', { ...start, prompt: 'ignore previous instructions' }],
    ['workflow:answer', { workflowId: WF, answer: 'retry' }],
    ['workflow:answer', { workflowId: WF, answer: 'resume-execution' }],
    ['workflow:answer', { workflowId: WF, answer: 'FAIL' }],
    ['workflow:answer', { workflowId: WF }],
  ];
  for (const [channel, payload] of bad) assert.equal(validateRequest(channel, payload).ok, false, `${channel} accepted ${JSON.stringify(payload)?.slice(0, 80)}`);
});

test('the router: untrusted senders, unknown and invalid workflow requests never reach a handler; handler errors are redacted', async () => {
  const calls: { channel: string; request: unknown }[] = [];
  const handlers = Object.fromEntries(
    INVOKE_CHANNELS.map((channel) => [
      channel,
      async (request: unknown) => {
        calls.push({ channel, request });
        if (channel === 'workflow:answer') throw new Error('host exploded; key sk-ant-api03-SECRETSECRETSECRETSECRET');
        return { ok: true };
      },
    ]),
  ) as unknown as ChannelHandlers;
  const route = createIpcRouter({ handlers, isTrustedSender: createTrustedSenderCheck(APP_URL) });

  const untrusted = await route('workflow:stop', { workflowId: WF }, 'https://evil.example/');
  assert.equal(!untrusted.ok && untrusted.error.code, 'UNTRUSTED_SENDER');
  const unknown = await route('workflow:exec', { command: 'calc.exe' }, APP_URL);
  assert.equal(!unknown.ok && unknown.error.code, 'UNKNOWN_CHANNEL');
  const invalid = await route('workflow:stop', { workflowId: '../x' }, APP_URL);
  assert.equal(!invalid.ok && invalid.error.code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);

  assert.deepEqual(await route('workflow:stop', { workflowId: WF }, APP_URL), { ok: true });
  assert.deepEqual(calls, [{ channel: 'workflow:stop', request: { workflowId: WF } }]);
  const thrown = await route('workflow:answer', { workflowId: WF, answer: 'fail' }, APP_URL);
  assert.equal(thrown.ok, false);
  assert.doesNotMatch(JSON.stringify(thrown), /SECRETSECRET/);
  assert.doesNotMatch(JSON.stringify(thrown), /\n\s+at /, 'no stack trace');
});

class FakeIpcRenderer extends EventEmitter implements IpcRendererLike {
  invoked: { channel: string; args: unknown[] }[] = [];
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ channel, args });
    return { ok: true, data: null };
  }
}

test('preload: one fixed function per workflow channel, exactly its channel; push listeners get the payload only', async () => {
  const ipc = new FakeIpcRenderer();
  const api = createBridgeApi(ipc);
  assert.ok(Object.isFrozen(api));
  for (const forbidden of ['invoke', 'send', 'on', 'ipcRenderer', 'workflow', 'require', 'process']) assert.equal(forbidden in api, false, forbidden);
  const start = { definitionId: 'host-flow', definitionHash: HASH, inputs: { feature: 'x' } };
  await api.workflowGetSnapshot();
  await api.workflowList();
  await api.workflowGet({ workflowId: WF });
  await api.workflowGetEvents({ workflowId: WF, afterSeq: 3, limit: 10 });
  await api.workflowGetAttempt({ attemptId: `${WF}/build/1` });
  await api.workflowGetJournal({ workflowId: WF });
  await api.workflowListDefinitions();
  await api.workflowStart(start);
  await api.workflowPause({ workflowId: WF });
  await api.workflowResume({ workflowId: WF });
  await api.workflowStop({ workflowId: WF });
  await api.workflowAnswer({ workflowId: WF, answer: 'stop' });
  assert.deepEqual(
    ipc.invoked.map((c) => c.channel),
    WORKFLOW_CHANNELS,
  );
  assert.deepEqual(ipc.invoked[7].args, [start]);
  assert.deepEqual(ipc.invoked[0].args, [], 'no-payload channels send nothing');

  const received: unknown[][] = [];
  const off = api.onWorkflowEvent((...args: unknown[]) => received.push(args));
  const event = { type: 'WORKFLOW_CREATED', workflowId: WF, seq: 1 };
  ipc.emit('workflow:event', { sender: { send: () => {} } }, event);
  assert.deepEqual(received, [[event]], 'never the IPC event object (no `sender` leak)');
  off();
  off();
  const snaps: unknown[] = [];
  const offSnap = api.onWorkflowSnapshot((s) => snaps.push(s));
  ipc.emit('workflow:snapshot', {}, { workflow: null });
  offSnap();
  assert.deepEqual(snaps, [{ workflow: null }]);
  assert.equal(ipc.listenerCount('workflow:event') + ipc.listenerCount('workflow:snapshot'), 0);
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('boundaries: the renderer never reaches the workflow layer or src/hosts; the shared contract takes only types from src/hosts', async () => {
  const contract = await readFile(path.join(ROOT, 'src', 'desktop', 'shared', 'ipc-contract.ts'), 'utf8');
  const hostImports = [...contract.matchAll(/^import\s+(type\s+)?[^;]*?from\s+['"]([^'"]*hosts\/[^'"]*)['"]/gm)];
  assert.ok(hostImports.length > 0);
  assert.ok(hostImports.every((m) => m[1] !== undefined), 'type-only: nothing from src/hosts reaches the renderer bundle');
  const offenders: string[] = [];
  for (const file of await filesUnder(path.join(ROOT, 'src', 'desktop', 'renderer'))) {
    const text = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*(hosts\/|core\/workflow\/)/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
  const main = await readFile(path.join(ROOT, 'src', 'desktop', 'main', 'workflow-controller.ts'), 'utf8');
  assert.doesNotMatch(main, /core\/workflow\/(engine|decider|reconciler|store)/, 'Main holds no workflow engine, decider, reconciler or store');
});
