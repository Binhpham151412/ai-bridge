import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine, MAX_CORRELATION_LENGTH, isValidCorrelation, type Preflight } from '../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../src/core/config/config.ts';
import type { BridgeEvent } from '../src/core/observability/events.ts';
import { isHostCommand } from '../src/desktop/main/run-host-protocol.ts';

// M5.4 (ADR-017 option B): BridgeEngine's additive, optional `correlation`. Persisted with
// the run and echoed on RUN_STARTED; runs without it are byte-for-byte what they were.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

let doctorCalls = 0;
const doctor = async (): Promise<Preflight> => {
  doctorCalls += 1;
  return {
    report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
    claudeExe: process.execPath,
    codexExe: process.execPath,
    config: DEFAULT_CONFIG,
    configErrors: [],
    gitWarning: null,
  };
};

async function withEngine<T>(fn: (engine: BridgeEngine, projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-corr-'));
  try {
    const engine = new BridgeEngine(root, { runDoctor: doctor, claudeCommandArgsPrefix: [FAKE_CLAUDE], codexCommandArgsPrefix: [FAKE_CODEX], claudeEnv: { FAKE_CLAUDE_MODE: 'ok' }, codexEnv: { FAKE_CODEX_MODE: 'sequence' } });
    return await fn(engine, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const stateOf = async (projectPath: string) => JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'state', 'current-session.json'), 'utf8'));
const loggedEvents = async (projectPath: string) =>
  (await readFile(path.join(projectPath, '.ai-bridge', 'logs', 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BridgeEvent);

test('start({correlation}) persists it in current-session.json and echoes it on RUN_STARTED (live and logged)', () =>
  withEngine(async (engine, projectPath) => {
    const live: BridgeEvent[] = [];
    engine.subscribe((e) => live.push(e));
    const r = await engine.start({ task: 'x', correlation: 'wf_2026-10-01_001/build/1' });
    assert.equal(r.kind, 'COMPLETED');
    assert.equal((await stateOf(projectPath)).correlation, 'wf_2026-10-01_001/build/1');
    assert.equal(live.find((e) => e.event === 'RUN_STARTED')?.correlation, 'wf_2026-10-01_001/build/1');
    assert.equal((await loggedEvents(projectPath)).find((e) => e.event === 'RUN_STARTED')?.correlation, 'wf_2026-10-01_001/build/1');
    assert.equal(live.filter((e) => 'correlation' in e).length, 1, 'only RUN_STARTED carries it');
  }));

test('without a correlation nothing changes: no field in the state file or on RUN_STARTED', () =>
  withEngine(async (engine, projectPath) => {
    await engine.start({ task: 'x' });
    assert.equal('correlation' in (await stateOf(projectPath)), false);
    assert.equal((await loggedEvents(projectPath)).some((e) => 'correlation' in e), false);
  }));

test('an invalid correlation is INVALID_OPTIONS before preflight — no doctor, no session', () =>
  withEngine(async (engine, projectPath) => {
    for (const correlation of ['', 'a\nb', 'tab\there', 'x'.repeat(MAX_CORRELATION_LENGTH + 1)]) {
      doctorCalls = 0;
      const r = await engine.start({ task: 'x', correlation });
      assert.equal(r.kind, 'INVALID_OPTIONS', JSON.stringify(correlation));
      assert.equal(doctorCalls, 0);
    }
    await assert.rejects(stat(path.join(projectPath, '.ai-bridge', 'sessions')));
  }));

test('isValidCorrelation accepts printable strings up to the limit', () => {
  assert.equal(isValidCorrelation('wf_2026-10-01_001/build/1'), true);
  assert.equal(isValidCorrelation('ünïcode ✓'), true);
  assert.equal(isValidCorrelation('x'.repeat(MAX_CORRELATION_LENGTH)), true);
  for (const bad of ['', 'x'.repeat(MAX_CORRELATION_LENGTH + 1), 'a\u0000b', 'del\u007f', 42, null, undefined]) assert.equal(isValidCorrelation(bad), false, String(bad));
});

test('the host protocol accepts an optional string correlation on start, and nothing else', () => {
  assert.equal(isHostCommand({ type: 'start', projectPath: 'p', task: 't' }), true);
  assert.equal(isHostCommand({ type: 'start', projectPath: 'p', task: 't', correlation: 'c' }), true);
  assert.equal(isHostCommand({ type: 'start', projectPath: 'p', task: 't', correlation: 5 }), false);
  assert.equal(isHostCommand({ type: 'start', projectPath: 'p', task: 't', correlation: null }), false);
  assert.equal(isHostCommand({ type: 'resume', projectPath: 'p' }), true);
});
