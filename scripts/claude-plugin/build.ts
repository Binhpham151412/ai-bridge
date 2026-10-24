#!/usr/bin/env node
// Bundles the Claude Code plugin's hook command (docs/66) into one self-contained file:
//   plugins/claude-code/dist/hook.mjs
// An installed plugin is copied out of this repo (into ~/.claude/plugins/cache/…), so the hook
// must not import anything from src/ at run time.
// Usage: node scripts/claude-plugin/build.ts [--out <dir>]

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? path.join(ROOT, 'plugins', 'claude-code', 'dist') : path.resolve(process.argv[outIndex + 1]);

await build({
  entryPoints: [path.join(ROOT, 'src', 'claude-code', 'hook-entry.ts')],
  outfile: path.join(OUT, 'hook.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  legalComments: 'none',
});

console.log(`Built the Claude Code plugin hook into ${path.relative(ROOT, OUT) || OUT}`);
