import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestStop } from '../src/core/process-manager/process-manager.ts';
import { killProcessTree } from '../src/automation/process-runner.ts';

const SLEEP_FOREVER = fileURLToPath(new URL('./fixtures/process/sleep-forever.mjs', import.meta.url));

function fakeDeps(overrides: Partial<Parameters<typeof requestStop>[1]> = {}) {
  return {
    isPidAlive: () => false,
    attemptGraceful: async () => {},
    forceKill: async () => {},
    sleep: async () => {},
    ...overrides,
  };
}

test('returns NOT_RUNNING immediately when the pid is already dead, without attempting anything', async () => {
  let gracefulCalled = false;
  const r = await requestStop(123, fakeDeps({ isPidAlive: () => false, attemptGraceful: async () => { gracefulCalled = true; } }), { gracefulTimeoutMs: 100, pollIntervalMs: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'NOT_RUNNING');
  assert.equal(gracefulCalled, false);
});

test('reports GRACEFUL_STOP when the process dies on its own within the timeout', async () => {
  let alive = true;
  setTimeout(() => { alive = false; }, 30);
  const r = await requestStop(123, fakeDeps({ isPidAlive: () => alive, sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)) }), {
    gracefulTimeoutMs: 500,
    pollIntervalMs: 10,
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'GRACEFUL_STOP');
});

test('escalates to force-kill when the process is still alive after the graceful timeout', async () => {
  let forceKillCalled = false;
  let alive = true;
  const r = await requestStop(
    123,
    fakeDeps({
      isPidAlive: () => alive,
      sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
      forceKill: async () => {
        forceKillCalled = true;
        alive = false;
      },
    }),
    { gracefulTimeoutMs: 50, pollIntervalMs: 10 },
  );
  assert.equal(forceKillCalled, true);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'FORCE_KILLED');
});

test('reports STOP_FAILED when even force-kill does not make the pid go away', async () => {
  const r = await requestStop(123, fakeDeps({ isPidAlive: () => true, sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)) }), {
    gracefulTimeoutMs: 30,
    pollIntervalMs: 10,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'STOP_FAILED');
});

test('always reports the pid that was targeted', async () => {
  const r = await requestStop(999, fakeDeps({ isPidAlive: () => false }), { gracefulTimeoutMs: 10, pollIntervalMs: 5 });
  assert.equal(r.pid, 999);
});

test('real process: a stuck process that ignores graceful attempts is still force-killed', async () => {
  const child = spawn(process.execPath, [SLEEP_FOREVER], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid!;
  try {
    const isPidAlive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    const r = await requestStop(
      pid,
      {
        isPidAlive,
        attemptGraceful: async () => {}, // does nothing — sleep-forever.mjs has no signal handler, simulating a stuck process
        forceKill: async (p: number) => killProcessTree(p),
        sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
      },
      { gracefulTimeoutMs: 3000, pollIntervalMs: 100 },
    );
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'FORCE_KILLED');
    assert.equal(isPidAlive(pid), false, 'the real OS process must actually be dead now');
  } finally {
    try {
      killProcessTree(pid);
    } catch {
      // already dead, ignore
    }
  }
});
