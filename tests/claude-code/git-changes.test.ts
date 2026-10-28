import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { changesSince, headCommit } from '../../src/claude-code/git-changes.ts';

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd });

async function withRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-git-'));
  try {
    await git(dir, 'init', '-q');
    await writeFile(path.join(dir, 'a.txt'), 'one\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'base');
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('headCommit is the commit checked out, or null outside a repository', async () => {
  await withRepo(async (dir) => {
    assert.match((await headCommit(dir)) ?? '', /^[0-9a-f]{40}$/);
  });
  const plain = await mkdtemp(path.join(tmpdir(), 'ai-bridge-nogit-'));
  try {
    assert.equal(await headCommit(plain), null);
    assert.equal(await changesSince(plain, null), null);
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

test('changesSince shows what changed since the base: committed, uncommitted and new files', async () => {
  await withRepo(async (dir) => {
    const base = (await headCommit(dir))!;
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n');
    await git(dir, 'commit', '-q', '-am', 'second');
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    await writeFile(path.join(dir, 'new.txt'), 'fresh\n');
    const text = (await changesSince(dir, base)) ?? '';
    assert.match(text, /\+two/);
    assert.match(text, /\+three/);
    assert.match(text, /\?\? new\.txt/);
  });
});

test('with nothing changed there is nothing to show', async () => {
  await withRepo(async (dir) => {
    assert.equal(await changesSince(dir, await headCommit(dir)), null);
  });
});

test('a large diff is cut, and says so', async () => {
  await withRepo(async (dir) => {
    const base = await headCommit(dir);
    await writeFile(path.join(dir, 'a.txt'), `${'x'.repeat(120)}\n`.repeat(2_000));
    const text = (await changesSince(dir, base, 5_000)) ?? '';
    assert.ok(text.length < 6_000);
    assert.match(text, /cut at 5000 characters/);
  });
});
