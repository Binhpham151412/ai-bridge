#!/usr/bin/env node
// Fake `claude` CLI for M4.3 provider diagnostics. Handles only the commands the Claude
// Code provider runs: `--version`, `auth status`, and the `-p --output-format json` probe.
//
// Env vars (each defaults to the healthy behaviour):
//   FAKE_DIAG_VERSION  ok | malformed | fail | hang
//   FAKE_DIAG_AUTH     subscription | no-email | logged-out | console | unknown-method |
//                      malformed | not-object | fail | hang | secret | extra-secrets
//   FAKE_DIAG_PROBE    ok | weekly-limit | limit | is-error | fail | malformed | hang | secret
//   FAKE_DIAG_LOG      if set, every invocation's argv is appended to this file as a JSON line
//
// The account/token values below are synthetic test data.

import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_DIAG_LOG) appendFileSync(process.env.FAKE_DIAG_LOG, JSON.stringify({ argv: args }) + '\n');

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
const hang = () => setInterval(() => {}, 1_000_000);

const FAKE_TOKEN = 'sk-ant-oat01-FAKEtokenFAKEtokenFAKEtoken1234';

if (args[0] === '--version') {
  const mode = process.env.FAKE_DIAG_VERSION || 'ok';
  if (mode === 'hang') hang();
  else if (mode === 'fail') { err('boom\n'); process.exit(3); }
  else if (mode === 'malformed') out('Claude Code (dev build)\n');
  else out('2.1.161 (Claude Code)\n');
} else if (args[0] === 'auth' && args[1] === 'status') {
  const mode = process.env.FAKE_DIAG_AUTH || 'subscription';
  const json = (o, code = 0) => { out(JSON.stringify(o, null, 2) + '\n'); process.exit(code); };
  if (mode === 'hang') hang();
  else if (mode === 'subscription') json({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'user@example.com', subscriptionType: 'pro' });
  else if (mode === 'no-email') json({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
  else if (mode === 'extra-secrets') json({ loggedIn: true, authMethod: 'claude.ai', email: 'user@example.com', subscriptionType: 'max', accessToken: FAKE_TOKEN, refreshToken: 'fake-refresh-value-9876' });
  else if (mode === 'logged-out') json({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, 1);
  else if (mode === 'console') json({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' });
  else if (mode === 'unknown-method') json({ loggedIn: true, authMethod: 'something-new', apiProvider: 'firstParty' });
  else if (mode === 'not-object') json(['loggedIn']);
  else if (mode === 'malformed') out('Logged in as user@example.com\n');
  else if (mode === 'fail') { err('internal error\n'); process.exit(2); }
  else if (mode === 'secret') { err(`failed to refresh: {"accessToken":"${FAKE_TOKEN}"} Authorization: Bearer fakebearervalue12345\n`); process.exit(2); }
} else if (args[0] === '-p') {
  try { readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  const mode = process.env.FAKE_DIAG_PROBE || 'ok';
  const result = (o, code = 0) => { out(JSON.stringify({ type: 'result', session_id: 'x', ...o }) + '\n'); process.exit(code); };
  if (mode === 'hang') hang();
  else if (mode === 'ok') result({ subtype: 'success', is_error: false, result: 'OK' });
  else if (mode === 'weekly-limit') result({ subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets Oct 3, 9am" }, 1);
  else if (mode === 'limit') result({ subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1790000000' }, 1);
  else if (mode === 'is-error') result({ subtype: 'error_during_execution', is_error: true, result: 'API Error: 500 overloaded' }, 1);
  else if (mode === 'malformed') out('not json at all\n');
  else if (mode === 'fail') { err('spawn helper failed\n'); process.exit(1); }
  else if (mode === 'secret') { err(`request failed, ANTHROPIC_API_KEY=${FAKE_TOKEN}\n`); process.exit(1); }
} else {
  err(`fake-claude-diag: unsupported args ${JSON.stringify(args)}\n`);
  process.exit(64);
}
