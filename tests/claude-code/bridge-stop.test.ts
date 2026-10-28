import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('CONTINUE also tells the user in the chat which round of how many Codex reviewed, in plain words', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    assert.match(out?.systemMessage ?? '', /^AI Bridge · vòng 1\/10 · Codex: chưa duyệt, Claude làm tiếp\n/);
  }));

test('CONTINUE asks Claude to first acknowledge Codex\'s review in the chat, then do the next instruction', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    const reason = out?.reason ?? '';
    assert.match(reason, /Begin your reply with one short line, in the user's language/);
    assert.match(reason, /round 1 review/);
    assert.ok(reason.indexOf('Round 2 instruction.') < reason.indexOf('Begin your reply'), 'the instruction comes first');
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
    assert.match(input, /ORIGINAL TASK[\s\S]*fix login/);
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

/** A Stop hook killed mid-review (the user interrupted it): its mark and round-1 files stay behind. */
async function leaveInterruptedReview(root: string): Promise<void> {
  const file = path.join(root, SESSION, 'state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...state, reviewingSince: '2026-10-23T09:00:00.000Z' }));
  const dir = path.join(root, SESSION, 'loop-1');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '001-report.md'), 'Interrupted reply.');
  await writeFile(path.join(dir, '001-codex-input.md'), 'Interrupted input.');
}

test('a review after an interrupted one marks its own start and clears the mark when done', () =>
  withStateRoot(async (root) => {
    await arm(root);
    await leaveInterruptedReview(root);
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

test('an interrupted review neither uses up a round number nor gets its files overwritten', () =>
  withStateRoot(async (root) => {
    await arm(root);
    await leaveInterruptedReview(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    const dir = path.join(root, SESSION, 'loop-1');
    assert.equal(await readFile(path.join(dir, '001-report.md'), 'utf8'), REPLY);
    assert.equal((await loadLoopState(root, SESSION))?.round, 1);
    const aside = path.join(dir, 'interrupted');
    assert.deepEqual((await readdir(aside)).sort(), ['001-2026-10-23T09-00-00.000Z-codex-input.md', '001-2026-10-23T09-00-00.000Z-report.md']);
    assert.equal(await readFile(path.join(aside, '001-2026-10-23T09-00-00.000Z-report.md'), 'utf8'), 'Interrupted reply.');
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
    assert.match(out?.systemMessage ?? '', /^AI Bridge · vòng 2\/10 · ✅ Codex đã duyệt\n/);
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
    assert.match(out?.systemMessage ?? '', /^AI Bridge · vòng 1\/10 · ⏸ Codex cần bạn\n/);
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
    assert.match(out?.systemMessage ?? '', new RegExp(`^AI Bridge · vòng ${state.maxRounds}/${state.maxRounds} · ⏸ Đã hết số vòng\\n`));
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

// ── Progress: Codex's checklist, in the chat line, the state, Claude's next turn and the next review ──

const PROGRESS_REVIEW = [
  '## Việc',
  'Sửa lỗi đăng nhập.',
  '',
  '## Tiến độ',
  '- [x] So sánh hash an toàn',
  '- [x] Test đăng nhập đúng',
  '- [ ] Test token hết hạn',
  '',
  '## Kết luận',
  'Chưa duyệt: còn thiếu test token hết hạn.',
  '',
].join('\n');
const withBlock = (review: string, status: string, prompt: string) =>
  `${review}\n<AI_BRIDGE_RESPONSE>\n<STATUS>${status}</STATUS>\n<PROMPT>\n${prompt}\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n`;

test("the chat line says how many parts are done, Codex's conclusion and each part", () =>
  withStateRoot(async (root) => {
    await arm(root);
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: withBlock(PROGRESS_REVIEW, 'CONTINUE', 'Add the expired-token test.') }));
    assert.equal(
      out?.systemMessage,
      [
        'AI Bridge · vòng 1/10 · Codex: chưa duyệt, Claude làm tiếp · 2/3 phần xong',
        'Chưa duyệt: còn thiếu test token hết hạn.',
        '✓ So sánh hash an toàn',
        '✓ Test đăng nhập đúng',
        '✗ Test token hết hạn',
        '→ Claude làm tiếp theo chỉ dẫn của Codex.',
      ].join('\n'),
    );
  }));

test('the checklist is kept in the loop state, handed to Claude, and to the next review to keep', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const d = deps(root, { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: withBlock(PROGRESS_REVIEW, 'CONTINUE', 'Add the expired-token test.') });
    const out = await handleStop(stopInput(root), d);
    const state = await loadLoopState(root, SESSION);
    assert.deepEqual(state?.progress, {
      title: 'Sửa lỗi đăng nhập.',
      items: [
        { text: 'So sánh hash an toàn', done: true },
        { text: 'Test đăng nhập đúng', done: true },
        { text: 'Test token hết hạn', done: false },
      ],
      verdict: 'Chưa duyệt: còn thiếu test token hết hạn.',
    });
    assert.match(out?.reason ?? '', /Codex's checklist[\s\S]*- \[ \] Test token hết hạn/);

    await handleStop(stopInput(root, { stop_hook_active: true }), d);
    const input2 = await readFile(path.join(root, SESSION, 'loop-1', '002-codex-input.md'), 'utf8');
    assert.match(input2, /YOUR CHECKLIST FROM THE PREVIOUS ROUND[\s\S]*- \[x\] So sánh hash an toàn/);
  }));

test('a review that leaves out the checklist keeps the last one', () =>
  withStateRoot(async (root) => {
    await arm(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: withBlock(PROGRESS_REVIEW, 'CONTINUE', 'Next.') }));
    const out = await handleStop(stopInput(root, { stop_hook_active: true }), deps(root, { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: withBlock('## Summary\nfine', 'CONTINUE', 'Next.') }));
    assert.equal((await loadLoopState(root, SESSION))?.progress?.items.length, 3);
    assert.match(out?.systemMessage ?? '', /· 2\/3 phần xong/);
  }));

test('DONE with every part ticked says Codex approved, in how many rounds', () =>
  withStateRoot(async (root) => {
    await arm(root);
    const all = PROGRESS_REVIEW.replace('- [ ] Test token hết hạn', '- [x] Test token hết hạn').replace('Chưa duyệt: còn thiếu test token hết hạn.', 'Đã xong, đã kiểm chứng.');
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: withBlock(all, 'DONE', 'Nothing left.') }));
    assert.match(out?.systemMessage ?? '', /^AI Bridge · vòng 1\/10 · ✅ Codex đã duyệt · 3\/3 phần xong\nĐã xong, đã kiểm chứng\.\n/);
    assert.match(out?.systemMessage ?? '', /Xong sau 1 vòng review, vòng lặp kết thúc\.$/);
  }));

