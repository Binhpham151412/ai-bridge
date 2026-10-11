import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Recent-project history (docs/63) — pure functions over the list stored in the app's own
 * `settings.json` (Electron userData, never inside a project). An entry holds only what is
 * needed to show and reopen a folder: no credentials, no provider data, no project contents.
 */

export interface ProjectHistoryEntry {
  /** Deterministic: derived from the canonical path (see `projectIdOf`), stable across restarts. */
  id: string;
  name: string;
  /** Absolute canonical path (as returned by `validateProjectPath` → realpath). */
  path: string;
  /** ISO 8601. */
  lastOpenedAt: string;
  pinned: boolean;
}

/** At most this many UNPINNED entries are kept; pinned ones are never dropped by the limit. */
export const MAX_RECENT_PROJECTS = 20;
/** Hard ceiling for a corrupt/hand-edited file (pinned included). */
const MAX_ENTRIES_ON_LOAD = 200;
const ID_PATTERN = /^[0-9a-f]{16}$/;

export function isProjectHistoryId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * The comparison key for "same local project": resolved, trailing separators removed, and on
 * Windows (case-insensitive file system) forward slashes → backslashes and case folded, so
 * `D:\Work\App`, `d:/work/app/` and `D:\WORK\APP` are one project.
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const resolved = path.win32.resolve(p.replace(/\//g, '\\'));
    const trimmed = resolved.length > 3 ? resolved.replace(/\\+$/, '') : resolved;
    return trimmed.toLowerCase();
  }
  const resolved = path.posix.resolve(p);
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

/** Stable local identity: the first 16 hex chars of SHA-256 over the path key. Nothing in the
 * project is read or written to compute it (no repository scan, no marker file). */
export function projectIdOf(p: string, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256').update(pathKey(p, platform), 'utf8').digest('hex').slice(0, 16);
}

/** Pinned first, then unpinned; most recently opened first within each group. */
export function orderHistory(entries: readonly ProjectHistoryEntry[]): ProjectHistoryEntry[] {
  const byRecent = (a: ProjectHistoryEntry, b: ProjectHistoryEntry) => b.lastOpenedAt.localeCompare(a.lastOpenedAt);
  return [...entries.filter((e) => e.pinned).sort(byRecent), ...entries.filter((e) => !e.pinned).sort(byRecent)];
}

/** Keeps every pinned entry and the `MAX_RECENT_PROJECTS` most recent unpinned ones. */
function enforceLimit(entries: readonly ProjectHistoryEntry[]): ProjectHistoryEntry[] {
  const ordered = orderHistory(entries);
  const pinned = ordered.filter((e) => e.pinned);
  const recent = ordered.filter((e) => !e.pinned).slice(0, MAX_RECENT_PROJECTS);
  return [...pinned, ...recent];
}

/** A successful open: update the existing entry (same id) or add one; keep its pinned flag. */
export function recordOpened(
  entries: readonly ProjectHistoryEntry[],
  project: { path: string; name: string },
  at: string,
  platform: NodeJS.Platform = process.platform,
): ProjectHistoryEntry[] {
  const id = projectIdOf(project.path, platform);
  const existing = entries.find((e) => e.id === id);
  const updated: ProjectHistoryEntry = { id, name: project.name, path: project.path, lastOpenedAt: at, pinned: existing?.pinned ?? false };
  return enforceLimit([updated, ...entries.filter((e) => e.id !== id)]);
}

export function setPinned(entries: readonly ProjectHistoryEntry[], id: string, pinned: boolean): ProjectHistoryEntry[] {
  return enforceLimit(entries.map((e) => (e.id === id ? { ...e, pinned } : e)));
}

/** Removes the history entry only — the project directory is never touched. */
export function removeEntry(entries: readonly ProjectHistoryEntry[], id: string): ProjectHistoryEntry[] {
  return entries.filter((e) => e.id !== id);
}

/** The entry to restore at startup: the most recently opened one, pinned or not. */
export function lastOpened(entries: readonly ProjectHistoryEntry[]): ProjectHistoryEntry | null {
  return [...entries].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))[0] ?? null;
}

/**
 * Reads whatever is in the settings file defensively: keeps only well-formed entries with
 * exactly the known fields (anything else in the file is dropped, never carried along),
 * recomputes ids from the path, merges duplicates (newest wins, pinned if any copy was),
 * and applies the limit. Never throws.
 */
export function sanitizeHistory(raw: unknown, platform: NodeJS.Platform = process.platform): ProjectHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, ProjectHistoryEntry>();
  for (const item of raw.slice(0, MAX_ENTRIES_ON_LOAD)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== 'string' || r.path === '' || r.path.length > 1024 || r.path.includes('\u0000')) continue;
    if (typeof r.lastOpenedAt !== 'string' || Number.isNaN(Date.parse(r.lastOpenedAt))) continue;
    const isAbsolute = platform === 'win32' ? path.win32.isAbsolute(r.path) : path.posix.isAbsolute(r.path);
    if (!isAbsolute) continue;
    const id = projectIdOf(r.path, platform);
    const name = typeof r.name === 'string' && r.name !== '' ? r.name.slice(0, 260) : (platform === 'win32' ? path.win32 : path.posix).basename(r.path);
    const entry: ProjectHistoryEntry = { id, name, path: r.path, lastOpenedAt: new Date(r.lastOpenedAt).toISOString(), pinned: r.pinned === true };
    const prev = byId.get(id);
    if (!prev) byId.set(id, entry);
    else {
      const newer = entry.lastOpenedAt > prev.lastOpenedAt ? entry : prev;
      byId.set(id, { ...newer, pinned: prev.pinned || entry.pinned });
    }
  }
  return enforceLimit([...byId.values()]);
}
