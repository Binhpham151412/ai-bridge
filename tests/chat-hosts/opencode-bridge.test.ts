import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../../src/adapters/chatgpt/codex-cli-adapter.ts';
import { loadLoopState } from '../../src/claude-code/bridge-loop.ts';
import { BRIDGE_COMMAND, createBridgeHooks, type BridgeDeps, type OpenCodeClient } from '../../src/chat-hosts/opencode/bridge.ts';

const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex/fake-codex.mjs', import.meta.url));
const BUILD = fileURLToPath(new URL('../../scripts/chat-hosts/build.ts', import.meta.url));
const SESSION = 'ses_e7c9eb641ffeqP3DQo7i22kNq2';
const REPLY = 'Done.\n\n## TASK\nfix login\n## CHANGES\nsrc/login.ts\n## TESTS\npass\n## ISSUES\nnone\n## NEXT_RECOMMENDATION\nnone\nNEXT_ACTION: DONE';

interface Calls {
  prompts: Array<{ id: string; noReply?: boolean; parts: Array<{ text: string; synthetic?: boolean; ignored?: boolean }> }>;
  asyncPrompts: Calls['prompts'];
  toasts: Array<{ message: string; variant: string }>;
  notified: string[];
}

/** A fake OpenCode client whose session ends with the assistant message `reply` (or any `messages`). */
function fakeClient(calls: Calls, messages: () => unknown[]): OpenCodeClient {
  return {
    session: {
      messages: async () => ({ data: messages() as never }),
      prompt: async (o) => void calls.prompts.push({ id: o.path.id, noReply: o.body.noReply, parts: o.body.parts }),
      promptAsync: async (o) => void calls.asyncPrompts.push({ id: o.path.id, parts: o.body.parts }),
    },
    tui: { showToast: async (o) => void calls.toasts.push({ message: o.body.message, variant: o.body.variant }) },
  };
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  info: { role: 'assistant', time: { completed: 1 }, ...extra },
  parts: [{ type: 'text', text }],
});

async function withBridge<T>(
  opts: { env?: Record<string, string>; messages?: () => unknown[]; codex?: BridgeDeps['locateCodex'] },
  fn: (h: { hooks: ReturnType<typeof createBridgeHooks>; calls: Calls; root: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-oc-'));
  const calls: Calls = { prompts: [], asyncPrompts: [], toasts: [], notified: [] };
  const hooks = createBridgeHooks({
    client: fakeClient(calls, opts.messages ?? (() => [assistant(REPLY)])),
    directory: root,
    stateRoot: root,
    now: () => new Date('2026-10-28T10:00:00.000Z'),
    env: { ...process.env, ...opts.env },
    codexTimeoutMs: 10_000,
    retryMs: 0,
    notify: (_title, body) => void calls.notified.push(body),
    locateCodex: opts.codex ?? (async () => new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] })),
  });
  try {
    return await fn({ hooks, calls, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const arm = (hooks: ReturnType<typeof createBridgeHooks>, args = 'fix login') => {
  const output = { parts: [{ type: 'text', text: 'template' }] as unknown[] };
  return hooks['command.execute.before']({ command: 'bridge', sessionID: SESSION, arguments: args }, output).then(() => output);
};
const idle = (hooks: ReturnType<typeof createBridgeHooks>, sessionID = SESSION) => hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });

test('config registers /bridge as a command whose text is the task', async () => {
  await withBridge({}, async ({ hooks }) => {
    const cfg: { command?: Record<string, unknown> } = { command: { other: { template: 'x' } } };
    await hooks.config(cfg);
    assert.deepEqual(Object.keys(cfg.command ?? {}).sort(), ['bridge', 'other']);
    assert.match(BRIDGE_COMMAND.template, /\$ARGUMENTS/);
  });
});

test('/bridge <task> arms the loop for the session and adds the report contract to the prompt for the model only', () =>
  withBridge({}, async ({ hooks, root }) => {
    const output = await arm(hooks);
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.status, 'RUNNING');
    assert.equal(state?.task, 'fix login');
    assert.equal(state?.projectPath, root);
    const added = output.parts.at(-1) as { text: string; synthetic: boolean };
    assert.equal(added.synthetic, true);
    assert.match(added.text, /AI_BRIDGE_REVIEW_LOOP/);
    assert.match(added.text, /Tóm tắt cho bạn/);
  }));

test('another command is left alone', () =>
  withBridge({}, async ({ hooks, root }) => {
    const output = { parts: [] as unknown[] };
    await hooks['command.execute.before']({ command: 'init', sessionID: SESSION, arguments: 'fix login' }, output);
    assert.equal(output.parts.length, 0);
    assert.equal(await loadLoopState(root, SESSION), null);
  }));

test('/bridge stop with no loop: the message reaches the chat and a toast, and the command fails so the agent gets no turn', () =>
  withBridge({}, async ({ hooks, calls }) => {
    await assert.rejects(arm(hooks, 'stop'), /no review loop is running/);
    assert.equal(calls.prompts.length, 1);
    assert.equal(calls.prompts[0].noReply, true);
    assert.equal(calls.prompts[0].parts[0].ignored, true);
    assert.match(calls.prompts[0].parts[0].text, /no review loop is running/);
    assert.equal(calls.toasts.length, 1);
  }));

