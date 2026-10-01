import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../../src/desktop/renderer/components/App.tsx';
import { ExecutionPanel } from '../../../src/desktop/renderer/components/ExecutionPanel.tsx';
import { BridgeProvider } from '../../../src/desktop/renderer/state/BridgeProvider.tsx';
import { CLAUDE_PERMISSION_CAPABILITY } from '../../../src/adapters/claude/claude-code-cli-adapter.ts';
import { CODEX_PERMISSION_CAPABILITY } from '../../../src/adapters/chatgpt/codex-cli-adapter.ts';
import type { ExecutionRecord } from '../../../src/core/execution/execution-record.ts';
import type { SettingsView } from '../../../src/desktop/shared/ipc-contract.ts';
import { FakeMain, click, makeSnapshot, q, render } from './harness.tsx';

// M5.10.1 — Settings → "AI Execution Permissions" and the per-execution audit row.

function settings(permissions: { claude: 'ask' | 'bypass'; codex: 'ask' | 'bypass' }): SettingsView {
  return {
    app: { defaultProjectPath: null },
    project: {
      config: { maxIterations: 10, claudeTimeoutMs: 1_800_000, codexTimeoutMs: 600_000, reportMaxBytes: 1_048_576, stopOnUncommittedChanges: false, requireGitRepository: false, permissions },
      errors: [],
      path: 'D:\\work\\demo\\.ai-bridge\\config.json',
      exists: false,
      permissionCapabilities: [CLAUDE_PERMISSION_CAPABILITY, CODEX_PERMISSION_CAPABILITY],
    },
    logs: { maxFileBytes: 2_000_000 },
  };
}

async function openSettings(view: SettingsView) {
  const main = new FakeMain(makeSnapshot());
  main.handlers.set('bridge:getSettings', () => ({ ok: true, data: view }));
  main.handlers.set('bridge:saveProjectConfig', () => ({ ok: true, message: 'saved' }));
  const r = await render(
    <BridgeProvider api={main.api}>
      <App />
    </BridgeProvider>,
  );
  await click(q(r.container, 'nav-settings'));
  return { main, ...r };
}

test('Settings shows "AI Execution Permissions" with bypass selected by default, the statement and the bypass warning', async () => {
  const { container, unmount } = await openSettings(settings({ claude: 'bypass', codex: 'bypass' }));
  try {
    const section = q(container, 'permissions-section')!;
    assert.ok(section);
    assert.match(section.textContent!, /AI Execution Permissions/);
    assert.match(section.textContent!, /Bypass permissions allows the AI provider to execute supported operations without interactive permission prompts\./);
    assert.match(q(container, 'permission-bypass-warning')!.textContent!, /Permission bypass is enabled by default\./);
    assert.equal((q(container, 'permission-claude-bypass') as HTMLInputElement).checked, true);
    assert.equal((q(container, 'permission-codex-bypass') as HTMLInputElement).checked, true);
    // Only the modes each installed CLI declares — with the real CLI mechanism shown.
    assert.match(q(container, 'permission-claude')!.textContent!, /--permission-mode bypassPermissions/);
    assert.match(q(container, 'permission-codex')!.textContent!, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(q(container, 'permission-codex')!.textContent!, /no approval prompts in codex exec/);
  } finally {
    await unmount();
  }
});

test('changing a provider to ask and saving sends the permissions through the validated saveProjectConfig channel', async () => {
  const { main, container, unmount } = await openSettings(settings({ claude: 'bypass', codex: 'bypass' }));
  try {
    await click(q(container, 'permission-claude-ask'));
    assert.equal((q(container, 'permission-claude-ask') as HTMLInputElement).checked, true);
    const submit = [...container.querySelectorAll('button[type="submit"]')].find((b) => b.textContent === 'Lưu cấu hình');
    await click(submit);
    const call = main.invoked.find((c) => c.channel === 'bridge:saveProjectConfig');
    assert.ok(call);
    const sent = (call.args[0] as { config: Record<string, unknown> }).config;
    assert.deepEqual(sent.permissions, { claude: 'ask', codex: 'bypass' });
    assert.equal(sent.maxIterations, 10, 'scalar fields are still sent as numbers, untouched');
  } finally {
    await unmount();
  }
});

test('with every provider on ask, the bypass warning is not shown', async () => {
  const { container, unmount } = await openSettings(settings({ claude: 'ask', codex: 'ask' }));
  try {
    assert.equal(q(container, 'permission-bypass-warning'), null);
    assert.equal((q(container, 'permission-codex-ask') as HTMLInputElement).checked, true);
  } finally {
    await unmount();
  }
});

const RECORD: ExecutionRecord = {
  schema: 1,
  agent: 'claude',
  iteration: 1,
  bridgeSessionId: '2026-10-01_001',
  mode: 'NEW',
  cliSessionId: { requested: 'a', reported: 'a', evidence: 'CONFIRMED_BY_CLI' },
  continuity: { expected: null, reported: null, verdict: 'NOT_APPLICABLE', note: '' },
  input: { file: '001-claude-prompt.md', sha256: 'b'.repeat(64), bytes: 1, delivery: 'STDIN_FLUSHED_AND_CLOSED', deliveredAt: null, deliveryError: null },
  process: { pid: 1, startedAt: null, endedAt: null, durationMs: null, exitCode: 0, signal: null, timedOut: false },
  status: 'COMPLETED',
  errorCode: null,
  output: { kind: 'CLI_OUTPUT', stdoutFile: null, stdoutBytes: 0, stdoutTruncated: false, stderrFile: null, stderrBytes: 0, stderrTruncated: false },
  command: { executable: 'claude.exe', args: [] },
  updatedAt: '2026-10-01T00:00:00.000Z',
};

test('the execution panel answers "why did this call not ask?" from the record — and says UNKNOWN for older records', async () => {
  const main = new FakeMain(makeSnapshot());
  const withPolicy: ExecutionRecord = {
    ...RECORD,
    permission: { provider: 'claude', requested: 'inherit', resolved: 'bypass', source: 'provider-setting', reason: 'Global provider permission policy (claude) = bypass', cliArgs: ['--permission-mode', 'bypassPermissions'] },
  };
  const view = await render(
    <BridgeProvider api={main.api}>
      <ExecutionPanel runId="2026-10-01_001" agent="claude" iteration={1} execution={{ record: withPolicy, effectiveStatus: 'COMPLETED' }} inputArtifact={null} isLiveStep={false} onViewInput={() => {}} />
    </BridgeProvider>,
  );
  try {
    assert.match(q(view.container, 'exec-permission')!.textContent!, /bypass — Global provider permission policy \(claude\) = bypass · --permission-mode bypassPermissions/);
    await view.rerender(
      <BridgeProvider api={main.api}>
        <ExecutionPanel runId="2026-10-01_001" agent="claude" iteration={1} execution={{ record: RECORD, effectiveStatus: 'COMPLETED' }} inputArtifact={null} isLiveStep={false} onViewInput={() => {}} />
      </BridgeProvider>,
    );
    assert.match(q(view.container, 'exec-permission')!.textContent!, /^UNKNOWN/);
  } finally {
    await view.unmount();
  }
});
