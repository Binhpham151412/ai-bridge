import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexCliAdapter } from '../src/adapters/chatgpt/codex-cli-adapter.ts';
import { establishReadOnly } from '../src/core/judge/codex-lockdown.ts';
import { realCodexLocator } from '../src/core/judge/real-codex-locator.ts';

/**
 * The isolation check against the codex that is really installed. It asks the CLI for `exec --help`, `features list`
 * and `debug prompt-input` (local information, no model is called, no ticket or draft exists), so it costs nothing,
 * but it depends on the machine: it runs only with AI_BRIDGE_REAL_CODEX_PROBE=1.
 */
const enabled = process.env.AI_BRIDGE_REAL_CODEX_PROBE === '1';

test('the installed codex can be put in read-only isolation (no model is called)', { skip: !enabled }, async () => {
  const executable = await realCodexLocator();
  assert.ok(executable !== null, 'the codex CLI was not found');
  const outcome = await establishReadOnly(new CodexCliAdapter({ executable }), { ...process.env });
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason);
  if (outcome.ok) {
    assert.ok(outcome.lockdown.args.includes('--ignore-user-config'));
    process.stdout.write(`# real codex: disabled ${outcome.lockdown.disabled.join(',')}; tools left ${outcome.lockdown.tools.join(',')}\n`);
  }
});