const status = (hooks: ReturnType<typeof createBridgeHooks>, type: 'busy' | 'idle') =>
  hooks.event({ event: { type: 'session.status', properties: { sessionID: SESSION, status: { type } } } });

test('/bridge stop while the agent is mid-turn: it stops at once, the chat line waits for the idle (a user message mid-turn makes OpenCode run one more step)', () =>
  withBridge({ codex: async () => assert.fail('looked up Codex') }, async ({ hooks, calls, root }) => {
    await arm(hooks);
    await status(hooks, 'busy');
    await assert.rejects(arm(hooks, 'stop'), /review loop stopped after 0 round/);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'STOPPED');
    assert.equal(calls.toasts.length, 1);
    assert.equal(calls.prompts.length, 0);
    await idle(hooks);
    assert.equal(calls.prompts.length, 1);
    assert.match(calls.prompts[0].parts[0].text, /review loop stopped after 0 round/);
  }));

test('a held chat line keeps waiting while another turn is running', () =>
  withBridge({}, async ({ hooks, calls }) => {
    await status(hooks, 'busy');
    await assert.rejects(arm(hooks, 'stop'), /no review loop is running/);
    await idle(hooks);
    assert.equal(calls.prompts.length, 1);
    await status(hooks, 'busy');
    await assert.rejects(arm(hooks, 'stop'), /no review loop is running/);
    await status(hooks, 'idle');
    assert.equal(calls.prompts.length, 1);
    await idle(hooks);
    assert.equal(calls.prompts.length, 2);
  }));

test('chat-only lines trailing the agent\'s message do not hide it from the review', () =>
  withBridge(
    {
      env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' },
      messages: () => [assistant('FINAL REPORT'), { info: { role: 'user' }, parts: [{ type: 'text', text: 'AI Bridge: earlier line', ignored: true }] }],
    },
    async ({ hooks, root }) => {
      await arm(hooks);
      await idle(hooks);
      assert.equal(await readFile(path.join(root, SESSION, 'loop-1', '001-report.md'), 'utf8'), 'FINAL REPORT');
    },
  ));

test('a session without a loop is never reviewed: Codex is not even looked up', () =>
  withBridge({ codex: async () => assert.fail('looked up Codex') }, async ({ hooks, calls }) => {
    await idle(hooks);
    assert.deepEqual([calls.prompts.length, calls.asyncPrompts.length], [0, 0]);
  }));

test('events with no session, and other events, are ignored', () =>
  withBridge({ codex: async () => assert.fail('looked up Codex') }, async ({ hooks }) => {
    await arm(hooks);
    await hooks.event({ event: { type: 'session.idle' } });
    await hooks.event({ event: { type: 'message.updated', properties: { sessionID: SESSION } } });
  }));

test('CONTINUE: Codex\'s instruction is sent as the next user message; the round line is chat-only and the contract model-only', () =>
  withBridge({ env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' } }, async ({ hooks, calls, root }) => {
    await arm(hooks);
    await idle(hooks);
    assert.equal(calls.asyncPrompts.length, 1);
    const [round, prompt, contract] = calls.asyncPrompts[0].parts;
    assert.equal(calls.asyncPrompts[0].id, SESSION);
    assert.equal(round.ignored, true);
    assert.match(round.text, /vòng 1\/10 · Codex: chưa duyệt/);
    assert.equal(prompt.synthetic, undefined);
    assert.equal(prompt.ignored, undefined);
    assert.match(prompt.text, /round 1: CONTINUE\. Next instruction:\n\nRound 2 instruction\.$/);
    assert.equal(contract.synthetic, true);
    assert.match(contract.text, /Begin your reply with one short line/);
    assert.match(contract.text, /AI_BRIDGE_REVIEW_LOOP/);
    assert.doesNotMatch(contract.text, /Round 2 instruction\./);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'RUNNING');
    assert.equal(calls.notified.length, 0);
  }));

test('DONE: the loop ends with a chat-only message, a toast and a notification; nothing more is sent', () =>
  withBridge({ env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' } }, async ({ hooks, calls, root }) => {
    await arm(hooks);
    await idle(hooks);
    assert.equal(calls.asyncPrompts.length, 0);
    assert.equal(calls.prompts.length, 1);
    assert.equal(calls.prompts[0].noReply, true);
    assert.match(calls.prompts[0].parts[0].text, /✅ Codex đã duyệt/);
    assert.equal(calls.prompts[0].parts[0].ignored, true);
    assert.equal(calls.toasts.at(-1)?.variant, 'success');
    assert.equal(calls.notified.length, 1);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'DONE');
    // a later idle (the chat-only message, the user's next turn) does not review a finished loop
    await idle(hooks);
    assert.equal(calls.prompts.length, 1);
  }));

