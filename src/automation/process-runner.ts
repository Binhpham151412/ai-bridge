import { spawn } from 'node:child_process';

export interface RunProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  /** Called with the child's pid as soon as it's spawned — lets a caller show a live PID before the process finishes. */
  onSpawn?: (pid: number) => void;
  /** Per-stream cap on accumulated bytes — protects against unbounded memory growth
   * from a runaway/flooding process. Once exceeded, further chunks for that stream are
   * dropped (not buffered) and `stdoutTruncated`/`stderrTruncated` is set; the process
   * itself keeps running normally (this does not kill it — the timeout still does that).
   * Defaults to 50MB, far larger than any real single Claude/Codex CLI invocation's
   * stream-json output, so normal use is never truncated. */
  maxBufferBytes?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * Spawns `command` with `args`, feeds `input` to stdin as UTF-8, and waits for exit.
 * On timeout it kills the whole process tree (not just the direct child — required on
 * Windows, where a CLI may spawn helper processes) and resolves with timedOut: true
 * instead of rejecting. Never uses a shell, so paths containing spaces are safe and no
 * quoting is needed.
 */
export function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (child.pid !== undefined) options.onSpawn?.(child.pid);

    let timedOut = false;
    let settled = false;
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, options.timeoutMs);

    child.stdout.on('data', (c: Buffer) => {
      if (stdoutBytes >= maxBufferBytes) {
        stdoutTruncated = true;
        return;
      }
      stdoutChunks.push(c);
      stdoutBytes += c.length;
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderrBytes >= maxBufferBytes) {
        stderrTruncated = true;
        return;
      }
      stderrChunks.push(c);
      stderrBytes += c.length;
    });

    child.on('error', () => {
      // e.g. ENOENT for a missing executable — still resolve, never leave the caller hanging.
      finish(null, null);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });

    function finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        durationMs: Date.now() - startedAt,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    }

    if (options.input !== undefined) {
      child.stdin.end(options.input, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/** Kills `pid` and its descendants. Windows-only for now (this tool targets Windows). */
export function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
  }
}
