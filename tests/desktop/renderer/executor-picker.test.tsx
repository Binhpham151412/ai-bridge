import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { StartRunDialog } from '../../../src/desktop/renderer/components/StartRunDialog.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import { CLAUDE_PERMISSION_CAPABILITY } from '../../../src/adapters/claude/claude-code-cli-adapter.ts';
import { CODEX_PERMISSION_CAPABILITY } from '../../../src/adapters/chatgpt/codex-cli-adapter.ts';
import { OPENCODE_PERMISSION_CAPABILITY } from '../../../src/adapters/opencode/opencode-cli-adapter.ts';
import type { ExecutorProviderId } from '../../../src/core/executor/executor-adapter.ts';
import type { ExecutorProviderView, SettingsView } from '../../../src/desktop/shared/ipc-contract.ts';
import { FakeMain, click, flush, makeSnapshot, q, render } from './harness.tsx';

// docs/64 — Settings → "Developer AI (executor)": detected CLIs, click to choose, and the places
// that name the developer (Start dialog, Run view, sidebar). Fake Main only: nothing is spawned.

function settings(executor: ExecutorProviderId, opencodeModel: string | null = null): SettingsView {
  return {
    app: { defaultProjectPath: null },
    project: {
      config: {
        maxIterations: 10,
        claudeTimeoutMs: 1_800_000,
        codexTimeoutMs: 600_000,
        reportMaxBytes: 1_048_576,
        stopOnUncommittedChanges: false,
        requireGitRepository: false,
        permissions: { claude: 'bypass', codex: 'bypass', opencode: 'bypass' },
        models: { claude: null, opencode: opencodeModel },
        executor: { provider: executor },
      },
      errors: [],
      path: 'D:\\work\\demo\\.ai-bridge\\config.json',
      exists: true,
      permissionCapabilities: [CLAUDE_PERMISSION_CAPABILITY, OPENCODE_PERMISSION_CAPABILITY, CODEX_PERMISSION_CAPABILITY],
    },
    logs: { maxFileBytes: 2_000_000 },
  };
}

const DETECTED: ExecutorProviderView[] = [
  { id: 'claude-code', displayName: 'Claude Code', installed: true, version: '2.1.161', ready: true, message: 'Claude Code is installed and logged in.', loginHint: 'claude auth login --claudeai', modelHint: 'an alias or id' },
  { id: 'opencode', displayName: 'OpenCode', installed: true, version: '1.14.30', ready: false, message: 'OpenCode is installed but has no stored credentials.', loginHint: 'opencode auth login', modelHint: 'provider/model' },
];

async function open(view: SettingsView, detected: ExecutorProviderView[] | 'error' = DETECTED) {
  const main = new FakeMain(makeSnapshot());
  main.handlers.set('bridge:getSettings', () => ({ ok: true, data: view }));
  main.handlers.set('bridge:saveProjectConfig', () => ({ ok: true, message: 'saved' }));
  main.handlers.set('providers:list', () => (detected === 'error' ? { ok: false, error: { code: 'X', title: 'x', message: 'x' } } : { ok: true, data: detected }));
  const r = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  await click(q(r.container, 'nav-settings'));
  return { main, ...r };
}

const savedConfig = (main: FakeMain): { executor?: unknown; models?: unknown; permissions?: unknown } => {
  const call = main.invoked.find((c) => c.channel === 'bridge:saveProjectConfig');
  assert.ok(call, 'saveProjectConfig was called');
  return (call!.args[0] as { config: { executor?: unknown; models?: unknown; permissions?: unknown } }).config;
};

const submit = (container: HTMLElement) => click([...container.querySelectorAll('button[type="submit"]')].find((b) => b.textContent === 'Lưu cấu hình'));

test('Settings lists every executor CLI with what was detected; the project setting is the selected one', async () => {
  const { container, unmount } = await open(settings('claude-code'));
  try {
    assert.ok(q(container, 'executor-section'));
    assert.equal((q(container, 'executor-claude-code-radio') as HTMLInputElement).checked, true);
    assert.equal((q(container, 'executor-opencode-radio') as HTMLInputElement).checked, false);
    assert.match(q(container, 'executor-claude-code-badge')!.textContent!, /Sẵn sàng/);
    assert.match(q(container, 'executor-opencode-badge')!.textContent!, /Đã cài, chưa đăng nhập/);
    const message = q(container, 'executor-opencode-message')!.textContent!;
    assert.match(message, /no stored credentials/);
    assert.match(message, /opencode auth login/, 'a CLI that is not ready tells how to sign in');
    assert.match(message, /1\.14\.30/);
    assert.doesNotMatch(q(container, 'executor-claude-code-message')!.textContent!, /Đăng nhập:/, 'a ready CLI does not');
  } finally {
    await unmount();
  }
});

test('a CLI that is not installed says so, and "Dò lại" asks Main to detect again', async () => {
  const missing: ExecutorProviderView[] = [DETECTED[0], { ...DETECTED[1], installed: false, version: null, ready: false, message: 'OpenCode CLI (opencode) was not found on PATH.' }];
  const { main, container, unmount } = await open(settings('claude-code'), missing);
  try {
    assert.match(q(container, 'executor-opencode-badge')!.textContent!, /Chưa cài/);
    const before = main.invoked.filter((c) => c.channel === 'providers:list').length;
    await click(q(container, 'executor-refresh'));
    assert.equal(main.invoked.filter((c) => c.channel === 'providers:list').length, before + 1);
  } finally {
    await unmount();
  }
});

