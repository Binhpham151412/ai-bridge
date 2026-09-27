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
  /** Called once `input` has been fully written to the child's stdin pipe and stdin was
   * closed (the stream's own 'finish' — the OS accepted every byte). This is the strongest
   * delivery evidence available without the child echoing its input back: it proves the
   * bytes left this process, not that the child program has read or understood them. */
  onInputFlushed?: (bytes: number) => void;
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
  pid: number | null;
  startedAt: string;
  endedAt: string;
  /** UTF-8 byte length of `input` (0 when none was given). */
  inputBytes: number;
  /** True once stdin was flushed and closed without error (see onInputFlushed). */
  inputDelivered: boolean;
  /** e.g. EPIPE when the child exited before reading its stdin. */
  inputError: string | null;
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
  const startedAtIso = new Date(startedAt).toISOString();
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
    const inputBytes = options.input === undefined ? 0 : Buffer.byteLength(options.input, 'utf8');
    let inputDelivered = false;
    let inputError: string | null = null;
    // Without a listener, an EPIPE (child exits before reading stdin) would be thrown as
    // an unhandled 'error' event and take the whole host process down.
    child.stdin.on('error', (err) => {
      inputError = err.message;
    });
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
        pid: child.pid ?? null,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
        inputBytes,
        inputDelivered,
        inputError,
      });
    }

    if (options.input !== undefined) {
      child.stdin.end(options.input, 'utf8', (err?: Error | null) => {
        if (err) {
          inputError = inputError ?? err.message;
          return;
        }
        if (inputError !== null) return;
        inputDelivered = true;
        options.onInputFlushed?.(inputBytes);
      });
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
