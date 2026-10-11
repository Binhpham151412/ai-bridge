import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { reportSessionIdOf } from './report-validator.ts';

/**
 * Stale-report isolation. `reports/NNN-report.md` is shared by every session of a project
 * (ADR-019), so a report written by an EARLIER session can still sit at the path the next
 * session's Claude call is supposed to write. If that Claude call then writes nothing (e.g.
 * it answered in chat), the old file was validated as if it were this run's report and
 * failed as SESSION_MISMATCH → REPORT_INVALID, hiding the real cause.
 *
 * Before a Claude call starts, any file already at the report path is MOVED (never deleted,
 * bytes unchanged) to `reports/superseded/<SESSION_ID>-NNN-report.md`, so the run sees only
 * what this Claude call writes (a missing report is then REPORT_MISSING), and the older
 * session keeps a findable copy of its own report.
 */

export const SUPERSEDED_DIR = 'superseded';
const MAX_BYTES_TO_IDENTIFY = 1024 * 1024;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);

/** Where a moved report of `sessionId` lives (`null` = the file declared no SESSION_ID). */
export function supersededReportPath(reportsDir: string, sessionId: string | null, reportFileName: string): string {
  return path.join(reportsDir, SUPERSEDED_DIR, `${safe(sessionId ?? 'unknown-session')}-${reportFileName}`);
}

export interface StaleReportMove {
  /** File name the report had (e.g. `001-report.md`). */
  from: string;
  /** Path relative to the reports directory, e.g. `superseded/2026-10-01_001-001-report.md`. */
  movedTo: string;
  /** SESSION_ID declared by the moved file; null when none / unreadable / too large to inspect. */
  sessionId: string | null;
  sha256: string | null;
  bytes: number;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Moves a pre-existing report out of the way; null when there was none. */
export async function isolateStaleReport(reportPath: string, reportsDir: string): Promise<StaleReportMove | null> {
  const info = await stat(reportPath).catch(() => null);
  if (!info?.isFile()) return null;
  let sessionId: string | null = null;
  let sha256: string | null = null;
  if (info.size <= MAX_BYTES_TO_IDENTIFY) {
    const buffer = await readFile(reportPath).catch(() => null);
    if (buffer) {
      sha256 = createHash('sha256').update(buffer).digest('hex');
      sessionId = reportSessionIdOf(buffer.toString('utf8'));
    }
  }
  const name = path.basename(reportPath);
  await mkdir(path.join(reportsDir, SUPERSEDED_DIR), { recursive: true });
  let target = supersededReportPath(reportsDir, sessionId, name);
  for (let n = 2; await exists(target); n += 1) target = supersededReportPath(reportsDir, sessionId, name).replace(/\.md$/, `.${n}.md`);
  await rename(reportPath, target);
  return { from: name, movedTo: path.relative(reportsDir, target).replace(/\\/g, '/'), sessionId, sha256, bytes: info.size };
}
