import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireWorkflowLock, readWorkflowLockOwner, releaseWorkflowLock, workflowLockPath } from '../../src/core/workflow/workflow-lock.ts';
import { acquireLock, releaseLock } from '../../src/core/lock/run-lock.ts';

const DEAD_PID = 2147483647;

async function withAiBridgeDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-wf-lock-'));
  try {
    return await fn(path.join(root, '.ai-bridge'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the workflow lock lives at .ai-bridge/state/workflow-lock, separate from the run lock', () =>
  withAiBridgeDir(async (dir) => {
    assert.equal(workflowLockPath(dir), path.join(dir, 'state', 'workflow-lock'));
    assert.notEqual(workflowLockPath(dir), path.join(dir, 'state', 'lock'));
  }));

test('acquire writes our pid; a second acquire while we are alive is refused', () =>
  withAiBridgeDir(async (dir) => {
    const first = await acquireWorkflowLock(dir);
    assert.equal(first.ok, true);
    assert.equal(JSON.parse(await readFile(workflowLockPath(dir), 'utf8')).pid, process.pid);
    const second = await acquireWorkflowLock(dir);
    assert.deepEqual(second, { ok: false, reason: 'ALREADY_RUNNING', pid: process.pid });
    assert.equal((await readWorkflowLockOwner(dir))?.pid, process.pid);
  }));

test('a lock left by a dead process is cleared (pid-based, never age-based)', () =>
  withAiBridgeDir(async (dir) => {
    await mkdir(path.dirname(workflowLockPath(dir)), { recursive: true });
    await writeFile(workflowLockPath(dir), JSON.stringify({ pid: DEAD_PID, startedAt: '2000-01-01T00:00:00.000Z' }), 'utf8');
    const r = await acquireWorkflowLock(dir);
    assert.equal(r.ok, true);
    assert.equal(r.staleLockCleared, true);
    assert.equal((await readWorkflowLockOwner(dir))?.pid, process.pid);
  }));

test('release removes the lock; the owner is then unknown', () =>
  withAiBridgeDir(async (dir) => {
    await acquireWorkflowLock(dir);
    await releaseWorkflowLock(dir);
    await assert.rejects(stat(workflowLockPath(dir)));
    assert.equal(await readWorkflowLockOwner(dir), null);
  }));

test('holding the workflow lock never blocks or clears the BridgeEngine run lock', () =>
  withAiBridgeDir(async (dir) => {
    const runLock = path.join(dir, 'state', 'lock');
    assert.equal((await acquireWorkflowLock(dir)).ok, true);
    assert.equal((await acquireLock(runLock)).ok, true);
    await releaseWorkflowLock(dir);
    assert.equal(JSON.parse(await readFile(runLock, 'utf8')).pid, process.pid, 'run lock untouched');
    await releaseLock(runLock);
  }));