test('the review is of the final message text only: tool-call steps, hidden and synthetic parts are not in it', () =>
  withBridge(
    {
      env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' },
      messages: () => [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'the task' }] },
        { info: { role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'FINAL REPORT' }, { type: 'text', text: 'hidden', synthetic: true }, { type: 'tool' }, { type: 'text', text: 'ui only', ignored: true }] },
      ],
    },
    async ({ hooks, root }) => {
      await arm(hooks);
      await idle(hooks);
      assert.equal(await readFile(path.join(root, SESSION, 'loop-1', '001-report.md'), 'utf8'), 'FINAL REPORT');
    },
  ));

test('an interrupted turn is not reviewed and the loop stays armed; the next turn is', () =>
  withBridge({ env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' } }, async ({ hooks, calls, root }) => {
    await arm(hooks);
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: SESSION, error: { name: 'MessageAbortedError' } } } });
    await idle(hooks);
    await idle(hooks); // OpenCode emits a second idle once the half-written message is closed
    assert.equal((await loadLoopState(root, SESSION))?.status, 'RUNNING');
    assert.equal(calls.prompts.length + calls.asyncPrompts.length, 0);
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } } });
    await idle(hooks);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'DONE');
  }));

test('another kind of error is not an interrupt', () =>
  withBridge({ env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' } }, async ({ hooks, root }) => {
    await arm(hooks);
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: SESSION, error: { name: 'APIError' } } } });
    await idle(hooks);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'DONE');
  }));

test('an idle while Codex is still reviewing does not start a second review', async () => {
  let looked = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await withBridge(
    {
      env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' },
      codex: async () => {
        looked++;
        await gate;
        return new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] });
      },
    },
    async ({ hooks, root }) => {
      await arm(hooks);
      const first = idle(hooks);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await idle(hooks); // the user typed something meanwhile
      release();
      await first;
      assert.equal(looked, 1);
      assert.equal((await loadLoopState(root, SESSION))?.status, 'DONE');
    },
  );
});

test('a turn that failed (assistant error, no text) ends the loop with a message instead of reviewing nothing', () =>
  withBridge({ messages: () => [assistant('', { error: { name: 'APIError' } })] }, async ({ hooks, calls, root }) => {
    await arm(hooks);
    await idle(hooks);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'ERROR');
    assert.match(calls.prompts[0].parts[0].text, /no final message/);
    assert.equal(calls.toasts.at(-1)?.variant, 'error');
  }));

test('the $0 rule holds here too: an API key in OpenCode\'s environment stops the loop before Codex runs', () =>
  withBridge({ env: { OPENAI_API_KEY: 'x' }, codex: async () => assert.fail('looked up Codex') }, async ({ hooks, calls, root }) => {
    await arm(hooks);
    await idle(hooks);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'ERROR');
    assert.match(calls.prompts[0].parts[0].text, /OPENAI_API_KEY/);
  }));

test('a plugin failure is reported in the chat, never thrown into OpenCode', () =>
  withBridge({ env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' } }, async ({ hooks, calls, root }) => {
    await arm(hooks);
    calls.asyncPrompts.push = () => {
      throw new Error('server went away');
    };
    await idle(hooks);
    assert.match(calls.prompts.at(-1)?.parts[0].text ?? '', /plugin error: server went away/);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'RUNNING');
  }));

test('/bridge <answer> after Codex asked the user carries the same loop on', () =>
  withBridge({ env: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' } }, async ({ hooks, root }) => {
    await arm(hooks, '--vong 1 fix login');
    await idle(hooks); // round 1 of 1: CONTINUE at the cap ends the loop as NEED_HUMAN
    assert.equal((await loadLoopState(root, SESSION))?.status, 'NEED_HUMAN');
    const output = await arm(hooks, 'yes, use the second option');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.status, 'RUNNING');
    assert.equal(state?.round, 1);
    assert.equal(state?.maxRounds, 4);
    assert.equal(state?.humanReply, 'yes, use the second option');
    assert.match((output.parts.at(-1) as { text: string }).text, /This continues the AI Bridge review loop/);
  }));

test('the built plugin is one self-contained file whose only export is the plugin function', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'ai-bridge-oc-build-'));
  try {
    const build = spawnSync(process.execPath, [BUILD, 'opencode', '--out', out], { encoding: 'utf8', windowsHide: true });
    assert.equal(build.status, 0, build.stderr);
    const mod = (await import(pathToFileURL(path.join(out, 'ai-bridge.js')).href)) as Record<string, unknown>;
    // OpenCode calls every export of a plugin file and rejects one that is not a function
    assert.deepEqual(Object.keys(mod), ['AiBridge']);
    const calls: Calls = { prompts: [], asyncPrompts: [], toasts: [], notified: [] };
    const hooks = await (mod.AiBridge as (i: unknown) => Promise<Record<string, unknown>>)({ client: fakeClient(calls, () => []), directory: out });
    assert.deepEqual(Object.keys(hooks).sort(), ['command.execute.before', 'config', 'event']);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
