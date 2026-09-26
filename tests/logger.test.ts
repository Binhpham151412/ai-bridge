import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendLogLine } from '../src/core/logger/logger.ts';

async function withTmpFile<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-logger-'));
  try {
    return await fn(path.join(dir, 'session.log'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const EVENT = {
  timestamp: '2026-09-25T10:00:00.000Z',
  sessionId: '2026-09-25_001',
  iteration: 1,
  adapter: 'claude' as const,
  command: 'claude -p --session-id ...',
  exitCode: 0,
  durationMs: 1234,
  reportPath: 'D:\\proj\\.ai-bridge\\reports\\001-report.md',
  status: 'ok' as const,
  error: null,
};

test('appends one JSON line per call, in order', () =>
  withTmpFile(async (file) => {
    await appendLogLine(file, EVENT);
    await appendLogLine(file, { ...EVENT, iteration: 2 });
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).iteration, 1);
    assert.equal(JSON.parse(lines[1]).iteration, 2);
  }));

test('each line is valid, self-contained JSON with the required fields', () =>
  withTmpFile(async (file) => {
    await appendLogLine(file, EVENT);
    const line = (await readFile(file, 'utf8')).trim();
    const parsed = JSON.parse(line);
    for (const key of ['timestamp', 'sessionId', 'iteration', 'adapter', 'command', 'exitCode', 'durationMs', 'reportPath', 'status', 'error']) {
      assert.ok(key in parsed, `missing field ${key}`);
    }
  }));

test('creates the log file and its parent directory if they do not exist yet', () =>
  withTmpFile(async (file) => {
    await appendLogLine(file, EVENT);
    const content = await readFile(file, 'utf8');
    assert.ok(content.length > 0);
  }));
