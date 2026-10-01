import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireLock, releaseLock, type AcquireLockResult } from '../lock/run-lock.ts';

/**
 * M5.3 — the per-project workflow lock: at most one active workflow instance per project
 * (docs/26 §5). Same semantics as the run lock — pid-based stale detection, never age-based
 * — by reusing core/lock/run-lock.ts unchanged, on a SEPARATE file:
 * `.ai-bridge/state/workflow-lock` (the run lock `.ai-bridge/state/lock` is BridgeEngine's
 * and is never touched here). Held by the workflow host process (ADR-011).
 */

export function workflowLockPath(aiBridgeDir: string): string {
  return path.join(aiBridgeDir, 'state', 'workflow-lock');
}

export function acquireWorkflowLock(aiBridgeDir: string): Promise<AcquireLockResult> {
  return acquireLock(workflowLockPath(aiBridgeDir));
}

export function releaseWorkflowLock(aiBridgeDir: string): Promise<void> {
  return releaseLock(workflowLockPath(aiBridgeDir));
}

/** Who holds the lock (for the derived INTERRUPTED display state); null when free or unreadable. */
export async function readWorkflowLockOwner(aiBridgeDir: string): Promise<{ pid: number; startedAt: string | null } | null> {
  try {
    const data = JSON.parse(await readFile(workflowLockPath(aiBridgeDir), 'utf8')) as { pid?: unknown; startedAt?: unknown };
    return typeof data.pid === 'number' ? { pid: data.pid, startedAt: typeof data.startedAt === 'string' ? data.startedAt : null } : null;
  } catch {
    return null;
  }
}
