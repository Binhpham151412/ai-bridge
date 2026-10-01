import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Workflow-layer rules (docs/19 §4, ADR-001, docs/39 M5.1–M5.3): the workflow layer sits
// ABOVE the execution engine. Its domain modules (types, definition, validation, hashing,
// transitions, outcome mapping, budgets, decider, controls) are pure. Only the M5.3
// persistence modules touch the filesystem — and only under .ai-bridge/workflows and the
// workflow lock. Nothing in it may reach BridgeEngine, the Orchestrator, adapters,
// providers, process spawning or the desktop app; nothing outside it may import it yet.

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW_DIR = path.join(ROOT, 'src', 'core', 'workflow');
const IO_MODULES = new Set(['event-log.ts', 'store.ts', 'workflow-lock.ts', 'engine.ts', 'journal.ts']);

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function importsOf(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const core = (...p: string[]) => path.join(ROOT, 'src', 'core', ...p);

/** Modules outside src/core/workflow that pure workflow code may import. */
const PURE_EXTERNAL = new Set([core('config', 'config.ts'), core('integrity', 'integrity.ts')]);
/** Additionally allowed for the persistence modules: the reused atomic writer and run-lock. */
const IO_EXTERNAL = new Set([...PURE_EXTERNAL, core('state-manager', 'atomic-json-writer.ts'), core('lock', 'run-lock.ts'), core('journal', 'journal.ts')]);
const IO_NODE = new Set(['node:fs/promises', 'node:path']);

async function workflowFiles(): Promise<{ file: string; rel: string; io: boolean; text: string }[]> {
  return Promise.all(
    (await tsFiles(WORKFLOW_DIR)).map(async (file) => ({ file, rel: path.relative(ROOT, file), io: IO_MODULES.has(path.basename(file)), text: await readFile(file, 'utf8') })),
  );
}

/** M5.4: the ExecutionPort contract is the ONLY workflow module that may reference the
 * execution engine — and only its types (docs/23 §9). */
const PORT_CONTRACT = 'execution-port.ts';
const PORT_TYPE_IMPORTS = new Set([
  core('bridge-engine.ts'),
  core('observability', 'events.ts'),
  core('session-history', 'session-history.ts'),
  // M5.10.1: the provider-neutral permission request (inherit/ask/bypass) — no CLI knowledge.
  core('permissions', 'permission-policy.ts'),
]);

function importStatements(text: string): { spec: string; typeOnly: boolean }[] {
  return [...stripComments(text).matchAll(/\bimport\s+(type\s+)?[^'";]*?\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => ({ spec: m[2], typeOnly: m[1] !== undefined }));
}

test('pure workflow modules import only workflow modules plus config.ts and integrity.ts — never node:*, never the I/O modules', async () => {
  const offenders: string[] = [];
  for (const { file, rel, io, text } of await workflowFiles()) {
    if (io) continue;
    const isPortContract = path.basename(file) === PORT_CONTRACT;
    for (const { spec, typeOnly } of importStatements(text)) {
      if (!spec.startsWith('.')) {
        offenders.push(`${rel} → ${spec}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec);
      const insideWorkflow = target.startsWith(WORKFLOW_DIR + path.sep);
      if (insideWorkflow) {
        if (IO_MODULES.has(path.basename(target))) offenders.push(`${rel} → ${spec}`);
      } else if (!PURE_EXTERNAL.has(target) && !(isPortContract && typeOnly && PORT_TYPE_IMPORTS.has(target))) {
        offenders.push(`${rel} → ${spec}${isPortContract && PORT_TYPE_IMPORTS.has(target) ? ' (must be `import type`)' : ''}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('persistence modules use only node:fs/promises, node:path, the atomic writer and run-lock beyond the workflow layer', async () => {
  const offenders: string[] = [];
  for (const { file, rel, io, text } of await workflowFiles()) {
    if (!io) continue;
    for (const spec of importsOf(text)) {
      if (!spec.startsWith('.')) {
        if (!IO_NODE.has(spec)) offenders.push(`${rel} → ${spec}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(WORKFLOW_DIR + path.sep) && !IO_EXTERNAL.has(target)) offenders.push(`${rel} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the workflow layer never spawns processes, evaluates code, reads env, logs to the console or uses the network', async () => {
  const offenders: string[] = [];
  for (const { rel, text } of await workflowFiles()) {
    if (/\b(eval|Function)\s*\(|\bnew\s+Function\b|child_process|\bspawn\s*\(|\bprocess\.(exit|env)\b|console\.\w+\s*\(|\bfetch\s*\(/.test(stripComments(text))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('pure modules (decider, budgets, …) never read a clock or randomness — time arrives on the input', async () => {
  const offenders: string[] = [];
  for (const { rel, io, text } of await workflowFiles()) {
    if (!io && /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bMath\.random\s*\(|\brandomUUID\s*\(|\bperformance\.now\s*\(/.test(stripComments(text))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

const HOSTS_DIR = path.join(ROOT, 'src', 'hosts');

test('only src/hosts (the ExecutionPort implementation) imports the workflow layer — BridgeEngine/Orchestrator/adapters/desktop never do', async () => {
  const offenders: string[] = [];
  for (const file of await tsFiles(path.join(ROOT, 'src'))) {
    if (file.startsWith(WORKFLOW_DIR + path.sep) || file.startsWith(HOSTS_DIR + path.sep)) continue;
    if (importsOf(await readFile(file, 'utf8')).some((s) => s.includes('workflow/'))) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

test('src/hosts reaches execution only through BridgeEngine and the existing run-host protocol — never the Orchestrator, adapters or child_process', async () => {
  const offenders: string[] = [];
  for (const file of await tsFiles(HOSTS_DIR)) {
    const text = await readFile(file, 'utf8');
    for (const spec of importsOf(text)) {
      if (/orchestrator|adapters\/|child_process|process-runner|automation\//.test(spec)) offenders.push(`${path.relative(ROOT, file)} → ${spec}`);
    }
    if (/\bspawn\s*\(|\bfork\s*\(|\bprocess\.kill\s*\(/.test(stripComments(text))) offenders.push(`${path.relative(ROOT, file)}: creates or kills processes itself`);
  }
  assert.deepEqual(offenders, []);
});
