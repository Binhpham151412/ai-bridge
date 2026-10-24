import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../../src/adapters/chatgpt/codex-cli-adapter.ts';
import { handlePrompt, handleStop, loadLoopState, type StopDeps } from '../../src/claude-code/bridge-loop.ts';

const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex/fake-codex.mjs', import.meta.url));
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = () => new Date('2026-10-23T10:00:00.000Z');
const REPLY = 'Fixed the login bug.\n\n## TASK\nfix login\n## CHANGES\nsrc/login.ts\n## TESTS\npass\n## ISSUES\nnone\n## NEXT_RECOMMENDATION\nnone\nNEXT_ACTION: DONE';

async function withStateRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-cc-stop-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deps(root: string, codexEnv: Record<string, string>, extra: Partial<StopDeps> = {}): StopDeps {
  return {
    stateRoot: root,
    now: NOW,
    codexTimeoutMs: 10_000,
    locateCodex: async () => new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] }),
    env: { ...process.env, ...codexEnv },
    ...extra,
  };
}

const arm = (root: string, task = 'fix login') => handlePrompt({ session_id: SESSION, cwd: root, prompt: `/bridge ${task}` }, { stateRoot: root, now: NOW });
const stopInput = (root: string, extra: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  cwd: root,
  transcript_path: path.join(root, 'no-transcript.jsonl'),
  stop_hook_active: false,
  last_assistant_message: REPLY,
  ...extra,
});

test('a session that never ran /bridge is not reviewed and Codex is never looked up', () =>
  withStateRoot(async (root) => {
    let looked = false;
    const out = await handleStop(stopInput(root), deps(root, {}, { locateCodex: async () => ((looked = true), null) }));
    assert.equal(out, null);
    assert.equal(looked, false);
  }));

test('CONTINUE blocks the stop and hands Codex\'s prompt to Claude', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    assert.equal(out?.decision, 'block');
    assert.match(out?.reason ?? '', /Round 2 instruction\./);
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.status, 'RUNNING');
    assert.equal(state?.round, 1);
    assert.equal(state?.codexThreadId, '11111111-1111-1111-1111-111111111111');
  }));

test('the reviewer gets Claude\'s final message, and every round is kept on disk', () =>
  withStateRoot(async (root) => {
    await arm(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    const dir = path.join(root, SESSION, 'loop-1');
    assert.equal(await readFile(path.join(dir, '001-report.md'), 'utf8'), REPLY);
    const input = await readFile(path.join(dir, '001-codex-input.md'), 'utf8');
    assert.ok(input.includes(REPLY));
    assert.match(input, /ITERATION:\n1\n/);
    assert.match(await readFile(path.join(dir, '001-codex-review.md'), 'utf8'), /<STATUS>CONTINUE<\/STATUS>/);
  }));

test('while Codex reviews, the state says since when (for the side pane); afterwards it is cleared', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const real = new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] });
    let during: string | null | undefined;
    const locateCodex = async () => ({
      run: async (o: Parameters<CodexCliAdapter['run']>[0]) => {
        during = (await loadLoopState(root, SESSION))?.reviewingSince;
        return real.run(o);
      },
    });
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }, { locateCodex }));
    assert.equal(during, '2026-10-23T10:00:00.000Z');
    assert.equal((await loadLoopState(root, SESSION))?.reviewingSince, null);
  }));

test('/bridge stop typed while Codex reviews wins: no block, the loop stays STOPPED', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const real = new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] });
    const locateCodex = async () => ({
      run: async (o: Parameters<CodexCliAdapter['run']>[0]) => {
        await handlePrompt({ session_id: SESSION, cwd: root, prompt: '/bridge stop' }, { stateRoot: root, now: NOW });
        return real.run(o);
      },
    });
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }, { locateCodex }));
    assert.equal(out?.decision, undefined);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'STOPPED');
  }));

test('a new /bridge typed while Codex reviews the old loop is left alone', () =>
  withStateRoot(async (root) => {
    await arm(root, 'old task');
    const real = new CodexCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CODEX] });
    const locateCodex = async () => ({
      run: async (o: Parameters<CodexCliAdapter['run']>[0]) => {
        await arm(root, 'new task');
        return real.run(o);
      },
    });
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' }, { locateCodex }));
    assert.equal(out?.decision, undefined);
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.task, 'new task');
    assert.equal(state?.status, 'RUNNING');
    assert.equal(state?.round, 0);
  }));

