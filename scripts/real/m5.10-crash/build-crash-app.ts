#!/usr/bin/env node
// TEST-ONLY (M5.10 B″, docs/59 §23). Assembles the ISOLATED crash app used by the J1/J2 real E2E:
//
//   sandbox/m5.10-crash-app/package.json               = <repo>/package.json            (copied)
//   sandbox/m5.10-crash-app/dist-desktop/**            = <repo>/dist-desktop/**          (copied verbatim)
//   sandbox/m5.10-crash-app/dist-desktop/workflow-host.mjs  ← rebuilt from workflow-host-crash-entry.ts
//
// The production build (scripts/desktop/build.ts → dist-desktop/) is NOT run, changed or written
// here: run `pnpm build` first. The crash workflow-host.mjs uses the same esbuild options build.ts
// uses for the production workflow-host.mjs (non-dev: bundle, minify, no sourcemap, node22 ESM).
//
// Verification (any failure → exit 1):
//   1. every crash-app file except dist-desktop/workflow-host.mjs has the SHA-256 of its dist-desktop/
//      (or package.json) counterpart, and the file sets are identical;
//   2. the sentinel (CRASH_ENV) is present in the crash workflow-host.mjs and in no other crash-app file;
//   3. the sentinel is absent from every file of dist-desktop/ and of every release*/<app>/resources/app/;
//   4. dist-desktop/ is byte-identical before and after this script (untouched).
//
// Usage: node scripts/real/m5.10-crash/build-crash-app.ts [--out <dir>]
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRASH_ENV } from './crash-config.ts';

export const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const DIST = path.join(ROOT, 'dist-desktop');
export const DEFAULT_OUT = path.join(ROOT, 'sandbox', 'm5.10-crash-app');
export const APP_MARKER = '.m5.10-crash-app';
export const MANIFEST = 'crash-app-manifest.json';
export const CRASH_BUNDLE = 'dist-desktop/workflow-host.mjs';
const ENTRY = fileURLToPath(new URL('./workflow-host-crash-entry.ts', import.meta.url));
const SENTINEL = Buffer.from(CRASH_ENV, 'utf8');

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Relative (forward-slash) path → sha256 of every file under `dir`. */
export async function hashTree(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await hashTree(dir, r));
    else if (entry.isFile()) out[r] = sha256(await readFile(path.join(dir, r)));
  }
  return out;
}

/** Files under `dir` that contain the sentinel (relative paths). */
export async function sentinelHits(dir: string, rel = ''): Promise<{ scanned: number; hits: string[] }> {
  let scanned = 0;
  const hits: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const sub = await sentinelHits(dir, r);
      scanned += sub.scanned;
      hits.push(...sub.hits);
    } else if (entry.isFile()) {
      scanned += 1;
      if ((await readFile(path.join(dir, r))).includes(SENTINEL)) hits.push(r);
    }
  }
  return { scanned, hits };
}

/** Every packaged app code directory: release[-*]/<app>/resources/app (asar is off: plain files). */
export async function releaseAppDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for (const top of (await readdir(ROOT, { withFileTypes: true })).filter((e) => e.isDirectory() && /^release(-.*)?$/.test(e.name))) {
    for (const app of (await readdir(path.join(ROOT, top.name), { withFileTypes: true })).filter((e) => e.isDirectory())) {
      const code = path.join(ROOT, top.name, app.name, 'resources', 'app');
      if (existsSync(code)) dirs.push(code);
    }
  }
  return dirs;
}

export interface IsolationReport {
  ok: boolean;
  failures: string[];
  identical: string[];
  differing: string[];
  sentinel: { crashBundle: boolean; otherCrashFiles: string[]; distDesktop: { scanned: number; hits: string[] }; releases: { dir: string; scanned: number; hits: string[] }[] };
}

