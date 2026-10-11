import type { ActionResponse, ProjectHistoryView, ProjectInfo } from '../shared/ipc-contract.ts';
import { loadAppSettings, saveAppSettings, type AppSettings } from './app-settings.ts';
import { lastOpened, orderHistory, pathKey, projectIdOf, recordOpened, removeEntry, setPinned, type ProjectHistoryEntry } from './project-history.ts';
import { validateProjectPath, type ProjectPathValidation } from './project-path.ts';

/**
 * docs/63 — recent projects + last-project restore, owned by Electron Main. The single writer
 * of the app's `settings.json` (history and the existing default project), so the two never
 * overwrite each other. Electron-free on purpose: the native folder picker and the actual
 * "open this project in the controllers" step are injected.
 *
 * The renderer never sends a path: it names a history entry by id, and every path that is
 * opened is (re)validated here by `validateProjectPath` first.
 */

export interface ProjectHistoryServiceDeps {
  settingsFile: string;
  /** Opens an already-validated project in the run + workflow controllers. */
  openValidated: (project: ProjectInfo) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The path of the project currently open in this window, if any. */
  activePath: () => string | null;
  now?: () => string;
  validate?: (input: unknown) => Promise<ProjectPathValidation>;
}

type Restore = ProjectHistoryView['restore'];

const fail = (code: string, title: string, message: string): ActionResponse => ({ ok: false, error: { code, title, message } });
const notInHistory = () => fail('NOT_FOUND', 'Không có trong lịch sử', 'Project này không còn trong danh sách dự án gần đây.');

export class ProjectHistoryService {
  readonly #settingsFile: string;
  readonly #openValidated: ProjectHistoryServiceDeps['openValidated'];
  readonly #activePath: ProjectHistoryServiceDeps['activePath'];
  readonly #now: () => string;
  readonly #validate: (input: unknown) => Promise<ProjectPathValidation>;
  #settings: AppSettings;
  #restore: Restore = { outcome: 'NONE', name: null, path: null, reason: null };

  private constructor(deps: ProjectHistoryServiceDeps, settings: AppSettings) {
    this.#settingsFile = deps.settingsFile;
    this.#openValidated = deps.openValidated;
    this.#activePath = deps.activePath;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#validate = deps.validate ?? validateProjectPath;
    this.#settings = settings;
  }

  static async load(deps: ProjectHistoryServiceDeps): Promise<ProjectHistoryService> {
    return new ProjectHistoryService(deps, await loadAppSettings(deps.settingsFile));
  }

  get settings(): AppSettings {
    return { defaultProjectPath: this.#settings.defaultProjectPath, recentProjects: [...this.#settings.recentProjects] };
  }

  async #save(next: AppSettings): Promise<void> {
    this.#settings = next;
    await saveAppSettings(this.#settingsFile, next);
  }

  /** Validate → open in the controllers → record in history. The only way a project opens. */
  async open(candidate: string): Promise<{ ok: true; project: ProjectInfo } | { ok: false; reason: string }> {
    const validation = await this.#validate(candidate);
    if (!validation.ok) return validation;
    const opened = await this.#openValidated(validation.project);
    if (!opened.ok) return opened;
    await this.#save({ ...this.#settings, recentProjects: recordOpened(this.#settings.recentProjects, validation.project, this.#now()) });
    return { ok: true, project: validation.project };
  }

  /**
   * Startup: the explicit default project (Settings, existing feature) if one is set, else the
   * most recently opened project. A folder that is gone is never fatal: nothing is opened, the
   * outcome is MISSING and the recent list shows it. Another project is never opened instead
   * — the user chooses.
   */
  async restoreAtStartup(): Promise<Restore> {
    const candidate = this.#settings.defaultProjectPath ?? lastOpened(this.#settings.recentProjects)?.path ?? null;
    if (candidate === null) return (this.#restore = { outcome: 'NONE', name: null, path: null, reason: null });
    const name = this.#settings.recentProjects.find((e) => pathKey(e.path) === pathKey(candidate))?.name ?? null;
    let opened: Awaited<ReturnType<ProjectHistoryService['open']>>;
    try {
      opened = await this.open(candidate);
    } catch (err) {
      opened = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    this.#restore = opened.ok
      ? { outcome: 'RESTORED', name: opened.project.name, path: opened.project.path, reason: null }
      : { outcome: 'MISSING', name, path: candidate, reason: opened.reason };
    return this.#restore;
  }

  async view(): Promise<ProjectHistoryView> {
    const active = this.#activePath();
    const activeKey = active === null ? null : pathKey(active);
    const entries = await Promise.all(
      orderHistory(this.#settings.recentProjects).map(async (e) => ({
        ...e,
        status: (await this.#validate(e.path)).ok ? ('AVAILABLE' as const) : ('MISSING' as const),
        active: activeKey !== null && pathKey(e.path) === activeKey,
      })),
    );
    return { entries, restore: this.#restore };
  }

  #entry(id: string): ProjectHistoryEntry | null {
    return this.#settings.recentProjects.find((e) => e.id === id) ?? null;
  }

  async openRecent(id: string): Promise<ActionResponse> {
    const entry = this.#entry(id);
    if (!entry) return notInHistory();
    const opened = await this.open(entry.path);
    if (!opened.ok) return fail('INVALID_PROJECT', 'Không mở được project', `${opened.reason} (${entry.path}) — dùng "Tìm lại…" hoặc xoá khỏi lịch sử.`);
    return { ok: true, message: `Đã mở ${opened.project.name}.` };
  }

  async setPinned(id: string, pinned: boolean): Promise<ActionResponse> {
    if (!this.#entry(id)) return notInHistory();
    await this.#save({ ...this.#settings, recentProjects: setPinned(this.#settings.recentProjects, id, pinned) });
    return { ok: true };
  }

  /** History only — the project directory is never touched. */
  async remove(id: string): Promise<ActionResponse> {
    if (!this.#entry(id)) return { ok: true };
    await this.#save({ ...this.#settings, recentProjects: removeEntry(this.#settings.recentProjects, id) });
    return { ok: true, message: 'Đã xoá khỏi lịch sử (thư mục project không bị đụng tới).' };
  }

  /** A missing entry was moved/renamed: the user picks the folder (native picker in Main); it is
   * validated and opened like any other, and replaces the old entry (keeping its pin). */
  async locate(id: string, pickFolder: (hint: string) => Promise<string | null>): Promise<ActionResponse> {
    const entry = this.#entry(id);
    if (!entry) return notInHistory();
    const picked = await pickFolder(entry.path);
    if (picked === null) return { ok: true, message: 'Đã huỷ.' };
    const opened = await this.open(picked);
    if (!opened.ok) return fail('INVALID_PROJECT', 'Project không hợp lệ', opened.reason);
    const newId = projectIdOf(opened.project.path);
    if (newId !== id) {
      let recent = removeEntry(this.#settings.recentProjects, id);
      if (entry.pinned) recent = setPinned(recent, newId, true);
      await this.#save({ ...this.#settings, recentProjects: recent });
    }
    return { ok: true, message: `Đã mở ${opened.project.name}.` };
  }

  /** The existing "default project" setting, now persisted through the same single writer. */
  async setDefaultProject(projectPath: string | null): Promise<void> {
    await this.#save({ ...this.#settings, defaultProjectPath: projectPath });
  }
}
