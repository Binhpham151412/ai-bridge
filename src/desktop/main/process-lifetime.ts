import type { StdioOptions } from 'node:child_process';

/**
 * M5.8.1 — how long a forked host may outlive the process that forked it. The one place that
 * knows the platform mechanism; nothing else in the code base branches on it.
 *
 * Windows (Node/libuv, verified by tests/workflow/process-lifetime.windows.test.ts): every child
 * forked or spawned WITHOUT `detached` is assigned to a job object its parent created with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. When the parent process ends — normally or not — the job
 * closes and the child is terminated, and with it the child's own job (the child's children).
 * A `detached` child is not assigned to that job and gets its own process group and no console,
 * so it outlives its parent. On other platforms a child already outlives its parent; `detached`
 * additionally keeps it out of the parent's terminal process group (no Ctrl+C / hang-up).
 *
 *   'with-parent'  (default; unchanged since M4) the child ends with its parent.
 *   'independent'  the child outlives its parent. Then it must own nothing that dies with the
 *                  parent: stdin/stdout/stderr are NOT pipes to the parent — a write to a stderr
 *                  pipe whose reader has died is fatal (verified) — only the IPC channel is kept,
 *                  and the child sends over it only with a completion callback, which a closed
 *                  channel answers with an error instead of a crash (serveRunHost does).
 *
 * A process's OWN children stay 'with-parent' (e.g. the Claude/Codex CLIs of an Execution Host,
 * spawned by process-runner): a CLI never outlives the Execution Host that owns it.
 */
export type HostLifetime = 'with-parent' | 'independent';

export interface HostSpawnOptions {
  detached: boolean;
  stdio: StdioOptions;
  /** Whether the parent receives the child's stderr (for "View details" after an unexpected exit). */
  capturesStderr: boolean;
}

export function hostSpawnOptions(lifetime: HostLifetime): HostSpawnOptions {
  return lifetime === 'independent'
    ? { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], capturesStderr: false }
    : { detached: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], capturesStderr: true };
}