/** The isolation checks 1–3 (4 needs the before/after hashes of a build run). */
export async function verifyCrashApp(appDir: string): Promise<IsolationReport> {
  const failures: string[] = [];
  const prodTree: Record<string, string> = { 'package.json': sha256(await readFile(path.join(ROOT, 'package.json'))) };
  for (const [k, v] of Object.entries(await hashTree(DIST))) prodTree[`dist-desktop/${k}`] = v;
  const crashTree: Record<string, string> = { 'package.json': sha256(await readFile(path.join(appDir, 'package.json'))) };
  for (const [k, v] of Object.entries(await hashTree(path.join(appDir, 'dist-desktop')))) crashTree[`dist-desktop/${k}`] = v;

  const identical: string[] = [];
  const differing: string[] = [];
  for (const f of new Set([...Object.keys(prodTree), ...Object.keys(crashTree)])) {
    if (!(f in crashTree)) failures.push(`missing in the crash app: ${f}`);
    else if (!(f in prodTree)) failures.push(`extra in the crash app: ${f}`);
    else if (prodTree[f] === crashTree[f]) identical.push(f);
    else differing.push(f);
  }
  if (differing.length !== 1 || differing[0] !== CRASH_BUNDLE) failures.push(`only ${CRASH_BUNDLE} may differ; differing: ${differing.join(', ') || 'none'}`);

  const crashHits = await sentinelHits(appDir);
  const crashBundle = crashHits.hits.includes(CRASH_BUNDLE);
  const otherCrashFiles = crashHits.hits.filter((h) => h !== CRASH_BUNDLE && h !== MANIFEST);
  if (!crashBundle) failures.push(`the sentinel is missing from the crash ${CRASH_BUNDLE}`);
  if (otherCrashFiles.length > 0) failures.push(`the sentinel is present in other crash-app files: ${otherCrashFiles.join(', ')}`);

  const distDesktop = await sentinelHits(DIST);
  if (distDesktop.hits.length > 0) failures.push(`the sentinel is present in dist-desktop/: ${distDesktop.hits.join(', ')}`);
  const releases: IsolationReport['sentinel']['releases'] = [];
  for (const dir of await releaseAppDirs()) {
    const r = await sentinelHits(dir);
    releases.push({ dir: path.relative(ROOT, dir), ...r });
    if (r.hits.length > 0) failures.push(`the sentinel is present in ${path.relative(ROOT, dir)}: ${r.hits.join(', ')}`);
  }
  return { ok: failures.length === 0, failures, identical, differing, sentinel: { crashBundle, otherCrashFiles, distDesktop, releases } };
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(path.join(from, entry.name), path.join(to, entry.name));
    else if (entry.isFile()) await copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex !== -1 ? path.resolve(process.argv[outIndex + 1]) : DEFAULT_OUT;
  if (!existsSync(path.join(DIST, 'main.mjs')) || !existsSync(path.join(DIST, 'workflow-host.mjs'))) throw new Error('dist-desktop/ is not built — run `pnpm build` first');
  const maps = Object.keys(await hashTree(DIST)).filter((f) => f.endsWith('.map'));
  if (maps.length > 0) throw new Error(`dist-desktop/ is a --dev build (${maps.length} source maps); run \`pnpm build\` (the production build) first`);

  const distBefore = await hashTree(DIST);
  if (existsSync(out)) {
    if (!existsSync(path.join(out, APP_MARKER))) throw new Error(`${out} exists and was not created by this script — refusing to replace it`);
    await rm(out, { recursive: true, force: true });
  }
  await mkdir(out, { recursive: true });
  await copyFile(path.join(ROOT, 'package.json'), path.join(out, 'package.json'));
  await copyTree(DIST, path.join(out, 'dist-desktop'));
  // The same options scripts/desktop/build.ts uses for the production workflow-host.mjs (non-dev).
  await build({
    bundle: true,
    sourcemap: false,
    minify: true,
    logLevel: 'warning',
    legalComments: 'none',
    entryPoints: [ENTRY],
    outfile: path.join(out, 'dist-desktop', 'workflow-host.mjs'),
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  await writeFile(path.join(out, APP_MARKER), 'disposable M5.10 crash app (scripts/real/m5.10-crash/build-crash-app.ts)\n');

  const report = await verifyCrashApp(out);
  const distAfter = await hashTree(DIST);
  const distUntouched = JSON.stringify(distBefore) === JSON.stringify(distAfter);
  if (!distUntouched) report.failures.push('dist-desktop/ changed while the crash app was built');
  const ok = report.ok && distUntouched;
  const manifest = {
    schema: 1,
    builtAt: new Date().toISOString(),
    ok,
    failures: report.failures,
    crashBundle: { file: CRASH_BUNDLE, sha256: sha256(await readFile(path.join(out, 'dist-desktop', 'workflow-host.mjs'))), productionSha256: distBefore['workflow-host.mjs'] },
    identical: report.identical.length,
    differing: report.differing,
    distUntouched,
    distTreeSha256: sha256(Buffer.from(JSON.stringify(distBefore))),
    sentinel: report.sentinel,
  };
  await writeFile(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`crash app: ${path.relative(ROOT, out)}`);
  console.log(`  identical to production: ${report.identical.length} files; differing: ${report.differing.join(', ')}`);
  console.log(`  crash workflow-host.mjs ${manifest.crashBundle.sha256.slice(0, 16)}… (production ${String(manifest.crashBundle.productionSha256).slice(0, 16)}…)`);
  console.log(`  sentinel: crash bundle ${report.sentinel.crashBundle ? 'present' : 'MISSING'}; other crash files ${report.sentinel.otherCrashFiles.length}; dist-desktop hits ${report.sentinel.distDesktop.hits.length}/${report.sentinel.distDesktop.scanned}; ${report.sentinel.releases.map((r) => `${r.dir} hits ${r.hits.length}/${r.scanned}`).join('; ')}`);
  console.log(`  dist-desktop untouched: ${distUntouched}`);
  console.log(ok ? 'CRASH APP ISOLATION: PASS' : `CRASH APP ISOLATION: FAIL\n  - ${report.failures.join('\n  - ')}`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
