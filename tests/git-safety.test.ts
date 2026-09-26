import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGitStatus } from '../src/core/preflight/git-safety.ts';

test('reports no warning for a clean git repository', async () => {
  const r = await checkGitStatus('/proj', { runGit: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  assert.equal(r.isGitRepo, true);
  assert.equal(r.hasUncommittedChanges, false);
  assert.equal(r.warning, null);
});

test('reports WARNING_UNCOMMITTED_CHANGES when porcelain output is non-empty', async () => {
  const r = await checkGitStatus('/proj', { runGit: async () => ({ exitCode: 0, stdout: ' M src/foo.ts\n?? new-file.txt\n', stderr: '' }) });
  assert.equal(r.isGitRepo, true);
  assert.equal(r.hasUncommittedChanges, true);
  assert.equal(r.warning, 'WARNING_UNCOMMITTED_CHANGES');
});

test('reports WARNING_NOT_GIT_REPOSITORY when git says so', async () => {
  const r = await checkGitStatus('/proj', {
    runGit: async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }),
  });
  assert.equal(r.isGitRepo, false);
  assert.equal(r.hasUncommittedChanges, false);
  assert.equal(r.warning, 'WARNING_NOT_GIT_REPOSITORY');
});

test('treats a git binary that cannot be found the same as not-a-repository, not as a crash', async () => {
  const r = await checkGitStatus('/proj', {
    runGit: async () => {
      throw new Error('spawn git ENOENT');
    },
  });
  assert.equal(r.isGitRepo, false);
  assert.equal(r.warning, 'WARNING_NOT_GIT_REPOSITORY');
});

test('treats whitespace-only porcelain output as clean, not as changes', async () => {
  const r = await checkGitStatus('/proj', { runGit: async () => ({ exitCode: 0, stdout: '\n', stderr: '' }) });
  assert.equal(r.hasUncommittedChanges, false);
  assert.equal(r.warning, null);
});

test('runs "git status --porcelain" in the given project directory, nothing else', async () => {
  const calls: Array<{ args: string[]; cwd: string | undefined }> = [];
  await checkGitStatus('/proj', {
    runGit: async (args, cwd) => {
      calls.push({ args, cwd });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['status', '--porcelain']);
  assert.equal(calls[0].cwd, '/proj');
});
