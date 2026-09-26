import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/core/session-manager/session-manager.ts';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-session-mgr-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('creates the reports, sessions, logs, and state directories', () =>
  withTmpDir(async (root) => {
    const mgr = new SessionManager({ aiBridgeDir: root, now: () => new Date('2026-09-25T10:00:00Z') });
    const s = await mgr.createSession();
    for (const dir of [s.reportsDir, s.logsDir, path.dirname(s.stateFile), s.sessionDir]) {
      const stat = await readdir(path.dirname(dir + path.sep)).catch(() => null);
      assert.ok(stat !== null, `expected ${dir} to exist`);
    }
  }));

test('names the first session of a day 001', () =>
  withTmpDir(async (root) => {
    const mgr = new SessionManager({ aiBridgeDir: root, now: () => new Date('2026-09-25T10:00:00Z') });
    const s = await mgr.createSession();
    assert.equal(s.sessionId, '2026-09-25_001');
    assert.equal(s.sessionDir, path.join(root, 'sessions', '2026-09-25_001'));
  }));

test('increments the counter for a second session on the same day', () =>
  withTmpDir(async (root) => {
    const mgr = new SessionManager({ aiBridgeDir: root, now: () => new Date('2026-09-25T10:00:00Z') });
    await mgr.createSession();
    const s2 = await mgr.createSession();
    assert.equal(s2.sessionId, '2026-09-25_002');
  }));

test('resets the counter to 001 on a new day', () =>
  withTmpDir(async (root) => {
    let day = '2026-09-25T10:00:00Z';
    const mgr = new SessionManager({ aiBridgeDir: root, now: () => new Date(day) });
    await mgr.createSession();
    day = '2026-09-26T10:00:00Z';
    const s2 = await mgr.createSession();
    assert.equal(s2.sessionId, '2026-09-26_001');
  }));

test('writeSessionFile writes valid JSON that round-trips the given data', () =>
  withTmpDir(async (root) => {
    const mgr = new SessionManager({ aiBridgeDir: root, now: () => new Date('2026-09-25T10:00:00Z') });
    const s = await mgr.createSession();
    const data = { sessionId: s.sessionId, projectName: 'Demo', status: 'RUNNING', iterations: [] };
    await mgr.writeSessionFile(s.sessionDir, data);
    const raw = await readFile(path.join(s.sessionDir, 'session.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw), data);
  }));

test('writeState writes valid JSON to the state file, overwriting on each call', () =>
  withTmpDir(async (root) => {
    const mgr = new SessionManager({ aiBridgeDir: root, now: () => new Date('2026-09-25T10:00:00Z') });
    const s = await mgr.createSession();
    await mgr.writeState(s.stateFile, { sessionId: s.sessionId, iteration: 1, status: 'CLAUDE_EXECUTING' });
    await mgr.writeState(s.stateFile, { sessionId: s.sessionId, iteration: 2, status: 'CODEX_REVIEWING' });
    const raw = await readFile(s.stateFile, 'utf8');
    assert.deepEqual(JSON.parse(raw), { sessionId: s.sessionId, iteration: 2, status: 'CODEX_REVIEWING' });
  }));