test('the next round resumes the same Codex thread, and DONE ends the loop without blocking', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const d = deps(root, { FAKE_CODEX_MODE: 'sequence' });
    assert.equal((await handleStop(stopInput(root), d))?.decision, 'block');
    const out = await handleStop(stopInput(root, { stop_hook_active: true }), d);
    assert.equal(out?.decision, undefined);
    assert.match(out?.systemMessage ?? '', /DONE/);
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.status, 'DONE');
    assert.equal(state?.round, 2);
  }));

test('after DONE the session is no longer reviewed', () =>
  withStateRoot(async (root) => {
    await arm(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' }));
    assert.equal((await loadLoopState(root, SESSION))?.status, 'DONE');
    assert.equal(await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' })), null);
  }));

test('NEED_HUMAN ends the loop and shows the user what Codex needs', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const response = '<AI_BRIDGE_RESPONSE>\n<STATUS>NEED_HUMAN</STATUS>\n<PROMPT>\nPick the database: Postgres or SQLite?\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: response }));
    assert.equal(out?.decision, undefined);
    assert.match(out?.systemMessage ?? '', /Pick the database: Postgres or SQLite\?/);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'NEED_HUMAN');
  }));

test('CONTINUE on the last allowed round ends the loop as NEED_HUMAN and shows the prompt it would have sent', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const file = path.join(root, SESSION, 'state.json');
    const state = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...state, round: state.maxRounds - 1 }));
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' }));
    assert.equal(out?.decision, undefined);
    assert.match(out?.systemMessage ?? '', new RegExp(`Round ${state.maxRounds + 1} instruction\\.`));
    const after = await loadLoopState(root, SESSION);
    assert.equal(after?.status, 'NEED_HUMAN');
    assert.equal(after?.round, state.maxRounds);
  }));

test('a failed Codex run ends the loop with an error and never blocks', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'error-exit' }));
    assert.equal(out?.decision, undefined);
    assert.match(out?.systemMessage ?? '', /NON_ZERO_EXIT/);
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.status, 'ERROR');
    assert.match(state?.error ?? '', /NON_ZERO_EXIT/);
  }));

test('a malformed Codex response ends the loop with an error', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: 'Looks fine to me.' }));
    assert.equal(out?.decision, undefined);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'ERROR');
  }));

test('Codex not found ends the loop with an error', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const out = await handleStop(stopInput(root), deps(root, {}, { locateCodex: async () => null }));
    assert.equal(out?.decision, undefined);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'ERROR');
  }));

test('an API key in the environment stops the loop before Codex runs ($0 rule)', () =>
  withStateRoot(async (root) => {
    await arm(root);
    let looked = false;
    const out = await handleStop(stopInput(root), deps(root, {}, { env: { OPENAI_API_KEY: 'sk-x' }, locateCodex: async () => ((looked = true), null) }));
    assert.equal(looked, false);
    assert.match(out?.systemMessage ?? '', /OPENAI_API_KEY/);
    assert.doesNotMatch(out?.systemMessage ?? '', /sk-x/);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'ERROR');
  }));

test('without last_assistant_message the final reply is read from the transcript', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const transcript = path.join(root, 't.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: '/bridge fix login' } },
      { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'From the transcript.' }] } },
    ];
    await writeFile(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await handleStop(stopInput(root, { last_assistant_message: undefined, transcript_path: transcript }), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    assert.equal(await readFile(path.join(root, SESSION, 'loop-1', '001-report.md'), 'utf8'), 'From the transcript.');
  }));

test('a turn with no final message to review ends the loop with an error', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const out = await handleStop(stopInput(root, { last_assistant_message: '' }), deps(root, { FAKE_CODEX_MODE: 'done-at' }, { transcriptRetryMs: 0 }));
    assert.equal(out?.decision, undefined);
    assert.equal((await loadLoopState(root, SESSION))?.status, 'ERROR');
  }));
