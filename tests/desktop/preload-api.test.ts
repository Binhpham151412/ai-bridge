import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBridgeApi, type IpcRendererLike } from '../../src/desktop/preload/bridge-api.ts';
import { INVOKE_CHANNELS } from '../../src/desktop/shared/ipc-contract.ts';
import type { BridgeEvent } from '../../src/core/observability/events.ts';

class FakeIpcRenderer extends EventEmitter implements IpcRendererLike {
  invoked: { channel: string; args: unknown[] }[] = [];
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ channel, args });
    return { ok: true, data: null };
  }
}

const event: BridgeEvent = { timestamp: '2026-09-26T00:00:00.000Z', runId: '2026-09-26_001', iteration: 1, phase: 'CLAUDE_EXECUTING', event: 'CLAUDE_STARTED' };

test('the exposed API is a frozen object of fixed functions — no generic invoke/send/on, no ipcRenderer', () => {
  const api = createBridgeApi(new FakeIpcRenderer());
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(Object.keys(api).sort(), [
    'discard',
    'doctor',
    'getRecentEvents',
    'getSessionArtifacts',
    'getSettings',
    'getSnapshot',
    'listSessions',
    'onEvent',
    'onSnapshot',
    'pause',
    'resume',
    'saveProjectConfig',
    'selectProject',
    'setDefaultProject',
    'start',
    'stop',
  ]);
  for (const forbidden of ['invoke', 'send', 'on', 'ipcRenderer', 'require', 'process']) assert.equal(forbidden in api, false, forbidden);
});

test('each API function invokes exactly its own allowlisted channel', async () => {
  const ipc = new FakeIpcRenderer();
  const api = createBridgeApi(ipc);
  await api.start({ task: 't' });
  await api.pause();
  await api.getSessionArtifacts({ runId: '2026-09-26_001' });
  assert.deepEqual(ipc.invoked, [
    { channel: 'bridge:start', args: [{ task: 't' }] },
    { channel: 'bridge:pause', args: [] },
    { channel: 'bridge:getSessionArtifacts', args: [{ runId: '2026-09-26_001' }] },
  ]);
  for (const call of ipc.invoked) assert.ok((INVOKE_CHANNELS as readonly string[]).includes(call.channel));
});

test('push listeners receive only the payload, never the IPC event object (no `sender` leak)', () => {
  const ipc = new FakeIpcRenderer();
  const api = createBridgeApi(ipc);
  const received: unknown[][] = [];
  api.onEvent((...args: unknown[]) => received.push(args));
  ipc.emit('bridge:event', { sender: { send: () => {} } }, event);
  assert.deepEqual(received, [[event]]);
});

test('subscribe/unsubscribe cycles never leave a listener behind; unsubscribe is idempotent', () => {
  const ipc = new FakeIpcRenderer();
  const api = createBridgeApi(ipc);
  let count = 0;
  for (let i = 0; i < 50; i++) {
    const off = api.onEvent(() => count++);
    off();
    off();
  }
  assert.equal(ipc.listenerCount('bridge:event'), 0);
  const off = api.onEvent(() => count++);
  ipc.emit('bridge:event', {}, event);
  assert.equal(count, 1, 'exactly one delivery, not one per earlier subscription');
  off();
  assert.equal(ipc.listenerCount('bridge:event'), 0);
});
