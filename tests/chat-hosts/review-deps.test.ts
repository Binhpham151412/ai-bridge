import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { homedir } from 'node:os';
import { checkEnvForApiKeys } from '../../src/core/cost-guard.ts';
import { API_KEY_VARS, realReviewDeps, reviewerEnv, stateRootOf } from '../../src/chat-hosts/review-deps.ts';

test('the review runs without any API key, so the agent\'s own provider key neither stops the loop nor reaches Codex', () => {
  const env = { PATH: '/bin', CODEX_HOME: '/c', AI_BRIDGE_NOTIFY: 'off', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'c', CODEX_API_KEY: 'd' };
  const clean = reviewerEnv(env);
  assert.deepEqual(clean, { PATH: '/bin', CODEX_HOME: '/c', AI_BRIDGE_NOTIFY: 'off' });
  assert.equal(checkEnvForApiKeys(clean).blocked, false);
  assert.equal(env.OPENAI_API_KEY, 'c', 'the caller\'s environment is not touched');
});

test('every variable the core cost guard looks at is stripped (the lists cannot drift apart)', () => {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
    assert.equal(checkEnvForApiKeys({ [key]: 'x' }).blocked, true, `${key} is no longer in the core guard: update API_KEY_VARS`);
    assert.ok((API_KEY_VARS as readonly string[]).includes(key));
  }
  assert.equal(checkEnvForApiKeys(reviewerEnv(Object.fromEntries(API_KEY_VARS.map((k) => [k, 'x'])))).blocked, false);
});

test('the real wiring hands the cleaned environment to the review', () => {
  const deps = realReviewDeps({ OPENAI_API_KEY: 'x', KEEP: '1' });
  assert.deepEqual(deps.env, { KEEP: '1' });
});

test('state folder: the override variable, else ~/.ai-bridge/<host>', () => {
  assert.equal(stateRootOf('antigravity', 'AI_BRIDGE_ANTIGRAVITY_DIR', { AI_BRIDGE_ANTIGRAVITY_DIR: '/x/y' }), '/x/y');
  assert.equal(stateRootOf('antigravity', 'AI_BRIDGE_ANTIGRAVITY_DIR', {}), path.join(homedir(), '.ai-bridge', 'antigravity'));
});
