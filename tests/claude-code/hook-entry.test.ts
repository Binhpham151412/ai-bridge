import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENTRY = fileURLToPath(new URL('../../src/claude-code/hook-entry.ts', import.meta.url));
const BUILD = fileURLToPath(new URL('../../scripts/claude-plugin/build.ts', import.meta.url));
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** Runs the hook entry the way Claude Code does: JSON on stdin, JSON (or nothing) on stdout. */
function runHook(entry: string, kind: string, stdin: string, stateRoot: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, kind], { env: { ...process.env, AI_BRIDGE_CLAUDE_CODE_DIR: stateRoot }, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

async function withStateRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-cc-entry-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('prompt: /bridge arms the loop under AI_BRIDGE_CLAUDE_CODE_DIR and prints the hook JSON', () =>
  withStateRoot(async (root) => {
    const r = await runHook(ENTRY, 'prompt', JSON.stringify({ session_id: SESSION, cwd: root, prompt: '/bridge fix login', hook_event_name: 'UserPromptSubmit' }), root);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(JSON.parse(await readFile(path.join(root, SESSION, 'state.json'), 'utf8')).task, 'fix login');
  }));

test('stop: a session without /bridge prints nothing and exits 0', () =>
  withStateRoot(async (root) => {
    const r = await runHook(ENTRY, 'stop', JSON.stringify({ session_id: SESSION, cwd: root, transcript_path: 'x', stop_hook_active: false, last_assistant_message: 'hi' }), root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  }));

test('the built plugin hook is self-contained: copied out of the repo, it still arms the loop', () =>
  withStateRoot(async (root) => {
    const out = path.join(root, 'plugin-dist');
    const build = spawnSync(process.execPath, [BUILD, '--out', out], { encoding: 'utf8', windowsHide: true });
    assert.equal(build.status, 0, build.stderr);
    const r = await runHook(path.join(out, 'hook.mjs'), 'prompt', JSON.stringify({ session_id: SESSION, cwd: root, prompt: '/bridge fix login' }), root);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  }));

test('unreadable hook input never blocks: exit 0 with a message for the user', () =>
  withStateRoot(async (root) => {
    const r = await runHook(ENTRY, 'stop', 'not json', root);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage, /AI Bridge/);
  }));

test('while the Stop hook waits for Codex, Claude Code shows a spinner line saying so', async () => {
  const hooks = JSON.parse(await readFile(fileURLToPath(new URL('../../plugins/claude-code/hooks/hooks.json', import.meta.url)), 'utf8'));
  const stop = hooks.hooks.Stop[0].hooks[0];
  assert.match(stop.command, / stop$/);
  assert.match(stop.statusMessage ?? '', /Codex đang review/);
});
