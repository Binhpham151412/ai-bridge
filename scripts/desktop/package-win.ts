#!/usr/bin/env node
// Packages the already-built dist-desktop/ into a portable Windows app folder
// (release/AI Bridge-win32-x64/AI Bridge.exe) plus a .zip of it. No installer, no code
// signing, no auto-update, no upload — local build only (M4 §27).
// Run via `pnpm package:win` (builds first).
import { packager } from '@electron/packager';
import { execFile } from 'node:child_process';
import { copyFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// `--out <dir>` packages elsewhere (e.g. while a copy from release/ is open and locked).
const outArg = process.argv.indexOf('--out');
const OUT = outArg !== -1 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'release');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { version: string; devDependencies: Record<string, string> };

await stat(path.join(ROOT, 'dist-desktop', 'main.mjs')); // fails fast if not built

await copyFile(
  path.join(ROOT, 'assets', 'icon.ico'),
  path.join(ROOT, 'dist-desktop', 'icon.ico'),
);

// Only package.json + the bundled dist-desktop/ go into the app. Everything else
// (src, tests, sandbox, docs, node_modules — all deps are bundled by esbuild) is left out.
const keep = (p: string) => p === '' || p === '/package.json' || p === '/dist-desktop' || p.startsWith('/dist-desktop/');

const [appDir] = await packager({
  dir: ROOT,
  out: OUT,
  name: 'AI Bridge',
  executableName: 'AI Bridge',
  appVersion: pkg.version,
  electronVersion: pkg.devDependencies.electron.replace(/^[^\d]*/, ''),
  platform: 'win32',
  arch: 'x64',
  icon: path.join(ROOT, 'assets', 'icon.ico'),
  overwrite: true,
  prune: true,
  // Not an archive: the run host (run-host.mjs) is forked as a separate Node process
  // and must be a plain file on disk. (asar is not a security boundary either way.)
  asar: false,
  ignore: (p: string) => !keep(p.replace(/\\/g, '/')),
  win32metadata: { CompanyName: 'AI Bridge (local)', ProductName: 'AI Bridge', FileDescription: 'AI Bridge desktop' },
});

const zip = path.join(OUT, `AI-Bridge-win32-x64-${pkg.version}-portable.zip`);
await rm(zip, { force: true });
await promisify(execFile)('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zip}'`], { maxBuffer: 16 * 1024 * 1024 });

console.log(`Portable app: ${path.relative(ROOT, path.join(appDir, 'AI Bridge.exe'))}`);
console.log(`Portable zip: ${path.relative(ROOT, zip)} (${((await stat(zip)).size / 1024 / 1024).toFixed(1)} MB)`);