// ── The review checks the code, and hears the user's answer ─────────────────

async function patchState(root: string, over: Record<string, unknown>): Promise<void> {
  const file = path.join(root, SESSION, 'state.json');
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ...over }));
}

const PLUS = { plan: 'plus', usedPercent: 20, windowMinutes: 300, resetsAt: Date.parse('2026-10-23T13:00:00.000Z') / 1000 };
const FREE = { plan: 'free', usedPercent: 62, windowMinutes: 43200, resetsAt: Date.parse('2026-11-04T10:00:00.000Z') / 1000 };
const cacheAccount = (root: string, account: object) => writeFile(path.join(root, 'codex-account.json'), JSON.stringify(account));

test('on a paid plan the reviewer gets the changes since the loop started, and may read the files', () =>
  withStateRoot(async (root) => {
    await handlePrompt({ session_id: SESSION, cwd: root, prompt: '/bridge fix login' }, { stateRoot: root, now: NOW, headCommit: async () => 'base-sha' });
    await cacheAccount(root, PLUS);
    const seen: (string | null)[] = [];
    const changesSince = async (cwd: string, base: string | null) => (seen.push(base), cwd === root ? 'M src/login.ts\n+const ok = true' : null);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }, { changesSince }));
    assert.deepEqual(seen, ['base-sha']);
    const input = await readFile(path.join(root, SESSION, 'loop-1', '001-codex-input.md'), 'utf8');
    assert.match(input, /CHANGES IN THE PROJECT SINCE THE LOOP STARTED[\s\S]*\+const ok = true/);
    assert.match(input, /you may read the project's files/i);
    assert.equal((await loadLoopState(root, SESSION))?.checksCode, true);
  }));

test('on the free plan, or before the plan is known, Codex reads the report alone: no changes, no file reading', () =>
  withStateRoot(async (root) => {
    for (const account of [FREE, null]) {
      await arm(root);
      if (account) await cacheAccount(root, account);
      let asked = false;
      await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }, { changesSince: async () => ((asked = true), 'diff') }));
      const state = await loadLoopState(root, SESSION);
      const input = await readFile(path.join(root, SESSION, `loop-${state?.loop}`, '001-codex-input.md'), 'utf8');
      assert.equal(asked, false);
      assert.doesNotMatch(input, /CHANGES IN THE PROJECT SINCE THE LOOP STARTED/);
      assert.match(input, /Review ONLY the information provided/);
      assert.equal(state?.checksCode, false);
    }
  }));

