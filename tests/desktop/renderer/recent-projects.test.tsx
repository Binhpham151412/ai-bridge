import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import type { ProjectHistoryView } from '../../../src/desktop/shared/ipc-contract.ts';
import { FakeMain, click, makeSnapshot, q, qa, render } from './harness.tsx';

// docs/63 — "Dự án gần đây" on the start screen (no project open).

const ALPHA = 'a1a1a1a1a1a1a1a1';
const GONE = 'b2b2b2b2b2b2b2b2';

function history(): ProjectHistoryView {
  return {
    restore: { outcome: 'MISSING', name: 'gone', path: 'D:\\work\\gone', reason: 'Thư mục project không tồn tại.' },
    entries: [
      { id: GONE, name: 'gone', path: 'D:\\work\\gone', lastOpenedAt: '2026-10-02T09:00:00.000Z', pinned: true, status: 'MISSING', active: false },
      { id: ALPHA, name: 'alpha', path: 'D:\\work\\alpha', lastOpenedAt: '2026-10-01T09:00:00.000Z', pinned: false, status: 'AVAILABLE', active: false },
    ],
  };
}

async function openApp(view: ProjectHistoryView) {
  const main = new FakeMain(makeSnapshot({ project: null, status: null }));
  main.handlers.set('project:getHistory', () => ({ ok: true, data: view }));
  for (const ch of ['project:openRecent', 'project:setPinned', 'project:removeRecent', 'project:locate']) main.handlers.set(ch, () => ({ ok: true }));
  const r = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  return { main, ...r };
}

const calls = (main: FakeMain, channel: string) => main.invoked.filter((c) => c.channel === channel).map((c) => c.args);

test('no project open: "Dự án gần đây" lists entries (pinned first), shows Missing and why the last project was not restored', async () => {
  const { container, unmount } = await openApp(history());
  try {
    const box = q(container, 'recent-projects')!;
    assert.ok(box, 'shown on the start screen, next to "Chọn project…"');
    assert.match(box.textContent!, /Dự án gần đây/);
    assert.match(q(box, 'recent-restore-missing')!.textContent!, /Không mở lại được project gần nhất "gone"/);
    const items = qa(box, 'recent-item');
    assert.equal(items.length, 2);
    assert.match(items[0].textContent!, /gone.*Đã ghim.*Status: Missing.*D:\\work\\gone/);
    assert.match(items[1].textContent!, /alpha.*D:\\work\\alpha.*Mở lần cuối/);
    assert.ok(q(items[0], 'recent-locate'), 'a missing project offers "Tìm lại…" instead of "Mở"');
    assert.equal(q(items[0], 'recent-open'), null);
    assert.ok(q(items[1], 'recent-open'));
  } finally {
    await unmount();
  }
});

test('actions send only the entry id to Main: open, pin/unpin, locate, remove (after confirmation)', async () => {
  const { main, container, unmount } = await openApp(history());
  const w = window as unknown as { confirm: (m: string) => boolean };
  const original = w.confirm;
  const asked: string[] = [];
  try {
    const [gone, alpha] = qa(container, 'recent-item');
    await click(q(alpha, 'recent-open'));
    assert.deepEqual(calls(main, 'project:openRecent'), [[{ id: ALPHA }]]);
    await click(q(alpha, 'recent-pin'));
    await click(q(gone, 'recent-pin'));
    assert.deepEqual(calls(main, 'project:setPinned'), [[{ id: ALPHA, pinned: true }], [{ id: GONE, pinned: false }]]);
    await click(q(gone, 'recent-locate'));
    assert.deepEqual(calls(main, 'project:locate'), [[{ id: GONE }]]);

    w.confirm = (m) => (asked.push(m), false);
    await click(q(gone, 'recent-remove'));
    assert.deepEqual(calls(main, 'project:removeRecent'), [], 'declined → nothing removed');
    assert.match(asked[0], /thư mục project KHÔNG bị xoá/);
    w.confirm = () => true;
    await click(q(gone, 'recent-remove'));
    assert.deepEqual(calls(main, 'project:removeRecent'), [[{ id: GONE }]]);
    // Paths never travel from the renderer.
    for (const c of main.invoked.filter((x) => x.channel.startsWith('project:'))) assert.ok(!JSON.stringify(c.args).includes('work'), JSON.stringify(c.args));
  } finally {
    w.confirm = original;
    await unmount();
  }
});

test('empty history: a short hint, and "Chọn project…" still opens the native picker', async () => {
  const { main, container, unmount } = await openApp({ entries: [], restore: { outcome: 'NONE', name: null, path: null, reason: null } });
  try {
    assert.ok(q(container, 'recent-empty'));
    const choose = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Chọn project…' && b.closest('.empty'));
    await click(choose);
    assert.equal(calls(main, 'bridge:selectProject').length, 1);
  } finally {
    await unmount();
  }
});
