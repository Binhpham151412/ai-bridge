#!/usr/bin/env node
// Fake `opencode` CLI for provider diagnostics. Handles only what the OpenCode provider runs:
// `--version` and `auth list`.
//
// Env vars (each defaults to the healthy behaviour):
//   FAKE_DIAG_VERSION  ok | malformed | fail | hang
//   FAKE_DIAG_AUTH     credentials | none | malformed | fail | hang
//   FAKE_DIAG_LOG      if set, every invocation's argv is appended to this file as a JSON line

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_DIAG_LOG) appendFileSync(process.env.FAKE_DIAG_LOG, JSON.stringify({ argv: args }) + '\n');

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
const hang = () => setInterval(() => {}, 1_000_000);
const ESC = String.fromCharCode(27);

if (args[0] === '--version') {
  const mode = process.env.FAKE_DIAG_VERSION || 'ok';
  if (mode === 'hang') hang();
  else if (mode === 'fail') { err('boom\n'); process.exit(3); }
  else if (mode === 'malformed') out('opencode (dev build)\n');
  else out('1.14.30\n');
} else if (args[0] === 'auth' && args[1] === 'list') {
  const mode = process.env.FAKE_DIAG_AUTH || 'credentials';
  if (mode === 'hang') hang();
  else if (mode === 'credentials') out(`${ESC}[0m\n${ESC}[90m┌${ESC}[39m  Credentials ${ESC}[90m~/.local/share/opencode/auth.json\n${ESC}[90m│${ESC}[39m\n${ESC}[34m●${ESC}[39m  Anthropic ${ESC}[90mapi\n${ESC}[90m│${ESC}[39m\n${ESC}[90m└${ESC}[39m  2 credentials\n`);
  else if (mode === 'none') out(`${ESC}[90m┌${ESC}[39m  Credentials\n${ESC}[90m└${ESC}[39m  0 credentials\n`);
  else if (mode === 'malformed') out('something else entirely\n');
  else if (mode === 'fail') { err('internal error\n'); process.exit(2); }
} else {
  err(`fake-opencode-diag: unsupported args ${JSON.stringify(args)}\n`);
  process.exit(64);
}
