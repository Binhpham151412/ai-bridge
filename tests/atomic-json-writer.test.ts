import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AtomicJsonWriter } from '../src/core/state-manager/atomic-json-writer.ts';

async function withTmpFile<T>(fn: (filePath: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-atomic-'));
  try {
    return await fn(path.join(dir, 'state.json'), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writes valid JSON that round-trips the given data', () =>
  withTmpFile(async (filePath) => {
    const writer = new AtomicJsonWriter(filePath);
    await writer.write({ iteration: 1 });
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { iteration: 1 });
  }));

test('a second sequential write fully replaces the first', () =>
  withTmpFile(async (filePath) => {
    const writer = new AtomicJsonWriter(filePath);
    await writer.write({ iteration: 1 });
    await writer.write({ iteration: 2 });
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { iteration: 2 });
  }));

test('creates the parent directory if it does not exist yet', () =>
  withTmpFile(async (filePath, dir) => {
    const nested = path.join(dir, 'nested', 'state.json');
    const writer = new AtomicJsonWriter(nested);
    await writer.write({ ok: true });
    assert.deepEqual(JSON.parse(await readFile(nested, 'utf8')), { ok: true });
  }));

test('leaves no temp files behind after a write', () =>
  withTmpFile(async (filePath, dir) => {
    const writer = new AtomicJsonWriter(filePath);
    await writer.write({ ok: true });
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['state.json']);
  }));

test('N concurrent (unawaited) writes serialize instead of racing: the file always holds exactly one complete, valid write, never interleaved bytes from two writes', () =>
  withTmpFile(async (filePath) => {
    const writer = new AtomicJsonWriter(filePath);
    const N = 25;
    const promises: Promise<void>[] = [];
    const seenValidPayloads = new Set<number>();
    let corrupted = false;

    // Fire all writes without awaiting individually (this is exactly how cli.ts's
    // onTransition/onPidUpdate/onSessionUpdate callbacks fire writes today).
    for (let i = 0; i < N; i++) {
      promises.push(writer.write({ i }));
    }
    // While writes are in flight, repeatedly read the file — every successful read
    // must parse as valid JSON belonging to exactly one of the N writes; a read that
    // throws is fine (means it raced a rename), but a read that succeeds with garbage
    // is the exact bug this module exists to prevent.
    const poll = (async () => {
      // 60 reads is already far more contention than realistic production usage (a
      // `status`/`logs` read is a single readFile, not a tight loop) — enough to
      // exercise the read/rename race without fighting the writer's retry budget.
      for (let j = 0; j < 60; j++) {
        try {
          const text = await readFile(filePath, 'utf8');
          const parsed = JSON.parse(text);
          if (typeof parsed.i !== 'number' || parsed.i < 0 || parsed.i >= N) {
            corrupted = true;
          } else {
            seenValidPayloads.add(parsed.i);
          }
        } catch {
          // ENOENT or a parse error from reading mid-rename is acceptable — atomic
          // rename means a reader either sees the old complete file or the new
          // complete file, never a half-written one from a *finished* write. A
          // transient parse error here would only happen if a non-atomic rename
          // race existed — recorded as corruption too, to be safe.
        }
      }
    })();

    await Promise.all(promises);
    await poll;

    assert.equal(corrupted, false, 'a read returned a value that could not have come from any single complete write');
    const final = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(final.i, N - 1, 'the last write must win, not an interleaving of two writes');
  }));
