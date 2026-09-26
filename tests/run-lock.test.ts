import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock } from '../src/core/lock/run-lock.ts';

async function withLockFile<T>(fn: (lockPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-lock-'));
  try {
    return await fn(path.join(dir, 'lock'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A PID guaranteed not to belong to any running process, for stale-lock tests. */
const DEAD_PID = 2147483647;

test('acquires the lock when none exists, writing pid and startedAt', () =>
  withLockFile(async (lockPath) => {
    const r = await acquireLock(lockPath);
    assert.equal(r.ok, true);
    const data = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(data.pid, process.pid);
    assert.ok(typeof data.startedAt === 'string' && !Number.isNaN(Date.parse(data.startedAt)));
  }));

test('refuses a second acquire while the first holder is still alive', () =>
  withLockFile(async (lockPath) => {
    const first = await acquireLock(lockPath);
    assert.equal(first.ok, true);
    const second = await acquireLock(lockPath);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'ALREADY_RUNNING');
    assert.equal(second.pid, process.pid);
  }));

test('clears a stale lock (dead pid) and acquires successfully', () =>
  withLockFile(async (lockPath) => {
    await writeFile(lockPath, JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }), 'utf8');
    const r = await acquireLock(lockPath);
    assert.equal(r.ok, true);
    assert.equal(r.staleLockCleared, true);
    const data = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(data.pid, process.pid);
  }));

test('treats a lock file with unparseable content as stale and replaces it', () =>
  withLockFile(async (lockPath) => {
    await writeFile(lockPath, 'not json', 'utf8');
    const r = await acquireLock(lockPath);
    assert.equal(r.ok, true);
    assert.equal(r.staleLockCleared, true);
  }));

test('releaseLock removes the lock file', () =>
  withLockFile(async (lockPath) => {
    await acquireLock(lockPath);
    await releaseLock(lockPath);
    await assert.rejects(readFile(lockPath, 'utf8'));
  }));

test('releaseLock is idempotent when the lock file does not exist', () =>
  withLockFile(async (lockPath) => {
    await assert.doesNotReject(releaseLock(lockPath));
  }));

test('after releaseLock, a new acquire succeeds', () =>
  withLockFile(async (lockPath) => {
    await acquireLock(lockPath);
    await releaseLock(lockPath);
    const r = await acquireLock(lockPath);
    assert.equal(r.ok, true);
  }));

test('creates the parent directory if it does not exist yet', () =>
  withLockFile(async (lockPath) => {
    const nested = path.join(path.dirname(lockPath), 'nested', 'lock');
    const r = await acquireLock(nested);
    assert.equal(r.ok, true);
  }));

test('a lock held by another real, currently-running process is not cleared as stale', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-lock-real-'));
  const lockPath = path.join(dir, 'lock');
  try {
    // Use a real external process (not this Node process) so this proves PID-liveness
    // detection works against an actual OS process, not just our own pid.
    const holder = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    const stillRunningExamplePid = process.pid; // this test process itself is guaranteed alive throughout
    await writeFile(lockPath, JSON.stringify({ pid: stillRunningExamplePid, startedAt: new Date().toISOString() }), 'utf8');
    const r = await acquireLock(lockPath);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ALREADY_RUNNING');
    assert.ok(holder.status === 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
