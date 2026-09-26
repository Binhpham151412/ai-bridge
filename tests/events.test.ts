import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEvent, formatHumanLogLine, EVENT_TYPES, rotateIfOversized } from '../src/core/observability/events.ts';

async function withTmpFile<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-events-'));
  try {
    return await fn(path.join(dir, 'events.jsonl'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BASE = { timestamp: '2026-09-25T19:42:01.000Z', runId: '2026-09-25_001', iteration: 0, phase: 'RUN', event: 'RUN_STARTED' as const };

test('every required event type from the spec is a valid EventType', () => {
  const required = [
    'RUN_STARTED', 'RUN_STOPPED', 'RUN_COMPLETED', 'CLAUDE_STARTED', 'CLAUDE_EXITED', 'REPORT_DETECTED', 'REPORT_VALIDATED',
    'CODEX_STARTED', 'CODEX_EXITED', 'RESPONSE_PARSED', 'PROMPT_SENT', 'ITERATION_COMPLETED', 'ERROR', 'TIMEOUT',
    'RECOVERY_STARTED', 'RECOVERY_COMPLETED', 'PAUSE_REQUESTED', 'PAUSED',
  ];
  for (const t of required) assert.ok((EVENT_TYPES as readonly string[]).includes(t), t);
});

test('appendEvent writes one JSON line per call, in order, creating the file/dir as needed', () =>
  withTmpFile(async (file) => {
    await appendEvent(file, BASE);
    await appendEvent(file, { ...BASE, event: 'CLAUDE_STARTED', iteration: 1 });
    const lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).event, 'RUN_STARTED');
    assert.equal(JSON.parse(lines[1]).event, 'CLAUDE_STARTED');
  }));

test('appendEvent preserves extra caller-supplied fields', () =>
  withTmpFile(async (file) => {
    await appendEvent(file, { ...BASE, event: 'ERROR', errorCode: 'REPORT_INVALID' });
    const line = (await readFile(file, 'utf8')).trim();
    assert.equal(JSON.parse(line).errorCode, 'REPORT_INVALID');
  }));

test('formatHumanLogLine extracts HH:MM:SS from the ISO timestamp', () => {
  const line = formatHumanLogLine(BASE);
  assert.match(line, /^19:42:01 /);
});

test('formatHumanLogLine marks ERROR and TIMEOUT events at [ERROR] level, everything else at [INFO]', () => {
  assert.match(formatHumanLogLine({ ...BASE, event: 'ERROR' }), /\[ERROR\]/);
  assert.match(formatHumanLogLine({ ...BASE, event: 'TIMEOUT' }), /\[ERROR\]/);
  assert.match(formatHumanLogLine({ ...BASE, event: 'RUN_STARTED' }), /\[INFO\]/);
  assert.match(formatHumanLogLine({ ...BASE, event: 'CLAUDE_STARTED' }), /\[INFO\]/);
});

test('formatHumanLogLine uses the caller-supplied detail when present', () => {
  const line = formatHumanLogLine({ ...BASE, event: 'REPORT_VALIDATED', detail: 'Report 001 validated' });
  assert.match(line, /Report 001 validated/);
});

test('formatHumanLogLine falls back to a readable default message when no detail is given', () => {
  const line = formatHumanLogLine({ ...BASE, event: 'RUN_STARTED' });
  assert.match(line, /run started/i);
});

test('formatHumanLogLine prefixes the iteration number when iteration > 0', () => {
  const line = formatHumanLogLine({ ...BASE, event: 'ITERATION_COMPLETED', iteration: 3, detail: 'Iteration completed' });
  assert.match(line, /Iteration 3/);
});

test('formatHumanLogLine does not prefix an iteration number when iteration is 0', () => {
  const line = formatHumanLogLine({ ...BASE, event: 'RUN_STARTED', iteration: 0 });
  assert.doesNotMatch(line, /Iteration 0/);
});

// ---------------------------------------------------------------------------
// rotateIfOversized — a simple current -> .1 rotation, so events.jsonl/ai-bridge.log
// don't grow unboundedly across a long-running project (M3.5 §15).
// ---------------------------------------------------------------------------

test('rotateIfOversized does nothing when the file does not exist yet', () =>
  withTmpFile(async (file) => {
    await rotateIfOversized(file, 100);
    await assert.rejects(stat(file));
    await assert.rejects(stat(file + '.1'));
  }));

test('rotateIfOversized does nothing when the file is under the size limit', () =>
  withTmpFile(async (file) => {
    await writeFile(file, 'small content', 'utf8');
    await rotateIfOversized(file, 1_000_000);
    assert.equal(await readFile(file, 'utf8'), 'small content');
    await assert.rejects(stat(file + '.1'));
  }));

test('rotateIfOversized moves an oversized file to <file>.1 and leaves nothing at the original path', () =>
  withTmpFile(async (file) => {
    await writeFile(file, 'x'.repeat(2000), 'utf8');
    await rotateIfOversized(file, 1000);
    await assert.rejects(stat(file), 'the original path should be empty after rotation — the next append recreates it');
    assert.equal((await readFile(file + '.1', 'utf8')).length, 2000);
  }));

test('rotateIfOversized overwrites a pre-existing .1 backup rather than erroring', () =>
  withTmpFile(async (file) => {
    await writeFile(file + '.1', 'old backup', 'utf8');
    await writeFile(file, 'y'.repeat(2000), 'utf8');
    await rotateIfOversized(file, 1000);
    assert.equal((await readFile(file + '.1', 'utf8')).length, 2000);
  }));

test('appendEvent rotates the file first when a maxBytes option is given and exceeded, never losing the new event', () =>
  withTmpFile(async (file) => {
    await writeFile(file, 'x'.repeat(2000), 'utf8');
    await appendEvent(file, BASE, { maxBytes: 1000 });
    const current = await readFile(file, 'utf8');
    assert.equal(JSON.parse(current.trim()).event, 'RUN_STARTED');
    const backup = await readFile(file + '.1', 'utf8');
    assert.equal(backup.length, 2000);
  }));
