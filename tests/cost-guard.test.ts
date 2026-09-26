import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEnvForApiKeys, parseClaudeAuthStatus, parseCodexLoginStatus } from '../src/core/cost-guard.ts';

test('passes when none of the cost-risk env vars are set', () => {
  const r = checkEnvForApiKeys({ PATH: '/usr/bin' });
  assert.equal(r.blocked, false);
  assert.deepEqual(r.foundKeys, []);
});

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
  test(`blocks when ${key} is set`, () => {
    const r = checkEnvForApiKeys({ [key]: 'sk-something' });
    assert.equal(r.blocked, true);
    assert.deepEqual(r.foundKeys, [key]);
  });
}

test('reports every cost-risk key that is set, not just the first', () => {
  const r = checkEnvForApiKeys({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b' });
  assert.equal(r.blocked, true);
  assert.deepEqual(r.foundKeys.sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
});

test('treats an empty string value as not set', () => {
  const r = checkEnvForApiKeys({ ANTHROPIC_API_KEY: '' });
  assert.equal(r.blocked, false);
});

test('never includes the key value itself, only its name', () => {
  const r = checkEnvForApiKeys({ ANTHROPIC_API_KEY: 'sk-ant-super-secret-value' });
  assert.ok(!JSON.stringify(r).includes('sk-ant-super-secret-value'));
});

test('parses a subscription claude auth status as allowed', () => {
  const r = parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}');
  assert.equal(r.loggedIn, true);
  assert.equal(r.authMode, 'subscription');
});

test('parses a logged-out claude auth status', () => {
  const r = parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}');
  assert.equal(r.loggedIn, false);
  assert.equal(r.authMode, 'none');
});

test('parses a console/API-key claude auth status as api-key mode', () => {
  const r = parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"console","apiProvider":"firstParty"}');
  assert.equal(r.loggedIn, true);
  assert.equal(r.authMode, 'api-key');
});

test('treats unparseable claude auth status output as unknown, not as logged in', () => {
  const r = parseClaudeAuthStatus('command not found');
  assert.equal(r.loggedIn, false);
  assert.equal(r.authMode, 'unknown');
});

test('parses "Logged in using ChatGPT" as chatgpt auth mode', () => {
  const r = parseCodexLoginStatus('Logged in using ChatGPT\n');
  assert.equal(r.loggedIn, true);
  assert.equal(r.authMode, 'chatgpt');
});

test('parses an API-key codex login status as api-key mode', () => {
  const r = parseCodexLoginStatus('Logged in using an API key - Not available\n');
  assert.equal(r.loggedIn, true);
  assert.equal(r.authMode, 'api-key');
});

test('parses a logged-out codex login status', () => {
  const r = parseCodexLoginStatus('Not logged in\n');
  assert.equal(r.loggedIn, false);
  assert.equal(r.authMode, 'none');
});

test('treats unrecognized codex login status text as unknown', () => {
  const r = parseCodexLoginStatus('some future message the parser has never seen');
  assert.equal(r.loggedIn, false);
  assert.equal(r.authMode, 'unknown');
});
