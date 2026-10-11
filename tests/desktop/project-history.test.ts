import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_RECENT_PROJECTS,
  orderHistory,
  pathKey,
  projectIdOf,
  recordOpened,
  sanitizeHistory,
  setPinned,
  type ProjectHistoryEntry,
} from '../../src/desktop/main/project-history.ts';
import { ProjectHistoryService } from '../../src/desktop/main/project-history-service.ts';
import { validateRequest } from '../../src/desktop/shared/ipc-contract.ts';
import type { ProjectInfo } from '../../src/desktop/shared/ipc-contract.ts';

// docs/63 — recent-project history + last-project restore. Real temp folders, a fake
// "open in the controllers" step; no Electron, no provider.

async function withDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-bridge-history-')));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let clock = 0;
const tick = () => new Date(Date.UTC(2026, 9, 2, 9, 0, 0) + ++clock * 1000).toISOString();

async function service(root: string, o: { failOpen?: string } = {}) {
  const opened: ProjectInfo[] = [];
  let active: string | null = null;
  const svc = await ProjectHistoryService.load({
    settingsFile: path.join(root, 'userData', 'settings.json'),
    openValidated: async (p) => {
      if (o.failOpen) return { ok: false, reason: o.failOpen };
      opened.push(p);
      active = p.path;
      return { ok: true };
    },
    activePath: () => active,
    now: tick,
  });
  return { svc, opened };
}

