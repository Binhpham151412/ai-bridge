#!/usr/bin/env node
// Fake `agy` CLI for provider diagnostics: only `--version` exists as a status command.
//   FAKE_DIAG_VERSION  ok | malformed | fail | hang
//   FAKE_DIAG_LOG      if set, every invocation's argv is appended to this file as a JSON line
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_DIAG_LOG) appendFileSync(process.env.FAKE_DIAG_LOG, JSON.stringify({ argv: args }) + '\n');

if (args[0] === '--version') {
  const mode = process.env.FAKE_DIAG_VERSION || 'ok';
  if (mode === 'hang') setInterval(() => {}, 1_000_000);
  else if (mode === 'fail') { process.stderr.write('boom\n'); process.exit(3); }
  else if (mode === 'malformed') process.stdout.write('agy (dev build)\n');
  else process.stdout.write('1.3.4\n');
} else {
  process.stderr.write(`fake-agy-diag: unsupported args ${JSON.stringify(args)}\n`);
  process.exit(64);
}
