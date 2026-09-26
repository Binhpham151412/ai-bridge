import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Writes JSON to `filePath` atomically (write to a temp file, then rename — a rename
 * within the same directory is a single filesystem operation, so a reader always sees
 * either the complete old file or the complete new one, never a half-written one) and
 * serializes concurrent calls (each waits for the previous write's rename to finish
 * before starting its own), so unawaited callers firing several writes in quick
 * succession — exactly how a crash/observability callback fires — can never interleave
 * two writes into one corrupted file.
 *
 * Born from a real bug: `.ai-bridge/state/current-session.json` was corrupted (trailing
 * garbage bytes from an earlier, longer write) after a real crash-recovery test fired
 * several unawaited state writes in quick succession. See docs/06-recovery-design.md.
 */
export class AtomicJsonWriter<T> {
  private readonly filePath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  write(data: T): Promise<void> {
    this.chain = this.chain.then(
      () => this.writeOnce(data),
      () => this.writeOnce(data), // a prior write's failure must not permanently wedge the queue
    );
    return this.chain;
  }

  private async writeOnce(data: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    try {
      await this.renameWithRetry(tmpPath);
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
  }

  /** Windows can transiently refuse to replace a file another handle has open for
   * reading (EPERM/EBUSY) even though the rename would otherwise succeed — retry a
   * few times with a short backoff rather than surfacing a spurious failure. */
  private async renameWithRetry(tmpPath: string): Promise<void> {
    const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmpPath, this.filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 15 || !code || !RETRYABLE.has(code)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  }
}
