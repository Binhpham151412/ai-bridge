import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrictMode } from 'react';
import { ActivityLog } from '../../../src/desktop/renderer/components/ActivityLog.tsx';
import { BridgeProvider, useBridge } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import { FakeMain, event, flush, makeSnapshot, qa, render } from './harness.tsx';

function Log() {
  const { events } = useBridge();
  return <ActivityLog events={events} />;
}

const tree = (main: FakeMain) => (
  <BridgeProvider api={main.api}>
    <Log />
  </BridgeProvider>
);

test('mount → mount → unmount → mount: one live listener, every event rendered exactly once', async () => {
  const main = new FakeMain(makeSnapshot({}));
  const first = await render(tree(main));
  await first.rerender(tree(main)); // "mount" again on the same root — must not re-subscribe
  assert.equal(main.listenerCount('bridge:event'), 1);
  await first.unmount();
  assert.equal(main.listenerCount('bridge:event'), 0);
  assert.equal(main.listenerCount('bridge:snapshot'), 0);

  const second = await render(tree(main));
  try {
    assert.equal(main.listenerCount('bridge:event'), 1);
    main.pushEvent(event());
    await flush();
    assert.equal(qa(second.container, 'activity-row').length, 1);
  } finally {
    await second.unmount();
  }
});

test('StrictMode (dev double mount/unmount) still ends with exactly one listener and no duplicate rows', async () => {
  const main = new FakeMain(makeSnapshot({}));
  const view = await render(<StrictMode>{tree(main)}</StrictMode>);
  try {
    assert.equal(main.listenerCount('bridge:event'), 1);
    assert.equal(main.listenerCount('bridge:snapshot'), 1);
    main.pushEvent(event());
    main.pushEvent(event({ timestamp: '2026-09-26T01:02:04.000Z', event: 'CLAUDE_EXITED', detail: 'claude exited 0' }));
    await flush();
    assert.equal(qa(view.container, 'activity-row').length, 2);
  } finally {
    await view.unmount();
  }
  assert.equal(main.listenerCount('bridge:event'), 0);
});

test('repeated mount/unmount cycles leak no listeners', async () => {
  const main = new FakeMain(makeSnapshot({}));
  for (let i = 0; i < 25; i++) {
    const view = await render(tree(main));
    await view.unmount();
  }
  assert.equal(main.listenerCount('bridge:event'), 0);
  assert.equal(main.listenerCount('bridge:snapshot'), 0);
});

test('the activity list is bounded (M4 §32) — old rows drop off instead of growing forever', async () => {
  const main = new FakeMain(makeSnapshot({}));
  const view = await render(tree(main));
  try {
    main.pushEvents(Array.from({ length: 620 }, (_, i) => event({ timestamp: new Date(Date.UTC(2026, 8, 26, 1, 0, 0, i)).toISOString(), detail: `n${i}` })));
    await flush();
    const rows = qa(view.container, 'activity-row');
    assert.equal(rows.length, 500);
    assert.match(rows[rows.length - 1].textContent!, /n619/);
  } finally {
    await view.unmount();
  }
});
