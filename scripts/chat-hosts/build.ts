#!/usr/bin/env node
// Bundles the OpenCode and Antigravity plugins (docs/67, docs/68) into one self-contained file each:
//   plugins/opencode/dist/ai-bridge.js      (OpenCode loads a plugin file on its own, with Bun)
//   plugins/antigravity/dist/hook.mjs       (the hook command of the Antigravity plugin, run with node)
// An installed plugin is copied out of this repo, so it must not import anything from src/ at run
// time. The outputs are committed, so installing needs no build; tests/chat-hosts/dist-build.test.ts
// keeps them current.
// Usage: node scripts/chat-hosts/build.ts [opencode|antigravity] [--out <dir>]
//   --out puts the bundle(s) in <dir> instead of the plugin folders (one target only).

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const TARGETS = {
  opencode: { entry: ['src', 'chat-hosts', 'opencode', 'entry.ts'], dist: ['plugins', 'opencode', 'dist'], file: 'ai-bridge.js' },
  antigravity: { entry: ['src', 'chat-hosts', 'antigravity', 'hook-entry.ts'], dist: ['plugins', 'antigravity', 'dist'], file: 'hook.mjs' },
} as const;

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex === -1 ? null : path.resolve(args[outIndex + 1] ?? '');
const named = args.filter((a, i) => !a.startsWith('--') && i !== outIndex + 1) as Array<keyof typeof TARGETS>;
const unknown = named.filter((n) => !(n in TARGETS));
if (unknown.length > 0 || (outDir !== null && named.length !== 1)) {
  console.error('usage: node scripts/chat-hosts/build.ts [opencode|antigravity] [--out <dir>]  (--out needs exactly one target)');
  process.exit(2);
}

for (const name of named.length > 0 ? named : (Object.keys(TARGETS) as Array<keyof typeof TARGETS>)) {
  const t = TARGETS[name];
  const dist = outDir ?? path.join(ROOT, ...t.dist);
  await build({
    // The path comments in the bundle are relative to this: the same output from any cwd.
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, ...t.entry)],
    outfile: path.join(dist, t.file),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
    legalComments: 'none',
  });
  console.log(`Built the ${name} plugin into ${path.relative(ROOT, dist) || dist}`);
}
