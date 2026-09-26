import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface LogEvent {
  timestamp: string;
  sessionId: string;
  iteration: number;
  adapter: 'claude' | 'codex';
  command: string;
  exitCode: number | null;
  durationMs: number;
  reportPath: string | null;
  status: 'ok' | 'error';
  error: string | null;
}

/** Appends one JSON line per call. Callers must never put a secret in `command`/`error`. */
export async function appendLogLine(filePath: string, event: LogEvent): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(event) + '\n', 'utf8');
}
