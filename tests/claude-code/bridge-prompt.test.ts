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
    assert.equal(state?.progress, null);
  }));

test('a session id that is not a plain id is ignored (no path outside the state root)', () =>
  withStateRoot(async (root) => {
    const out = await handlePrompt({ session_id: '../escape', cwd: 'D:/proj', prompt: '/bridge x' }, { stateRoot: root, now: NOW });
    assert.equal(out, null);
    await assert.rejects(stat(path.join(root, '..', 'escape')));
  }));

// ── How many rounds: /bridge --vong N <task> ────────────────────────────────

test('/bridge --vong 3 <task> caps this loop at 3 rounds; the task is what follows', () =>
  withStateRoot(async (root) => {
    await prompt(root, '/bridge --vong 3 fix the login bug');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.maxRounds, 3);
    assert.equal(state?.task, 'fix the login bug');
  }));

test('--vòng and --rounds work too; without the option the cap stays at 10', () =>
  withStateRoot(async (root) => {
    await prompt(root, '/bridge --vòng 5 a');
    assert.equal((await loadLoopState(root, SESSION))?.maxRounds, 5);
    await prompt(root, '/bridge --rounds 2 b');
    assert.equal((await loadLoopState(root, SESSION))?.maxRounds, 2);
    await prompt(root, '/bridge c');
    assert.equal((await loadLoopState(root, SESSION))?.maxRounds, 10);
  }));

test('a round count out of 1–30, or the option with no task, is refused and arms nothing', () =>
  withStateRoot(async (root) => {
    for (const text of ['/bridge --vong 0 x', '/bridge --vong 31 x', '/bridge --vong 3', '/bridge --vong abc x']) {
      const out = await prompt(root, text);
      assert.equal(out?.decision, 'block', text);
      assert.equal(await loadLoopState(root, SESSION), null, text);
    }
  }));

// ── Answering Codex: /bridge <answer> while the loop waits on the user ──────

/** A loop Codex stopped at NEED_HUMAN after `round` rounds, with its checklist and question. */
async function waitingOnUser(root: string, over: Record<string, unknown> = {}): Promise<void> {
  await prompt(root, '/bridge --vong 5 pick a database and wire it');
  const file = path.join(root, SESSION, 'state.json');
  const old = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(
    file,
    JSON.stringify({
      ...old,
      status: 'NEED_HUMAN',
      round: 2,
      codexThreadId: 'thread-1',
      lastVerdict: { round: 2, status: 'NEED_HUMAN', prompt: 'Postgres or SQLite?' },
      progress: { title: 'Chọn và nối database.', items: [{ text: 'Chọn database', done: false }, { text: 'Nối database', done: false }], verdict: 'Cần bạn chọn database.' },
      ...over,
    }),
  );
}

test("/bridge <answer> while Codex waits on the user continues the same loop with the user's answer", () =>
  withStateRoot(async (root) => {
    await waitingOnUser(root);
    const out = await prompt(root, '/bridge SQLite, it is a desktop app');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.status, 'RUNNING');
    assert.equal(state?.loop, 1);
    assert.equal(state?.round, 2);
    assert.equal(state?.maxRounds, 5);
    assert.equal(state?.codexThreadId, 'thread-1');
    assert.equal(state?.task, 'pick a database and wire it');
    assert.equal(state?.progress?.items.length, 2);
    assert.equal(state?.humanReply, 'SQLite, it is a desktop app');
    const context = out?.hookSpecificOutput?.additionalContext ?? '';
    assert.match(context, /continues the AI Bridge review loop/);
    assert.match(context, /pick a database and wire it/);
    assert.match(context, /Postgres or SQLite\?/);
    assert.match(context, /Codex's checklist[\s\S]*- \[ \] Chọn database/);
    assert.equal(out?.decision, undefined);
  }));

test('answering after the round cap gives the loop 3 more rounds, or as many as --vong says', () =>
  withStateRoot(async (root) => {
    await waitingOnUser(root, { round: 5 });
    await prompt(root, '/bridge go on');
    assert.equal((await loadLoopState(root, SESSION))?.maxRounds, 8);

    await waitingOnUser(root, { round: 5 });
    await prompt(root, '/bridge --vong 2 go on');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.maxRounds, state!.round + 2);
  }));

test('/bridge stop while Codex waits on the user ends that loop, so the next /bridge is a new task', () =>
  withStateRoot(async (root) => {
    await waitingOnUser(root);
    const out = await prompt(root, '/bridge stop');
    assert.equal(out?.decision, 'block');
    assert.equal((await loadLoopState(root, SESSION))?.status, 'STOPPED');
    await prompt(root, '/bridge something else');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.loop, 2);
    assert.equal(state?.round, 0);
    assert.equal(state?.codexThreadId, null);
    assert.equal(state?.humanReply, null);
  }));

test('after DONE, /bridge <text> is a new task, not an answer', () =>
  withStateRoot(async (root) => {
    await waitingOnUser(root, { status: 'DONE' });
    await prompt(root, '/bridge next thing');
    const state = await loadLoopState(root, SESSION);
    assert.equal(state?.loop, 2);
    assert.equal(state?.task, 'next thing');
  }));

// ── Where the work starts: the commit the review compares against ──────────

test('arming records the commit the loop starts from, for the reviewer to diff against', () =>
  withStateRoot(async (root) => {
    await handlePrompt({ session_id: SESSION, cwd: 'D:/proj', prompt: '/bridge x' }, { stateRoot: root, now: NOW, headCommit: async (cwd) => (cwd === 'D:/proj' ? 'abc123' : null) });
    assert.equal((await loadLoopState(root, SESSION))?.baseCommit, 'abc123');
    await prompt(root, '/bridge y');
    assert.equal((await loadLoopState(root, SESSION))?.baseCommit, null);
  }));
