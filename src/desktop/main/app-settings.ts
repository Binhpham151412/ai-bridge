import { readFile } from 'node:fs/promises';
import { AtomicJsonWriter } from '../../core/state-manager/atomic-json-writer.ts';

/**
 * App-level preferences only (M4 §15) — stored in Electron's userData folder, never in
 * a project. Deliberately tiny: run configuration lives in each project's
 * `.ai-bridge/config.json` (owned by Core), and no credential of any kind is ever
 * stored by this app.
 */
export interface AppSettings {
  defaultProjectPath: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = { defaultProjectPath: null };

export async function loadAppSettings(filePath: string): Promise<AppSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_APP_SETTINGS };
    const value = (parsed as Record<string, unknown>).defaultProjectPath;
    return { defaultProjectPath: typeof value === 'string' && value !== '' ? value : null };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export async function saveAppSettings(filePath: string, settings: AppSettings): Promise<void> {
  await new AtomicJsonWriter<AppSettings>(filePath).write({ defaultProjectPath: settings.defaultProjectPath });
}