test('a failed detection leaves the cards usable (nothing detected, nothing hidden)', async () => {
  const { container, unmount } = await open(settings('claude-code'), 'error');
  try {
    assert.ok(q(container, 'executor-opencode'));
    assert.match(q(container, 'executor-opencode-badge')!.textContent!, /Chưa dò được/);
    assert.match(q(container, 'executor-opencode-message')!.textContent!, /Dò lại/);
  } finally {
    await unmount();
  }
});

test('clicking OpenCode and saving sends executor + model + the OpenCode permission fieldset; Claude model section is replaced', async () => {
  const { main, container, unmount } = await open(settings('claude-code'));
  try {
    assert.ok(q(container, 'model-claude-select'), 'Claude model picker while Claude is the executor');
    assert.equal(q(container, 'permission-opencode'), null, 'only the selected executor and the reviewer have a permission fieldset');
    await click(q(container, 'executor-opencode-radio'));
    assert.equal((q(container, 'executor-opencode-radio') as HTMLInputElement).checked, true);
    assert.equal(q(container, 'model-claude-select'), null);
    assert.ok(q(container, 'permission-opencode'));
    assert.equal(q(container, 'permission-claude'), null);
    assert.ok(q(container, 'permission-codex'));
    assert.match(q(container, 'permission-opencode')!.textContent!, /--dangerously-skip-permissions/);

    const input = q(container, 'model-opencode') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'anthropic/claude-opus-5-5');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await submit(container);
    const config = savedConfig(main);
    assert.deepEqual(config.executor, { provider: 'opencode' });
    assert.deepEqual(config.models, { claude: null, opencode: 'anthropic/claude-opus-5-5' });
  } finally {
    await unmount();
  }
});

test('saving the executor updates the sidebar and the Run tile without reopening the app', async () => {
  const { main, container, unmount } = await open(settings('claude-code'));
  try {
    assert.match(container.querySelector('.sidebar-foot')!.textContent!, /^Claude CLI ⇄ Codex CLI · \$0$/);
    // After the save, Main would return the new setting from getSettings.
    main.handlers.set('bridge:getSettings', () => ({ ok: true, data: settings('opencode') }));
    await click(q(container, 'executor-opencode-radio'));
    await submit(container);
    await flush();
    assert.match(container.querySelector('.sidebar-foot')!.textContent!, /^OpenCode CLI ⇄ Codex CLI$/);
    await click(q(container, 'nav-run'));
    assert.match(q(container, 'agent-claude')!.textContent!, /Developer · OpenCode CLI/);
  } finally {
    await unmount();
  }
});

test('a project already set to OpenCode opens on it, with its saved model', async () => {
  const { container, unmount } = await open(settings('opencode', 'opencode/big-pickle'));
  try {
    assert.equal((q(container, 'executor-opencode-radio') as HTMLInputElement).checked, true);
    assert.equal((q(container, 'model-opencode') as HTMLInputElement).value, 'opencode/big-pickle');
  } finally {
    await unmount();
  }
});

test('the bypass warning follows the selected executor and the reviewer, not a hidden provider', async () => {
  const view = settings('claude-code');
  view.project!.config.permissions = { claude: 'ask', codex: 'ask', opencode: 'bypass' };
  const { container, unmount } = await open(view);
  try {
    assert.equal(q(container, 'permission-bypass-warning'), null, 'OpenCode is on bypass but not in use');
    await click(q(container, 'executor-opencode-radio'));
    assert.ok(q(container, 'permission-bypass-warning'));
  } finally {
    await unmount();
  }
});

test('the Start dialog and the sidebar name the executor the project uses', async () => {
  const main = new FakeMain(makeSnapshot());
  main.handlers.set('bridge:getSettings', () => ({ ok: true, data: settings('opencode', 'anthropic/claude-opus-5-5') }));
  const r = await render(
    <BridgeProvider api={main.api}>
      <StartRunDialog onClose={() => {}} />
    </BridgeProvider>,
  );
  try {
    await flush();
    assert.equal((q(r.container, 'start-developer') as HTMLInputElement).value, 'OpenCode CLI (executor)');
    assert.equal((q(r.container, 'start-reviewer') as HTMLInputElement).value, 'Codex CLI (ChatGPT sign-in)', 'the reviewer is not pluggable');
    assert.match(r.container.textContent!, /Task cho OpenCode/);
    assert.match(q(r.container, 'start-permissions')!.textContent!, /OpenCode model: anthropic\/claude-opus-5-5 · Permissions — OpenCode: bypass, Codex: bypass/);
  } finally {
    await r.unmount();
  }
  const app = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  try {
    await flush();
    assert.match(app.container.querySelector('.sidebar-foot')!.textContent!, /^OpenCode CLI ⇄ Codex CLI$/, 'no "$0" claim for a CLI that may bill an API key');
    assert.match(q(app.container, 'agent-claude')!.textContent!, /OpenCode/);
    assert.match(q(app.container, 'agent-claude')!.textContent!, /Developer · OpenCode CLI/);
  } finally {
    await app.unmount();
  }
});

test('a run that was started with OpenCode keeps naming OpenCode even if the setting changed since', async () => {
  const main = new FakeMain(makeSnapshot({ status: { status: 'DONE', iteration: 1, executor: 'opencode' } }));
  main.handlers.set('bridge:getSettings', () => ({ ok: true, data: settings('claude-code') }));
  const r = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  try {
    await flush();
    assert.match(q(r.container, 'agent-claude')!.textContent!, /Developer · OpenCode CLI/);
  } finally {
    await r.unmount();
  }
});
