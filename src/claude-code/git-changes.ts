import { execFile } from 'node:child_process';

/**
 * docs/66 — what the reviewer is shown of the project itself, besides Claude's report: the
 * changes since the loop started (git). Read-only git commands; anything that fails (no git,
 * not a repository, no commit yet) means "nothing to show", never an error for the loop.
 */

const DEFAULT_MAX_CHARS = 30_000;
const GIT_TIMEOUT_MS = 15_000;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** The commit checked out in `cwd`, or null (not a repository, no commit yet, no git). */
export async function headCommit(cwd: string): Promise<string | null> {
  const out = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  return out?.trim() || null;
}

/**
 * The project's changes since `base` (the commit the loop started from; HEAD when null):
 * `git status` (new files included), then the diff of the working tree against `base`,
 * committed and uncommitted alike, cut at `maxChars`. Null when there is nothing to show.
 */
export async function changesSince(cwd: string, base: string | null, maxChars = DEFAULT_MAX_CHARS): Promise<string | null> {
  const status = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status === null) return null;
  const diff = (await git(cwd, ['diff', base ?? 'HEAD'])) ?? '';
  if (status.trim() === '' && diff.trim() === '') return null;
  const text = [`$ git status --porcelain`, status.trimEnd() || '(clean)', '', `$ git diff ${base ?? 'HEAD'}`, diff.trimEnd() || '(no changes)'].join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… (cut at ${maxChars} characters; read the files for the rest)`;
}
