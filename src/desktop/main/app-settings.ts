import { readFile } from 'node:fs/promises';
import { AtomicJsonWriter } from '../../core/state-manager/atomic-json-writer.ts';
import { sanitizeHistory, type ProjectHistoryEntry } from './project-history.ts';

/**
 * App-level preferences only (M4 §15) — stored in Electron's userData folder, never in
 * a project. Deliberately tiny: run configuration lives in each project's
 * `.ai-bridge/config.json` (owned by Core), and no credential of any kind is ever
 * stored by this app. The recent-project history (docs/63) lives here too: names, paths,
 * times and pin flags — nothing else.
 */
export interface AppSettings {
  defaultProjectPath: string | null;
  recentProjects: ProjectHistoryEntry[];
}

export const DEFAULT_APP_SETTINGS: AppSettings = { defaultProjectPath: null, recentProjects: [] };

export async function loadAppSettings(filePath: string): Promise<AppSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_APP_SETTINGS, recentProjects: [] };
    const value = (parsed as Record<string, unknown>).defaultProjectPath;
    return {
      defaultProjectPath: typeof value === 'string' && value !== '' ? value : null,
      recentProjects: sanitizeHistory((parsed as Record<string, unknown>).recentProjects),
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS, recentProjects: [] };
  }
}

/** Writes exactly the known fields — whatever else might be passed in is never persisted. */
export async function saveAppSettings(filePath: string, settings: AppSettings): Promise<void> {
  await new AtomicJsonWriter<AppSettings>(filePath).write({
    defaultProjectPath: settings.defaultProjectPath,
    recentProjects: settings.recentProjects.map(({ id, name, path, lastOpenedAt, pinned }) => ({ id, name, path, lastOpenedAt, pinned })),
  });
}
