export interface ExecutableResolverDeps {
  /** Resolves `name` the way `where.exe <name>` does; returns the list of matches, most preferred first. */
  where: (name: string) => Promise<string[]>;
  /** Fallback for `codex`, whose install path contains a version hash and isn't reliably on PATH. */
  globCodexBin?: () => Promise<string[]>;
}

export async function resolveExecutable(name: string, deps: ExecutableResolverDeps): Promise<string | null> {
  const hits = await deps.where(name).catch(() => []);
  if (hits.length > 0) return hits[0];
  if (name === 'codex' && deps.globCodexBin) {
    const fallback = await deps.globCodexBin().catch(() => []);
    if (fallback.length > 0) return fallback[0];
  }
  return null;
}
