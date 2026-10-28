#!/usr/bin/env node
// Bundles the OpenCode plugin (docs/67) into one self-contained file:
//   plugins/opencode/dist/ai-bridge.js
// OpenCode loads a plugin file on its own (Bun), so it must not import anything from src/ at run
// time. Copy the output to `.opencode/plugins/` (one project) or `~/.config/opencode/plugins/`.
// Usage: node scripts/opencode-plugin/build.ts [--out <dir>]

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? path.join(ROOT, 'plugins', 'opencode', 'dist') : path.resolve(process.argv[outIndex + 1]);

await build({
  absWorkingDir: ROOT,
  entryPoints: [path.join(ROOT, 'plugins', 'opencode', 'entry.ts')],
  outfile: path.join(OUT, 'ai-bridge.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  legalComments: 'none',
});

console.log(`Built the OpenCode plugin into ${path.relative(ROOT, OUT) || OUT}`);
