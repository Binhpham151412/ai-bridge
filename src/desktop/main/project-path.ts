import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectInfo } from '../shared/ipc-contract.ts';

export type ProjectPathValidation = { ok: true; project: ProjectInfo } | { ok: false; reason: string };

/**
 * Main-side validation of a project directory before it ever reaches BridgeEngine
 * (M4 §12). The path comes from Electron's native folder picker or from the app's own
 * settings file — never typed by the renderer — but is still checked here: absolute,
 * local (no UNC/network share), an existing directory after resolving symlinks, and
 * not a bare drive/filesystem root. Core's own rules (lock, doctor's project check)
 * still apply on top of this.
 */
export async function validateProjectPath(input: unknown): Promise<ProjectPathValidation> {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, reason: 'Đường dẫn project trống.' };
  if (input.length > 1024 || input.includes('\u0000')) return { ok: false, reason: 'Đường dẫn project không hợp lệ.' };
  if (!path.isAbsolute(input)) return { ok: false, reason: 'Đường dẫn project phải là đường dẫn tuyệt đối.' };
  if (/^[\\/]{2}/.test(input)) return { ok: false, reason: 'Không hỗ trợ thư mục mạng (UNC) cho project.' };

  let resolved: string;
  try {
    resolved = await realpath(input);
  } catch {
    return { ok: false, reason: 'Thư mục project không tồn tại.' };
  }
  if (/^[\\/]{2}/.test(resolved)) return { ok: false, reason: 'Không hỗ trợ thư mục mạng (UNC) cho project.' };
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) return { ok: false, reason: 'Đường dẫn project không phải là thư mục.' };
  if (path.parse(resolved).root === resolved) return { ok: false, reason: 'Không dùng thư mục gốc của ổ đĩa làm project.' };

  return { ok: true, project: { path: resolved, name: path.basename(resolved) } };
}
