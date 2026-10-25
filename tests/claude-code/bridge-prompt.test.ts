import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handlePrompt, loadLoopState } from '../../src/claude-code/bridge-loop.ts';

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = () => new Date('2026-10-23T10:00:00.000Z');

async function withStateRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-cc-prompt-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const prompt = (root: string, text: string) => handlePrompt({ session_id: SESSION, cwd: 'D:/proj', prompt: text }, { stateRoot: root, now: NOW });

test('/bridge <task> arms the loop for this session and gives Claude the report contract', () =>
  withStateRoot(async (root) => {
    const out = await prompt(root, '/bridge fix the login bug');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.status, 'RUNNING');
    assert.equal(state?.task, 'fix the login bug');
    assert.equal(state?.projectPath, 'D:/proj');
    assert.equal(state?.round, 0);
    assert.equal(state?.codexThreadId, null);
    assert.equal(out?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.match(out?.hookSpecificOutput?.additionalContext ?? '', /## NEXT_RECOMMENDATION/);
    assert.equal(out?.decision, undefined);
  }));

test('the namespaced form /ai-bridge:bridge arms the loop too', () =>
  withStateRoot(async (root) => {
    await prompt(root, '/ai-bridge:bridge add tests');
    assert.equal((await loadLoopState(root, SESSION))?.task, 'add tests');
  }));

test('an ordinary prompt is passed through and writes nothing', () =>
  withStateRoot(async (root) => {
    assert.equal(await prompt(root, 'what does this function do?'), null);
    assert.equal(await prompt(root, '/bridgework later'), null);
    await assert.rejects(stat(path.join(root, SESSION)));
  }));

test('/bridge stop ends a running loop without sending the prompt to Claude', () =>
  withStateRoot(async (root) => {
    await prompt(root, '/bridge fix the login bug');
    const out = await prompt(root, '/bridge stop');
    assert.equal((await loadLoopState(root, SESSION))?.status, 'STOPPED');
    assert.equal(out?.decision, 'block');
    assert.ok(out?.reason);
  }));

/** What a Stop hook killed mid-review (the user interrupted it) leaves in the state. */
async function leaveInterruptedReview(root: string): Promise<void> {
  const file = path.join(root, SESSION, 'state.json');
  const old = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...old, reviewingSince: '2026-10-23T09:00:00.000Z' }));
}

test('/bridge stop after an interrupted review also clears the review-in-progress mark', () =>
  withStateRoot(async (root) => {
    await prompt(root, '/bridge fix the login bug');
    await leaveInterruptedReview(root);
    await prompt(root, '/bridge stop');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.status, 'STOPPED');
    assert.equal(state?.reviewingSince, null);
  }));

test('arming again after an interrupted review starts with no review in progress', () =>
  withStateRoot(async (root) => {
    await prompt(root, '/bridge first task');
    await leaveInterruptedReview(root);
    await prompt(root, '/bridge second task');
    assert.equal((await loadLoopState(root, SESSION))?.reviewingSince, null);
  }));

test('/bridge with no task is refused and arms nothing', () =>
  withStateRoot(async (root) => {
    const out = await prompt(root, '/bridge   ');
    assert.equal(out?.decision, 'block');
    assert.equal(await loadLoopState(root, SESSION), null);
  }));

test('arming again starts a fresh loop: round and Codex thread reset', () =>
  withStateRoot(async (root) => {
    await prompt(root, '/bridge first task');
    const file = path.join(root, SESSION, 'state.json');
    const old = JSON.parse(await readFile(file, 'utf8'));
    await import('node:fs/promises').then((fs) => fs.writeFile(file, JSON.stringify({ ...old, round: 4, codexThreadId: 'abc' })));
    await prompt(root, '/bridge second task');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.task, 'second task');
    assert.equal(state?.round, 0);
    assert.equal(state?.codexThreadId, null);
  }));

test('a session id that is not a plain id is ignored (no path outside the state root)', () =>
  withStateRoot(async (root) => {
    const out = await handlePrompt({ session_id: '../escape', cwd: 'D:/proj', prompt: '/bridge x' }, { stateRoot: root, now: NOW });
    assert.equal(out, null);
    await assert.rejects(stat(path.join(root, '..', 'escape')));
  }));
