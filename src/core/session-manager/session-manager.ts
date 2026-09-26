import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface SessionManagerOptions {
  /** Absolute path to <project>/.ai-bridge. */
  aiBridgeDir: string;
  /** Injectable clock, so session ids are deterministic in tests. */
  now?: () => Date;
}

export interface CreatedSession {
  sessionId: string;
  sessionDir: string;
  reportsDir: string;
  logsDir: string;
  stateFile: string;
}

function dateKey(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Creates and tracks `.ai-bridge/` session state. Session ids are `<date>_NNN`,
 * with NNN computed by scanning existing session directories for that date — so
 * numbering survives across separate `createSession()` calls (and, since it reads
 * from disk rather than in-memory state, across process restarts too).
 */
export class SessionManager {
  private readonly aiBridgeDir: string;
  private readonly now: () => Date;

  constructor(options: SessionManagerOptions) {
    this.aiBridgeDir = options.aiBridgeDir;
    this.now = options.now ?? (() => new Date());
  }

  async createSession(): Promise<CreatedSession> {
    const reportsDir = path.join(this.aiBridgeDir, 'reports');
    const sessionsRootDir = path.join(this.aiBridgeDir, 'sessions');
    const logsDir = path.join(this.aiBridgeDir, 'logs');
    const stateDir = path.join(this.aiBridgeDir, 'state');
    for (const dir of [reportsDir, sessionsRootDir, logsDir, stateDir]) {
      await mkdir(dir, { recursive: true });
    }

    const today = dateKey(this.now());
    const existing = await readdir(sessionsRootDir).catch(() => [] as string[]);
    const todaysNumbers = existing
      .map((name) => /^(\d{4}-\d{2}-\d{2})_(\d{3})$/.exec(name))
      .filter((m): m is RegExpExecArray => m !== null && m[1] === today)
      .map((m) => Number(m[2]));
    const nextNumber = (todaysNumbers.length > 0 ? Math.max(...todaysNumbers) : 0) + 1;
    const sessionId = `${today}_${String(nextNumber).padStart(3, '0')}`;
    const sessionDir = path.join(sessionsRootDir, sessionId);
    await mkdir(sessionDir, { recursive: true });

    return { sessionId, sessionDir, reportsDir, logsDir, stateFile: path.join(stateDir, 'current-session.json') };
  }

  async writeSessionFile(sessionDir: string, data: unknown): Promise<void> {
    await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify(data, null, 2), 'utf8');
  }

  async writeState(stateFile: string, data: unknown): Promise<void> {
    await writeFile(stateFile, JSON.stringify(data, null, 2), 'utf8');
  }
}
