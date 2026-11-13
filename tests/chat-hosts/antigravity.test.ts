import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../../src/adapters/chatgpt/codex-cli-adapter.ts';
import { loadLoopState } from '../../src/claude-code/bridge-loop.ts';
import { handleAgyStop, handlePreInvocation, type AgyDeps, type AgyHookInput } from '../../src/chat-hosts/antigravity/hooks.ts';
import { finalReply, lastUserRequest, readSteps, type AgyStep } from '../../src/chat-hosts/antigravity/transcript.ts';

const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex/fake-codex.mjs', import.meta.url));
const BUILD = fileURLToPath(new URL('../../scripts/chat-hosts/build.ts', import.meta.url));
const PLUGIN = fileURLToPath(new URL('../../plugins/antigravity/', import.meta.url));
const WORKSPACE = tmpdir(); // a folder that exists: Codex runs there
const CONVERSATION = '2e53ab08-a5ba-4397-9b49-3de857c256ec';
const REPLY = 'Done.\n\n## TASK\nfix login\n## CHANGES\nsrc/login.ts\n## TESTS\npass\n## ISSUES\nnone\n## NEXT_RECOMMENDATION\nnone\nNEXT_ACTION: DONE';

// The steps agy 1.3.4 wrote for a real `agy -p "/bridge say hello …"` run (trimmed to what is read).
const userInput = (step_index: number, text: string): AgyStep => ({
  step_index,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  status: 'DONE',
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-29T00:16:44+07:00.\n</ADDITIONAL_METADATA>`,
});
const toolStep = (step_index: number): AgyStep => ({ step_index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [{ name: 'read_file', args: {} }] });
const reply = (step_index: number, content: string): AgyStep => ({ step_index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content });
const system = (step_index: number): AgyStep => ({ step_index, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'The following is a <SYSTEM_MESSAGE> …' });

const jsonl = (steps: AgyStep[]) => steps.map((s) => JSON.stringify(s)).join('\n') + '\n';

async function withDirs<T>(fn: (d: { root: string; transcript: string; write: (steps: AgyStep[]) => Promise<void> }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-chat-agy-'));
  const transcript = path.join(root, 'transcript_full.jsonl');
  try {
    return await fn({ root, transcript, write: (steps) => writeFile(transcript, jsonl(steps), 'utf8') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deps(root: string, env: Record<string, string> = {}, extra: Partial<AgyDeps> = {}): AgyDeps {
  return {
    stateRoot: path.join(root, 'state'),
    now: () => new Date('2026-10-28T10:00:00.000Z'),
    env: { ...process.env, ...env },
    codexTimeoutMs: 10_000,
    retryMs: 0,
    locateCodex: async () => new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] }),
    ...extra,
  };
}

const pre = (transcript: string, extra: Partial<AgyHookInput> = {}): AgyHookInput => ({ conversationId: CONVERSATION, workspacePaths: [WORKSPACE], transcriptPath: transcript, invocationNum: 0, ...extra });
const stop = (transcript: string, extra: Partial<AgyHookInput> = {}): AgyHookInput => ({ conversationId: CONVERSATION, workspacePaths: [WORKSPACE], transcriptPath: transcript, executionNum: 0, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, error: '', ...extra });

test('transcript: the last user message loses agy\'s metadata wrapper; later steps do not hide it', async () => {
  await withDirs(async ({ transcript, write }) => {
    await write([userInput(0, 'first'), reply(1, 'a'), userInput(2, '/bridge fix login\nsecond line'), system(3), toolStep(4), reply(5, REPLY)]);
    const steps = await readSteps(transcript);
    assert.deepEqual(lastUserRequest(steps), { stepIndex: 2, text: '/bridge fix login\nsecond line' });
    assert.equal(finalReply(steps), REPLY);
  });
});

test('transcript: the final reply is the last step only, finished, with text and no tool call', () => {
  assert.equal(finalReply([userInput(0, 'x'), toolStep(1)]), null, 'a tool call is not a reply');
  assert.equal(finalReply([userInput(0, 'x'), reply(1, 'ok'), system(2)]), null, 'not the last step');
  assert.equal(finalReply([userInput(0, 'x'), { ...reply(1, 'ok'), status: 'RUNNING' }]), null);
  assert.equal(finalReply([userInput(0, 'x'), reply(1, '  ')]), null);
  assert.equal(finalReply([]), null);
  assert.equal(lastUserRequest([reply(0, 'x')]), null);
});

test('transcript: a half-written last line is skipped', async () => {
  await withDirs(async ({ transcript }) => {
    await writeFile(transcript, jsonl([userInput(0, 'x')]) + '{"step_index":1,"sou', 'utf8');
    assert.equal((await readSteps(transcript)).length, 1);
  });
});

test('PreInvocation: /bridge <task> arms the loop for the conversation and injects the report contract as a system message', () =>
  withDirs(async ({ root, transcript, write }) => {
    await write([userInput(0, '/bridge fix login')]);
    const out = await handlePreInvocation(pre(transcript, { initialNumSteps: 1 }), deps(root));
    const state = await loadLoopState(path.join(root, 'state'), CONVERSATION);
    assert.equal(state?.status, 'RUNNING');
    assert.equal(state?.task, 'fix login');
    assert.equal(state?.projectPath, WORKSPACE);
    assert.equal(out?.injectSteps.length, 1);
    assert.match(out?.injectSteps[0].systemMessage.systemMessage ?? '', /AI_BRIDGE_REVIEW_LOOP/);
    assert.match(out?.injectSteps[0].systemMessage.systemMessage ?? '', /Tóm tắt cho bạn/);
  }));

test('PreInvocation: acts on the first model call of a turn only, and on a given message once', () =>
  withDirs(async ({ root, transcript, write }) => {
    await write([userInput(0, '/bridge fix login')]);
    assert.equal(await handlePreInvocation(pre(transcript, { invocationNum: 1 }), deps(root)), null);
    assert.equal(await loadLoopState(path.join(root, 'state'), CONVERSATION), null);
    assert.notEqual(await handlePreInvocation(pre(transcript), deps(root)), null);
    assert.equal(await handlePreInvocation(pre(transcript), deps(root)), null, 'the same message again arms nothing');
    await write([userInput(0, '/bridge fix login'), reply(1, REPLY), userInput(2, '/bridge other task')]);
    assert.notEqual(await handlePreInvocation(pre(transcript), deps(root)), null, 'a newer message does');
    assert.equal((await loadLoopState(path.join(root, 'state'), CONVERSATION))?.task, 'other task');
  }));

test('PreInvocation: other messages, no transcript, a bad conversation id: nothing happens', () =>
  withDirs(async ({ root, transcript, write }) => {
    await write([userInput(0, 'please fix the login, /bridge is a command')]);
    assert.equal(await handlePreInvocation(pre(transcript), deps(root)), null);
    assert.equal(await handlePreInvocation(pre(path.join(root, 'missing.jsonl')), deps(root)), null);
    await write([userInput(0, '/bridge fix login')]);
    assert.equal(await handlePreInvocation(pre(transcript, { conversationId: '../x' }), deps(root)), null);
    assert.equal(await handlePreInvocation({ ...pre(transcript), transcriptPath: undefined }, deps(root)), null);
  }));

test('PreInvocation: /bridge stop and refusals are handed to the model as the answer to show, never as a task', () =>
  withDirs(async ({ root, transcript, write }) => {
    await write([userInput(0, '/bridge stop')]);
    const out = await handlePreInvocation(pre(transcript), deps(root));
    const text = out?.injectSteps[0].systemMessage.systemMessage ?? '';
    assert.match(text, /no review loop is running/);
    assert.match(text, /do not start a task/);
    assert.doesNotMatch(text, /AI_BRIDGE_REVIEW_LOOP/);
  }));

test('PreInvocation: waits for the user\'s message to reach the transcript', () =>
  withDirs(async ({ root, transcript, write }) => {
    await write([]);
    setTimeout(() => void write([userInput(0, '/bridge fix login')]), 120);
    const out = await handlePreInvocation(pre(transcript, { initialNumSteps: 1 }), deps(root, {}, { retryMs: 60 }));
    assert.notEqual(out, null);
  }));

const armed = async (root: string, transcript: string, write: (s: AgyStep[]) => Promise<void>, steps: AgyStep[] = [userInput(0, '/bridge fix login'), toolStep(1), reply(2, REPLY)]) => {
  await write(steps.slice(0, 1));
  await handlePreInvocation(pre(transcript, { initialNumSteps: 1 }), deps(root));
  await write(steps);
};

test('Stop: a conversation without a loop is not reviewed and Codex is never looked up', () =>
  withDirs(async ({ root, transcript, write }) => {
    await write([userInput(0, 'hello'), reply(1, 'hi')]);
    assert.equal(await handleAgyStop(stop(transcript), deps(root, {}, { locateCodex: async () => assert.fail('looked up Codex') })), null);
  }));

test('Stop: CONTINUE answers decision continue with Codex\'s instruction, the round status and the contract', () =>
  withDirs(async ({ root, transcript, write }) => {
    await armed(root, transcript, write);
    const out = await handleAgyStop(stop(transcript), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    assert.equal(out?.decision, 'continue');
    assert.match(out?.reason ?? '', /^AI Bridge status for the user: start your reply with the block below, exactly as written\.\n---\nAI Bridge · vòng 1\/10 · Codex: chưa duyệt/);
    assert.match(out?.reason ?? '', /Round 2 instruction\./);
    assert.match(out?.reason ?? '', /Begin your reply with one short line/);
    assert.match(out?.reason ?? '', /AI_BRIDGE_REVIEW_LOOP/);
    const state = await loadLoopState(path.join(root, 'state'), CONVERSATION);
    assert.equal(state?.status, 'RUNNING');
    assert.equal(await readFile(path.join(root, 'state', CONVERSATION, 'loop-1', '001-report.md'), 'utf8'), REPLY, 'Codex reviewed the transcript\'s final message');
  }));

test('Stop: DONE ends the loop; the model is asked to show the result, and the next Stop lets the agent stop', () =>
  withDirs(async ({ root, transcript, write }) => {
    const notified: string[] = [];
    await armed(root, transcript, write);
    const d = deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' }, { notify: (_t, body) => void notified.push(body) });
    const out = await handleAgyStop(stop(transcript), d);
    assert.equal(out?.decision, 'continue');
    assert.match(out?.reason ?? '', /^The AI Bridge review loop has ended\. Reply with the block below exactly as written and nothing else/);
    assert.match(out?.reason ?? '', /✅ Codex đã duyệt/);
    assert.equal((await loadLoopState(path.join(root, 'state'), CONVERSATION))?.status, 'DONE');
    assert.equal(notified.length, 1);
    assert.equal(await handleAgyStop(stop(transcript, { executionNum: 1 }), d), null);
  }));

test('Stop: not finished (background work still running), an agent error, no final reply: Codex is not asked, or the loop ends with a message', () =>
  withDirs(async ({ root, transcript, write }) => {
    await armed(root, transcript, write);
    const never = deps(root, {}, { locateCodex: async () => assert.fail('looked up Codex') });
    assert.equal(await handleAgyStop(stop(transcript, { fullyIdle: false }), never), null);
    assert.equal(await handleAgyStop(stop(transcript, { error: 'model overloaded' }), never), null);
    assert.equal((await loadLoopState(path.join(root, 'state'), CONVERSATION))?.status, 'RUNNING');
    await write([userInput(0, '/bridge fix login'), toolStep(1)]);
    const out = await handleAgyStop(stop(transcript), deps(root));
    assert.match(out?.reason ?? '', /no final message/);
    assert.equal((await loadLoopState(path.join(root, 'state'), CONVERSATION))?.status, 'ERROR');
  }));

test('Stop: waits for the final reply to be flushed to the transcript', () =>
  withDirs(async ({ root, transcript, write }) => {
    await armed(root, transcript, write, [userInput(0, '/bridge fix login'), toolStep(1)]);
    setTimeout(() => void write([userInput(0, '/bridge fix login'), toolStep(1), reply(2, REPLY)]), 120);
    const out = await handleAgyStop(stop(transcript), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' }, { retryMs: 60 }));
    assert.match(out?.reason ?? '', /Codex đã duyệt/);
  }));

test('Stop: an API key in the environment of the agent does not reach the review (the entry cleans it); the guard still holds for the core', () =>
  withDirs(async ({ root, transcript, write }) => {
    await armed(root, transcript, write);
    const out = await handleAgyStop(stop(transcript), deps(root, { OPENAI_API_KEY: 'x' }));
    assert.match(out?.reason ?? '', /OPENAI_API_KEY/);
    assert.equal((await loadLoopState(path.join(root, 'state'), CONVERSATION))?.status, 'ERROR');
  }));

test('the plugin folder is a valid agy plugin: manifest, hooks and the skill', async () => {
  const manifest = JSON.parse(await readFile(path.join(PLUGIN, 'plugin.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(), ['$schema', 'description', 'name'], 'agy rejects other manifest fields');
  assert.match(String(manifest.name), /^[a-zA-Z0-9-_]+$/);
  const hooks = JSON.parse(await readFile(path.join(PLUGIN, 'hooks.json'), 'utf8')) as Record<string, Record<string, Array<{ command: string; timeout: number }>>>;
  const events = hooks['ai-bridge'];
  assert.deepEqual(Object.keys(events).sort(), ['PreInvocation', 'Stop']);
  // agy runs a hook without a shell, from the plugin folder, and does not unquote: a relative path without spaces
  for (const handlers of Object.values(events)) for (const h of handlers) assert.match(h.command, /^node \.\/dist\/hook\.mjs (pre|stop)$/);
  assert.ok(events.Stop[0].timeout >= 600, 'the default 30 s would cut a Codex review');
  assert.match(await readFile(path.join(PLUGIN, 'skills', 'bridge', 'SKILL.md'), 'utf8'), /^---\nname: bridge\n/);
});

/** Runs a built hook the way agy does: JSON on stdin, JSON on stdout. */
function runHook(entry: string, kind: string, stdin: string, stateRoot: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, kind], { env: { ...process.env, AI_BRIDGE_ANTIGRAVITY_DIR: stateRoot }, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

test('the built hook is self-contained and speaks agy\'s JSON: arms on PreInvocation, lets everything else through', () =>
  withDirs(async ({ root, transcript, write }) => {
    const out = path.join(root, 'dist');
    const build = spawnSync(process.execPath, [BUILD, 'antigravity', '--out', out], { encoding: 'utf8', windowsHide: true });
    assert.equal(build.status, 0, build.stderr);
    const entry = path.join(out, 'hook.mjs');
    const state = path.join(root, 'entry-state');
    await write([userInput(0, '/bridge fix login')]);

    const armedOut = await runHook(entry, 'pre', JSON.stringify(pre(transcript, { initialNumSteps: 1 })), state);
    assert.equal(armedOut.code, 0);
    assert.match(JSON.parse(armedOut.stdout).injectSteps[0].systemMessage.systemMessage, /AI_BRIDGE_REVIEW_LOOP/);
    assert.equal((await loadLoopState(state, CONVERSATION))?.task, 'fix login');

    // no Codex in the test: Stop on a conversation that is not armed is a plain allow
    const other = await runHook(entry, 'stop', JSON.stringify(stop(transcript, { conversationId: 'aaaaaaaa-0000-0000-0000-000000000000' })), state);
    assert.deepEqual([other.code, JSON.parse(other.stdout)], [0, { decision: 'allow' }]);
    const notBridge = await runHook(entry, 'pre', JSON.stringify(pre(transcript, { conversationId: 'aaaaaaaa-0000-0000-0000-000000000000', invocationNum: 3 })), state);
    assert.deepEqual([notBridge.code, JSON.parse(notBridge.stdout)], [0, {}]);

    // unreadable input never blocks the agent
    const broken = await runHook(entry, 'stop', 'not json', state);
    assert.deepEqual([broken.code, JSON.parse(broken.stdout)], [0, { decision: 'allow' }]);
  }));
