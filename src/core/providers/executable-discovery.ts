import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecutableDiscoveryDeps {
  /** `where.exe <name>` (Windows) / `which -a <name>` semantics: every match on PATH, in PATH order. */
  where: (name: string) => Promise<string[]>;
  /** Extra candidates checked only when PATH has none (e.g. Codex's versioned install dir). */
  fallback?: (name: string) => Promise<string[]>;
  /** Windows only: when PATH lists nothing but npm shims (`name`, `name.cmd`), the native
   * `name.exe` that shim launches, or null. */
  nativeFromShim?: (name: string, hits: string[]) => Promise<string | null>;
  platform: NodeJS.Platform;
}

/**
 * Picks the executable a no-shell spawn can actually run. On Windows `where claude` can
 * list an extension-less npm shim (a POSIX shell script) or a `.cmd` wrapper next to the
 * real `claude.exe`; neither can be spawned without a shell, so the first `.exe` wins and
 * the first hit is only used when there is no `.exe` at all.
 */
export function pickSpawnableExecutable(hits: string[], platform: NodeJS.Platform): string | null {
  if (hits.length === 0) return null;
  if (platform === 'win32') return hits.find((h) => h.toLowerCase().endsWith('.exe')) ?? hits[0];
  return hits[0];
}

export async function discoverExecutable(name: string, deps: ExecutableDiscoveryDeps): Promise<string | null> {
  const hits = await deps.where(name).catch(() => []);
  const onPath = pickSpawnableExecutable(hits, deps.platform);
  if (onPath !== null && !(deps.platform === 'win32' && !onPath.toLowerCase().endsWith('.exe') && deps.nativeFromShim)) return onPath;
  if (deps.platform === 'win32' && deps.nativeFromShim && hits.length > 0) {
    const native = await deps.nativeFromShim(name, hits).catch(() => null);
    if (native !== null) return native;
    if (onPath !== null) return onPath;
  }
  if (!deps.fallback) return null;
  return pickSpawnableExecutable(await deps.fallback(name).catch(() => []), deps.platform);
}

async function realWhere(name: string): Promise<string[]> {
  const [cmd, args] = process.platform === 'win32' ? ['where', [name]] : ['which', ['-a', name]];
  const { stdout } = await execFileAsync(cmd, args, { timeout: 10000, windowsHide: true });
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Codex installed by the ChatGPT desktop app lives in %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe,
 * which is often not on PATH. Newest first. Derived from the environment, not a hardcoded user path. */
async function realFallback(name: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  if (name !== 'codex' || !env.LOCALAPPDATA) return [];
  const base = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  const dirs = await readdir(base).catch(() => [] as string[]);
  const found = await Promise.all(
    dirs.map(async (d) => {
      const p = path.join(base, d, 'codex.exe');
      const s = await stat(p).catch(() => null);
      return s?.isFile() ? { p, t: s.mtimeMs } : null;
    }),
  );
  return found
    .filter((x): x is { p: string; t: number } => x !== null)
    .sort((a, b) => b.t - a.t)
    .map((x) => x.p);
}

/**
 * npm installs a CLI whose binary ships as a platform package (OpenCode: `opencode-ai` →
 * `opencode-windows-x64/bin/opencode.exe`) behind `name` / `name.cmd` shims that a no-shell
 * spawn cannot run. This finds the `.exe` next to the shim: `<npm dir>/node_modules/<pkg>/
 * node_modules/<platform pkg>/bin/<name>.exe` or `<npm dir>/node_modules/<pkg>/bin/<name>.exe`.
 * A non-baseline build is preferred. Returns null when there is none.
 */
export async function findNativeExecutableNextToNpmShim(name: string, hits: string[]): Promise<string | null> {
  const exists = (p: string) => stat(p).then((s) => s.isFile(), () => false);
  const dirs = [...new Set(hits.map((h) => path.dirname(h)))];
  for (const dir of dirs) {
    const modules = path.join(dir, 'node_modules');
    const candidates: string[] = [];
    for (const pkg of await readdir(modules).catch(() => [] as string[])) {
      candidates.push(path.join(modules, pkg, 'bin', `${name}.exe`));
      const nested = path.join(modules, pkg, 'node_modules');
      for (const sub of await readdir(nested).catch(() => [] as string[])) candidates.push(path.join(nested, sub, 'bin', `${name}.exe`));
    }
    candidates.sort((a, b) => Number(/baseline/i.test(a)) - Number(/baseline/i.test(b)));
    for (const c of candidates) if (await exists(c)) return c;
  }
  return null;
}

export function createRealExecutableLocator(env: NodeJS.ProcessEnv = process.env): (name: string) => Promise<string | null> {
  return (name) => discoverExecutable(name, { where: realWhere, fallback: (n) => realFallback(n, env), nativeFromShim: findNativeExecutableNextToNpmShim, platform: process.platform });
}
