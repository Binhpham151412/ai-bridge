export type GitWarning = 'WARNING_NOT_GIT_REPOSITORY' | 'WARNING_UNCOMMITTED_CHANGES' | null;

export interface GitStatusResult {
  isGitRepo: boolean;
  hasUncommittedChanges: boolean;
  warning: GitWarning;
}

export interface RunGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitSafetyDeps {
  /** Runs `git <args>` in `cwd`. Never receives destructive args from this module (status only). */
  runGit: (args: string[], cwd: string) => Promise<RunGitResult>;
}

/** Read-only check: never runs reset/checkout/clean/stash/commit — only `git status --porcelain`. */
export async function checkGitStatus(projectPath: string, deps: GitSafetyDeps): Promise<GitStatusResult> {
  let result: RunGitResult;
  try {
    result = await deps.runGit(['status', '--porcelain'], projectPath);
  } catch {
    // git missing, spawn failure, etc. — same practical outcome as "not a repo we can use".
    return { isGitRepo: false, hasUncommittedChanges: false, warning: 'WARNING_NOT_GIT_REPOSITORY' };
  }

  if (result.exitCode !== 0) {
    return { isGitRepo: false, hasUncommittedChanges: false, warning: 'WARNING_NOT_GIT_REPOSITORY' };
  }

  const hasUncommittedChanges = result.stdout.trim() !== '';
  return { isGitRepo: true, hasUncommittedChanges, warning: hasUncommittedChanges ? 'WARNING_UNCOMMITTED_CHANGES' : null };
}
