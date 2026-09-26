import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AcquireLockResult {
  ok: boolean;
  reason?: 'ALREADY_RUNNING';
  pid?: number;
  staleLockCleared?: boolean;
}

interface LockData {
  pid: number;
  startedAt: string;
}

/** True if `pid` belongs to a process we can currently see running on this machine. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // no such process
    if (code === 'EPERM') return true; // exists, we just can't signal it
    return true; // unknown error: fail safe, assume alive rather than clobber a real lock
  }
}

function writeOwnLock(lockPath: string): Promise<void> {
  const data: LockData = { pid: process.pid, startedAt: new Date().toISOString() };
  return writeFile(lockPath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Acquires `.ai-bridge/state/lock` so two `ai-bridge start` runs can never overlap on
 * the same project. A lock left behind by a process that is no longer running (crash,
 * kill -9, forced shutdown) is detected by checking the recorded PID and cleared —
 * never on any other basis (age, mtime, ...), so a legitimately long-running session
 * is never clobbered.
 */
export async function acquireLock(lockPath: string): Promise<AcquireLockResult> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  let existing: LockData | null = null;
  let fileExisted = false;
  try {
    const raw = await readFile(lockPath, 'utf8');
    fileExisted = true;
    existing = JSON.parse(raw) as LockData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fileExisted = true; // present but unreadable/unparseable
    existing = null;
  }

  if (existing && typeof existing.pid === 'number' && isPidAlive(existing.pid)) {
    return { ok: false, reason: 'ALREADY_RUNNING', pid: existing.pid };
  }

  await writeOwnLock(lockPath);
  return { ok: true, staleLockCleared: fileExisted };
}

export async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}