test('AI_BRIDGE_CODEX_CHECK_CODE=on checks the code on any plan; =off never', () =>
  withStateRoot(async (root) => {
    await arm(root);
    await cacheAccount(root, FREE);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3', AI_BRIDGE_CODEX_CHECK_CODE: 'on' }, { changesSince: async () => 'diff' }));
    assert.equal((await loadLoopState(root, SESSION))?.checksCode, true);

    await arm(root);
    await cacheAccount(root, PLUS);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3', AI_BRIDGE_CODEX_CHECK_CODE: 'off' }, { changesSince: async () => 'diff' }));
    assert.equal((await loadLoopState(root, SESSION))?.checksCode, false);
  }));

test("after each review the plan and quota from Codex's log are kept, and the chat line shows them", () =>
  withStateRoot(async (root) => {
    await arm(root);
    const threads: string[] = [];
    const codexAccount = async (threadId: string) => (threads.push(threadId), FREE);
    const out = await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }, { codexAccount }));
    assert.deepEqual(threads, ['11111111-1111-1111-1111-111111111111']);
    assert.deepEqual((await loadLoopState(root, SESSION))?.codexAccount, FREE);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'codex-account.json'), 'utf8')), FREE);
    const lines = (out?.systemMessage ?? '').split('\n');
    assert.equal(lines.at(-1), 'Codex free · đã dùng 62% hạn mức 30 ngày · đặt lại sau 12 ngày · Codex chỉ đọc báo cáo');
  }));

test('the plan learnt in one loop decides the first review of the next', () =>
  withStateRoot(async (root) => {
    await arm(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' }, { codexAccount: async () => PLUS }));
    await arm(root, 'next task');
    let asked = false;
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }, { changesSince: async () => ((asked = true), 'diff') }));
    assert.equal(asked, true);
  }));

// ── Notifications: the loop ended, so the user need not watch it ────────────

test('the OS is notified when the loop ends (approved, needs the user, round cap, error), never on CONTINUE', () =>
  withStateRoot(async (root) => {
    const sent: { title: string; body: string }[] = [];
    const notify = (title: string, body: string) => void sent.push({ title, body });

    await arm(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }, { notify }));
    assert.equal(sent.length, 0);

    await arm(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' }, { notify }));
    assert.equal(sent.at(-1)?.title, 'AI Bridge');
    assert.match(sent.at(-1)?.body ?? '', /^vòng 1\/10 · ✅ Codex đã duyệt/);

    await arm(root);
    const ask = '<AI_BRIDGE_RESPONSE>\n<STATUS>NEED_HUMAN</STATUS>\n<PROMPT>\nPostgres or SQLite?\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RESPONSE: ask }, { notify }));
    assert.match(sent.at(-1)?.body ?? '', /⏸ Codex cần bạn[\s\S]*Postgres or SQLite\?/);

    await arm(root);
    await patchState(root, { round: 9 });
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' }, { notify }));
    assert.match(sent.at(-1)?.body ?? '', /⏸ Đã hết số vòng/);

    await arm(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'error-exit' }, { notify }));
    assert.match(sent.at(-1)?.body ?? '', /NON_ZERO_EXIT/);
    assert.equal(sent.length, 4);
  }));

test('AI_BRIDGE_NOTIFY=off keeps the OS quiet', () =>
  withStateRoot(async (root) => {
    const sent: string[] = [];
    await arm(root);
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1', AI_BRIDGE_NOTIFY: 'off' }, { notify: (t) => void sent.push(t) }));
    assert.deepEqual(sent, []);
  }));

test("the review after the user answered Codex carries the answer, once", () =>
  withStateRoot(async (root) => {
    await arm(root);
    await patchState(root, { humanReply: 'Use SQLite.' });
    await handleStop(stopInput(root), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    const input = await readFile(path.join(root, SESSION, 'loop-1', '001-codex-input.md'), 'utf8');
    assert.match(input, /THE USER'S ANSWER TO YOUR LAST QUESTION[\s\S]*Use SQLite\./);
    assert.equal((await loadLoopState(root, SESSION))?.humanReply, null);

    await handleStop(stopInput(root, { stop_hook_active: true }), deps(root, { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' }));
    assert.doesNotMatch(await readFile(path.join(root, SESSION, 'loop-1', '002-codex-input.md'), 'utf8'), /THE USER'S ANSWER/);
  }));
