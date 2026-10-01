#!/usr/bin/env node
// Builds the desktop app into dist-desktop/ with esbuild (no dev server, no HMR):
//   main.mjs      Electron main process (ESM, node platform, `electron` external)
//   preload.cjs   preload script (CJS — required for sandboxed preloads)
//   run-host.mjs  the child process that runs BridgeEngine.start()/resume()
//   workflow-host.mjs  the Workflow Host (M5.8): runs the WorkflowEngine, forks run-host.mjs per execution
//   renderer/     index.html + app.js (React) + app.css
// Usage: node scripts/desktop/build.ts [--dev]   (--dev keeps sourcemaps, no minify)

import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = path.join(ROOT, 'dist-desktop');
const dev = process.argv.includes('--dev');
const src = (p: string) => path.join(ROOT, 'src', 'desktop', p);

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: dev, minify: !dev, logLevel: 'warning' as const, legalComments: 'none' as const };

await Promise.all([
  build({ ...common, entryPoints: [src('main/main.ts')], outfile: path.join(OUT, 'main.mjs'), platform: 'node', format: 'esm', target: 'node22', external: ['electron'] }),
  build({ ...common, entryPoints: [src('main/run-host-entry.ts')], outfile: path.join(OUT, 'run-host.mjs'), platform: 'node', format: 'esm', target: 'node22' }),
  build({ ...common, entryPoints: [path.join(ROOT, 'src', 'hosts', 'workflow-host-entry.ts')], outfile: path.join(OUT, 'workflow-host.mjs'), platform: 'node', format: 'esm', target: 'node22' }),
  build({ ...common, entryPoints: [src('preload/preload.ts')], outfile: path.join(OUT, 'preload.cjs'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] }),
  build({
    ...common,
    entryPoints: [src('renderer/main.tsx')],
    outfile: path.join(OUT, 'renderer', 'app.js'),
    platform: 'browser',
    format: 'esm',
    target: 'chrome130',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  }),
]);

await copyFile(src('renderer/index.html'), path.join(OUT, 'renderer', 'index.html'));
await copyFile(src('renderer/styles.css'), path.join(OUT, 'renderer', 'app.css'));
await copyFile(path.join(ROOT, 'assets', 'icon.ico'), path.join(OUT, 'icon.ico'));

console.log(`Built desktop app into ${path.relative(ROOT, OUT)}${dev ? ' (dev)' : ''}`);
