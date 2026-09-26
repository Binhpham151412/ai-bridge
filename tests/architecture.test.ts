import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE_DIRS = ['core', 'adapters', 'reports', 'prompts'].map((d) => path.join(ROOT, 'src', d));

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listTsFiles(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

async function allCoreFiles(): Promise<string[]> {
  const lists = await Promise.all(CORE_DIRS.map(listTsFiles));
  return lists.flat();
}

/** Strips block and line comments so mentions like "production wiring passes
 * process.exit()" in a doc comment don't false-positive as a real call site. Not a
 * full parser — good enough for this codebase's plain comment style. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('no file under core/adapters/reports/prompts imports cli.ts or cli-args.ts', async () => {
  const files = await allCoreFiles();
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*\bcli(-args)?\.ts['"]/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `Core files must never import cli.ts/cli-args.ts:\n${offenders.join('\n')}`);
});

test('no file under core/adapters/reports/prompts calls console.log/console.error/console.warn', async () => {
  const files = await allCoreFiles();
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (/console\.(log|error|warn|info|debug)\s*\(/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `Core files must never call console.*:\n${offenders.join('\n')}`);
});

test('no file under core/adapters/reports/prompts calls process.exit directly (crash-injection callbacks are supplied by the CLI, not constructed in Core)', async () => {
  const files = await allCoreFiles();
  const offenders: string[] = [];
  for (const file of files) {
    const text = stripComments(await readFile(file, 'utf8'));
    if (/process\.exit\s*\(/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `Core files must never call process.exit directly:\n${offenders.join('\n')}`);
});

test('BridgeEngine is exported from src/core/bridge-engine.ts and cli.ts is the one importing it (not the other way around)', async () => {
  const bridgeEngineSrc = await readFile(path.join(ROOT, 'src', 'core', 'bridge-engine.ts'), 'utf8');
  assert.match(bridgeEngineSrc, /export class BridgeEngine/);
  const cliSrc = await readFile(path.join(ROOT, 'src', 'cli.ts'), 'utf8');
  assert.match(cliSrc, /from\s+['"]\.\/core\/bridge-engine\.ts['"]/);
});