async function project(root: string, name: string): Promise<string> {
  const dir = path.join(root, 'projects', name);
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

const entry = (p: string, at: string, pinned = false): ProjectHistoryEntry => ({ id: projectIdOf(p), name: path.basename(p), path: p, lastOpenedAt: at, pinned });

// ---------------------------------------------------------------------------

test('1. empty history: nothing listed, nothing restored, nothing opened', () =>
  withDir(async (root) => {
    const { svc, opened } = await service(root);
    assert.deepEqual((await svc.restoreAtStartup()).outcome, 'NONE');
    const view = await svc.view();
    assert.deepEqual(view.entries, []);
    assert.equal(opened.length, 0);
  }));

test('2./3./4. first open creates an entry; reopening updates it (no duplicate); another project moves to the top', () =>
  withDir(async (root) => {
    const a = await project(root, 'alpha');
    const b = await project(root, 'beta');
    const { svc } = await service(root);
    assert.ok((await svc.open(a)).ok);
    let list = svc.settings.recentProjects;
    assert.equal(list.length, 1);
    assert.deepEqual({ ...list[0], lastOpenedAt: 'x' }, { id: projectIdOf(a), name: 'alpha', path: a, lastOpenedAt: 'x', pinned: false });
    const firstAt = list[0].lastOpenedAt;

    assert.ok((await svc.open(a)).ok);
    list = svc.settings.recentProjects;
    assert.equal(list.length, 1, 'same project → same entry');
    assert.ok(list[0].lastOpenedAt > firstAt, 'lastOpenedAt updated');

    assert.ok((await svc.open(b)).ok);
    assert.deepEqual(orderHistory(svc.settings.recentProjects).map((e) => e.name), ['beta', 'alpha']);
    // Persisted in the app's settings file — never inside the project.
    const saved = JSON.parse(await readFile(path.join(root, 'userData', 'settings.json'), 'utf8'));
    assert.deepEqual(saved.recentProjects.map((e: ProjectHistoryEntry) => e.name).sort(), ['alpha', 'beta']);
  }));

test('5. the last project is restored automatically at startup (next app start)', () =>
  withDir(async (root) => {
    const a = await project(root, 'alpha');
    const b = await project(root, 'beta');
    const first = await service(root);
    await first.svc.open(a);
    await first.svc.open(b);

    const next = await service(root);
    const restore = await next.svc.restoreAtStartup();
    assert.deepEqual([restore.outcome, restore.path, restore.name], ['RESTORED', b, 'beta']);
    assert.deepEqual(next.opened.map((p) => p.path), [b]);
    const view = await next.svc.view();
    assert.equal(view.entries.find((e) => e.path === b)?.active, true);
  }));

test('6./7. a missing last project never crashes startup: MISSING, nothing opened, shown in the list; it can be removed', () =>
  withDir(async (root) => {
    const a = await project(root, 'alpha');
    const gone = await project(root, 'gone');
    const first = await service(root);
    await first.svc.open(a);
    await first.svc.open(gone);
    await rm(gone, { recursive: true, force: true });

    const next = await service(root);
    const restore = await next.svc.restoreAtStartup();
    assert.equal(restore.outcome, 'MISSING');
    assert.equal(restore.path, gone);
    assert.equal(restore.name, 'gone');
    assert.equal(next.opened.length, 0, 'another project is never opened instead');
    const view = await next.svc.view();
    assert.deepEqual(
      view.entries.map((e) => [e.name, e.status]),
      [
        ['gone', 'MISSING'],
        ['alpha', 'AVAILABLE'],
      ],
    );
    assert.equal((await next.svc.openRecent(projectIdOf(gone))).ok, false, 'opening a missing entry fails cleanly');
    const removed = await next.svc.remove(projectIdOf(gone));
    assert.equal(removed.ok, true);
    assert.deepEqual(next.svc.settings.recentProjects.map((e) => e.name), ['alpha']);
    assert.ok(await realpath(a), 'removing history never touches folders');
  }));

test('8. a missing project can be located (moved folder) — the old entry is replaced, its pin kept; a folder that comes back is usable again', () =>
  withDir(async (root) => {
    const old = await project(root, 'app');
    const { svc } = await service(root);
    await svc.open(old);
    await svc.setPinned(projectIdOf(old), true);
    const moved = path.join(root, 'projects', 'app-moved');
    await rename(old, moved);
    assert.equal((await svc.view()).entries[0].status, 'MISSING');

    const r = await svc.locate(projectIdOf(old), async (hint) => {
      assert.equal(hint, old, 'the picker starts at the old location');
      return moved;
    });
    assert.equal(r.ok, true);
    const list = svc.settings.recentProjects;
    assert.deepEqual(list.map((e) => [e.path, e.pinned]), [[await realpath(moved), true]]);

    // Cancel = no change.
    assert.deepEqual(await svc.locate(list[0].id, async () => null), { ok: true, message: 'Đã huỷ.' });

    // A folder that disappears and comes back is usable again.
    const back = await project(root, 'back');
    await svc.open(back);
    await rename(back, back + '-tmp');
    assert.equal((await svc.view()).entries.find((e) => e.name === 'back')?.status, 'MISSING');
    await rename(back + '-tmp', back);
    assert.equal((await svc.view()).entries.find((e) => e.name === 'back')?.status, 'AVAILABLE');
    assert.equal((await svc.openRecent(projectIdOf(back))).ok, true);
  }));

test('9. pin/unpin: pinned entries come first; unpinning restores recency order', () => {
  const a = entry('D:\\p\\a', '2026-10-01T01:00:00.000Z');
  const b = entry('D:\\p\\b', '2026-10-01T02:00:00.000Z');
  const c = entry('D:\\p\\c', '2026-10-01T03:00:00.000Z');
  let list = setPinned([a, b, c], a.id, true);
  assert.deepEqual(orderHistory(list).map((e) => e.name), ['a', 'c', 'b']);
  list = setPinned(list, a.id, false);
  assert.deepEqual(orderHistory(list).map((e) => e.name), ['c', 'b', 'a']);
});

test('10./11. the history is bounded: at most 20 unpinned entries; pinned ones are never dropped', () => {
  let list: ProjectHistoryEntry[] = [];
  list = recordOpened(list, { path: 'D:\\p\\old-pinned', name: 'old-pinned' }, '2026-01-01T00:00:00.000Z', 'win32');
  list = setPinned(list, list[0].id, true);
  for (let i = 0; i < 30; i++) list = recordOpened(list, { path: `D:\\p\\n${i}`, name: `n${i}` }, new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(), 'win32');
  assert.equal(list.filter((e) => !e.pinned).length, MAX_RECENT_PROJECTS);
  assert.ok(list.some((e) => e.name === 'old-pinned' && e.pinned), 'the oldest entry survives because it is pinned');
  assert.ok(!list.some((e) => e.name === 'n0'), 'the oldest unpinned ones were dropped');
  assert.ok(list.some((e) => e.name === 'n29'));
});

test('12. Windows paths: case, slash direction and trailing separators never create duplicates', () => {
  assert.equal(pathKey('D:\\Work\\App', 'win32'), pathKey('d:/work/app/', 'win32'));
  assert.equal(projectIdOf('D:\\WORK\\APP\\', 'win32'), projectIdOf('d:\\work\\app', 'win32'));
  assert.notEqual(projectIdOf('/srv/App', 'linux'), projectIdOf('/srv/app', 'linux'), 'case-sensitive file systems keep case');
  let list: ProjectHistoryEntry[] = [];
  list = recordOpened(list, { path: 'D:\\Work\\App', name: 'App' }, '2026-10-01T01:00:00.000Z', 'win32');
  list = recordOpened(list, { path: 'd:/work/app/', name: 'app' }, '2026-10-01T02:00:00.000Z', 'win32');
  assert.equal(list.length, 1);
  assert.equal(list[0].lastOpenedAt, '2026-10-01T02:00:00.000Z');
  // The same holds for a hand-edited settings file.
  assert.equal(sanitizeHistory([{ path: 'D:\\X', lastOpenedAt: '2026-01-01T00:00:00Z' }, { path: 'd:/x/', lastOpenedAt: '2026-02-01T00:00:00Z', pinned: true }], 'win32').length, 1);
});

test('13. only names, paths, times and pin flags are ever persisted — never credentials or anything else', () =>
  withDir(async (root) => {
    const settingsFile = path.join(root, 'userData', 'settings.json');
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(
      settingsFile,
      JSON.stringify({
        defaultProjectPath: null,
        apiKey: 'sk-ant-api03-FAKE',
        recentProjects: [{ path: await project(root, 'alpha'), lastOpenedAt: '2026-10-01T00:00:00Z', token: 'ghp_FAKE', cookie: 'x' }, 'garbage', { path: 'relative/path', lastOpenedAt: '2026-10-01T00:00:00Z' }],
      }),
      'utf8',
    );
    const { svc } = await service(root);
    await svc.open(await project(root, 'beta'));
    const text = await readFile(settingsFile, 'utf8');
    assert.ok(!/sk-ant|ghp_|cookie|token|apiKey/.test(text), text);
    const saved = JSON.parse(text);
    assert.deepEqual(Object.keys(saved).sort(), ['defaultProjectPath', 'recentProjects']);
    for (const e of saved.recentProjects) assert.deepEqual(Object.keys(e).sort(), ['id', 'lastOpenedAt', 'name', 'path', 'pinned']);
    assert.equal(saved.recentProjects.length, 2, 'malformed and relative entries are dropped');
  }));

test('14. the renderer can only name a history entry by id — no paths, no extra fields, no file operations', () => {
  assert.equal(validateRequest('project:openRecent', { id: 'a1b2c3d4e5f60718' }).ok, true);
  for (const bad of [{ id: 'C:\\Windows' }, { id: '../settings.json' }, { id: 'A1B2C3D4E5F60718' }, { id: 'a1b2c3d4e5f60718', path: 'C:\\' }, { path: 'D:\\x' }, null]) {
    assert.equal(validateRequest('project:openRecent', bad).ok, false, JSON.stringify(bad));
    assert.equal(validateRequest('project:removeRecent', bad).ok, false, JSON.stringify(bad));
    assert.equal(validateRequest('project:locate', bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateRequest('project:setPinned', { id: 'a1b2c3d4e5f60718', pinned: 'yes' }).ok, false);
  assert.equal(validateRequest('project:getHistory', { path: 'D:\\' }).ok, false);
  assert.equal(validateRequest('project:getHistory', undefined).ok, true);
});

test('15. switching keeps working: the explicit default project wins at startup; a refused open records nothing', () =>
  withDir(async (root) => {
    const a = await project(root, 'alpha');
    const b = await project(root, 'beta');
    const first = await service(root);
    await first.svc.open(a);
    await first.svc.open(b);
    await first.svc.setDefaultProject(a);

    const next = await service(root);
    assert.equal((await next.svc.restoreAtStartup()).path, a, 'existing "default project" setting still decides');
    assert.equal(next.svc.settings.defaultProjectPath, a, 'history writes never clobber the default');

    const refusing = await service(root, { failOpen: 'không đổi project khi run đang chạy' });
    const before = refusing.svc.settings.recentProjects;
    const r = await refusing.svc.open(b);
    assert.deepEqual(r, { ok: false, reason: 'không đổi project khi run đang chạy' });
    assert.deepEqual(refusing.svc.settings.recentProjects, before);
    assert.equal((await refusing.svc.open(path.join(root, 'nope'))).ok, false, 'invalid folders are refused by validation');
  }));
