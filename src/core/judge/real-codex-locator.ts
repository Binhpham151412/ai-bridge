import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveExecutable } from '../preflight/executable-resolver.ts';

const execFileAsync = promisify(execFile);

/** `where <name>` (the same lookup BridgeEngine uses for `codex`). */
async function where(name: string): Promise<string[]> {
  const { stdout } = await execFileAsync('where', [name]);
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** The newest `%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe` (the ChatGPT app's copy), newest first. */
async function globCodexBin(): Promise<string[]> {
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  const dirs = await readdir(base).catch(() => [] as string[]);
  const found = await Promise.all(
    dirs.map(async (d) => {
      const p = path.join(base, d, 'codex.exe');
      const s = await stat(p).catch(() => null);
      return s ? { p, t: s.mtimeMs } : null;
    }),
  );
  return found.filter((x): x is { p: string; t: number } => x !== null).sort((a, b) => b.t - a.t).map((x) => x.p);
}

export const realCodexLocator = (): Promise<string | null> => resolveExecutable('codex', { where, globCodexBin });
