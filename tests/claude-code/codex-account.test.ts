import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accountFromRollout, checkCodeMode, readCodexAccount, shouldCheckCode, type CodexAccount } from '../../src/claude-code/codex-account.ts';

const THREAD = '01a182f5-589f-7e82-8deb-fa362ea5fa4d';
const tokenCount = (rl: Record<string, unknown>) => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } });
const ROLLOUT = [
  JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id: THREAD } }),
  tokenCount({ plan_type: 'free', primary: { used_percent: 60, window_minutes: 43200, resets_at: 1795407841 }, secondary: null }),
  JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', content: 'rate_limits mentioned in text' } }),
  tokenCount({ plan_type: 'free', primary: { used_percent: 62, window_minutes: 43200, resets_at: 1795407841 }, secondary: null }),
].join('\n');

test("reads the plan and the quota from the last rate_limits event in Codex's log", () => {
  assert.deepEqual(accountFromRollout(ROLLOUT), { plan: 'free', usedPercent: 62, windowMinutes: 43200, resetsAt: 1795407841 });
});

test('of two windows, the quota shown is the one more used', () => {
  const text = tokenCount({ plan_type: 'plus', primary: { used_percent: 20, window_minutes: 300, resets_at: 1 }, secondary: { used_percent: 75, window_minutes: 10080, resets_at: 2 } });
  assert.deepEqual(accountFromRollout(text), { plan: 'plus', usedPercent: 75, windowMinutes: 10080, resetsAt: 2 });
});

test('a log without rate limits, or garbled, gives nothing', () => {
  assert.equal(accountFromRollout('{"type":"session_meta"}\nnot json\n'), null);
});

test("finds the thread's log under <CODEX_HOME>/sessions/YYYY/MM/DD, newest days first", async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ai-bridge-codex-home-'));
  try {
    const day = path.join(home, 'sessions', '2026', '10', '28');
    await mkdir(day, { recursive: true });
    await writeFile(path.join(day, `rollout-2026-10-28T21-41-20-${THREAD}.jsonl`), ROLLOUT);
    await writeFile(path.join(day, 'rollout-2026-10-28T09-00-00-other.jsonl'), tokenCount({ plan_type: 'pro', primary: { used_percent: 1 } }));
    assert.equal((await readCodexAccount(home, THREAD))?.plan, 'free');
    assert.equal(await readCodexAccount(home, 'ffffffff-0000-0000-0000-000000000000'), null);
    assert.equal(await readCodexAccount(home, '../escape'), null);
    assert.equal(await readCodexAccount(path.join(home, 'missing'), THREAD), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex checks the code itself only on a paid plan, unless AI_BRIDGE_CODEX_CHECK_CODE says otherwise', () => {
  const plan = (p: string | null): CodexAccount => ({ plan: p, usedPercent: null, windowMinutes: null, resetsAt: null });
  assert.equal(checkCodeMode({}), 'auto');
  assert.equal(checkCodeMode({ AI_BRIDGE_CODEX_CHECK_CODE: 'ON' }), 'on');
  assert.equal(checkCodeMode({ AI_BRIDGE_CODEX_CHECK_CODE: 'off' }), 'off');
  assert.equal(checkCodeMode({ AI_BRIDGE_CODEX_CHECK_CODE: 'maybe' }), 'auto');
  assert.equal(shouldCheckCode('auto', plan('free')), false);
  assert.equal(shouldCheckCode('auto', plan(null)), false);
  assert.equal(shouldCheckCode('auto', null), false);
  assert.equal(shouldCheckCode('auto', plan('plus')), true);
  assert.equal(shouldCheckCode('on', plan('free')), true);
  assert.equal(shouldCheckCode('off', plan('pro')), false);
});
