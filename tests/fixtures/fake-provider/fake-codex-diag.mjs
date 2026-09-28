#!/usr/bin/env node
// Fake `codex` CLI for M4.3 provider diagnostics. Handles only the commands the Codex
// provider runs: `--version`, `login status` (printed to stderr, like codex-cli 0.155),
// and the `exec --json … -` probe.
//
// Env vars (each defaults to the healthy behaviour):
//   FAKE_DIAG_VERSION  ok | malformed | fail | hang
//   FAKE_DIAG_AUTH     chatgpt | api-key | logged-out | malformed | fail | hang | secret
//   FAKE_DIAG_PROBE    ok | weekly-limit | limit | fail | malformed | hang | secret
//   FAKE_DIAG_LOG      if set, every invocation's argv is appended to this file as a JSON line
//
// The token values below are synthetic test data.

import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_DIAG_LOG) appendFileSync(process.env.FAKE_DIAG_LOG, JSON.stringify({ argv: args }) + '\n');

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
const hang = () => setInterval(() => {}, 1_000_000);
const emit = (o) => out(JSON.stringify(o) + '\n');

const FAKE_TOKEN = 'sk-proj-FAKEtokenFAKEtokenFAKEtoken1234';

if (args[0] === '--version') {
  const mode = process.env.FAKE_DIAG_VERSION || 'ok';
  if (mode === 'hang') hang();
  else if (mode === 'fail') { err('boom\n'); process.exit(3); }
  else if (mode === 'malformed') out('codex-cli dev\n');
  else out('codex-cli 0.155.0-alpha.16.4\n');
} else if (args[0] === 'login' && args[1] === 'status') {
  const mode = process.env.FAKE_DIAG_AUTH || 'chatgpt';
  if (mode === 'hang') hang();
  else if (mode === 'chatgpt') err('Logged in using ChatGPT\n');
  else if (mode === 'api-key') err(`Logged in using an API key - ${FAKE_TOKEN}\n`);
  else if (mode === 'logged-out') { err('Not logged in\n'); process.exit(1); }
  else if (mode === 'malformed') err('Session: active (beta)\n');
  else if (mode === 'fail') { err('config.toml: parse error\n'); process.exit(2); }
  else if (mode === 'secret') { err(`auth.json unreadable: {"access_token":"${FAKE_TOKEN}","refresh_token":"fake-refresh-value-9876"}\n`); process.exit(2); }
} else if (args[0] === 'exec') {
  try { readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  const mode = process.env.FAKE_DIAG_PROBE || 'ok';
  if (mode === 'hang') hang();
  else if (mode === 'ok') {
    emit({ type: 'thread.started', thread_id: '11111111-1111-1111-1111-111111111111' });
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  } else if (mode === 'weekly-limit' || mode === 'limit') {
    const msg = mode === 'weekly-limit' ? "You've hit your weekly usage limit. Try again in 2 days." : "You've hit your usage limit. Try again later.";
    emit({ type: 'thread.started', thread_id: '11111111-1111-1111-1111-111111111111' });
    emit({ type: 'error', message: msg });
    emit({ type: 'turn.failed', error: { message: msg } });
    process.exit(1);
  } else if (mode === 'malformed') out('garbage\n');
  else if (mode === 'fail') { err('sandbox init failed\n'); process.exit(1); }
  else if (mode === 'secret') { err(`stream error: Authorization: Bearer fakebearervalue12345 key=${FAKE_TOKEN}\n`); process.exit(1); }
} else {
  err(`fake-codex-diag: unsupported args ${JSON.stringify(args)}\n`);
  process.exit(64);
}
