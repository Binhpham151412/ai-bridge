import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import type { SettingsView } from '../../../src/desktop/shared/ipc-contract.ts';
import { FakeMain, click, flush, makeSnapshot, q, render } from './harness.tsx';

// M4.2 — Start Run: Developer/Reviewer (fixed, informational), "Maximum review rounds"
// preset select (1,2,3,5,10,20,30,50,Custom…), safety cap 100.

const SETTINGS: SettingsView = {
  app: { defaultProjectPath: null },
  project: {
    config: { maxIterations: 10, claudeTimeoutMs: 1_800_000, codexTimeoutMs: 600_000, reportMaxBytes: 1_048_576, stopOnUncommittedChanges: false, requireGitRepository: false },
    errors: [],
    path: 'D:\\work\\demo\\.ai-bridge\\config.json',
    exists: true,
  },
  logs: { maxFileBytes: 2_000_000 },
};

// Node's global `Event` and happy-dom's are different classes — dispatchEvent on a
// happy-dom element requires an instance of *its* Event, so it must come from the
// happy-dom `window` dom-setup.ts installs, not the ambient global.
function domEvent(type: string): Event {
  const Ctor = (globalThis as unknown as { window: { Event: typeof Event } }).window.Event;
  return new Ctor(type, { bubbles: true });
}

function setValue(el: Element, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(domEvent('input'));
  if (el instanceof HTMLSelectElement) el.dispatchEvent(domEvent('change'));
}

async function change(el: Element | null | undefined, value: string): Promise<void> {
  if (!el) throw new Error('element not found');
  await act(async () => setValue(el, value));
  await flush();
}

async function openDialog(overrides: Partial<SettingsView> = {}) {
  const main = new FakeMain(makeSnapshot());
  main.handlers.set('bridge:getSettings', () => ({ ok: true, data: { ...SETTINGS, ...overrides } }));
  const view = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  await click(q(view.container, 'btn-start'));
  return { main, ...view };
}

test('Start Run shows the fixed Developer/Reviewer pipeline and defaults "Maximum review rounds" to the project config', async () => {
  const { container, unmount } = await openDialog();
  try {
    assert.equal((q(container, 'start-developer') as HTMLInputElement).value, 'Claude Code CLI (executor)');
    assert.equal((q(container, 'start-reviewer') as HTMLInputElement).value, 'Codex CLI (ChatGPT sign-in)');
    assert.equal((q(container, 'start-max-preset') as HTMLSelectElement).value, '10');
    assert.equal(q(container, 'start-max-custom'), null, 'no custom input while a preset is selected');
    assert.match(container.textContent!, /Maximum rounds — run stops earlier if reviewer returns DONE\./);
  } finally {
    await unmount();
  }
});

test('picking a preset sends exactly that maxIterations to bridge:start', async () => {
  const { main, container, unmount } = await openDialog();
  try {
    await change(q(container, 'start-task'), 'Do the thing');
    await change(q(container, 'start-max-preset'), '3');
    await click(q(container, 'start-submit'));
    assert.deepEqual(main.invoked.find((c) => c.channel === 'bridge:start')?.args, [{ task: 'Do the thing', maxIterations: 3 }]);
  } finally {
    await unmount();
  }
});

test('"Custom…" reveals a number input (1–100) and sends the typed value', async () => {
  const { main, container, unmount } = await openDialog();
  try {
    await change(q(container, 'start-task'), 'Do the thing');
    await change(q(container, 'start-max-preset'), 'CUSTOM');
    const custom = q(container, 'start-max-custom');
    assert.ok(custom, 'custom input appears once "Custom…" is selected');
    await change(custom, '77');
    assert.equal((q(container, 'start-submit') as HTMLButtonElement).disabled, false);
    await click(q(container, 'start-submit'));
    assert.deepEqual(main.invoked.find((c) => c.channel === 'bridge:start')?.args, [{ task: 'Do the thing', maxIterations: 77 }]);
  } finally {
    await unmount();
  }
});

test('a custom value above the safety cap (100) disables START — never silently clamped', async () => {
  const { container, unmount } = await openDialog();
  try {
    await change(q(container, 'start-task'), 'Do the thing');
    await change(q(container, 'start-max-preset'), 'CUSTOM');
    await change(q(container, 'start-max-custom'), '101');
    assert.equal((q(container, 'start-submit') as HTMLButtonElement).disabled, true);
    assert.match(container.textContent!, /1 – 100/);
  } finally {
    await unmount();
  }
});
