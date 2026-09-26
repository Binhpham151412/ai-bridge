import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli-args.ts';

test('parses the command and its flags', () => {
  const r = parseArgs(['start', '--project', 'D:\\proj', '--task', 'Do the thing', '--max-iterations', '5']);
  assert.equal(r.command, 'start');
  assert.equal(r.flags.project, 'D:\\proj');
  assert.equal(r.flags.task, 'Do the thing');
  assert.equal(r.flags['max-iterations'], '5');
});

test('parses resume, logs, reset, and pause as valid commands', () => {
  assert.equal(parseArgs(['resume', '--project', 'p']).command, 'resume');
  assert.equal(parseArgs(['logs', '--project', 'p']).command, 'logs');
  assert.equal(parseArgs(['reset', '--project', 'p']).command, 'reset');
  assert.equal(parseArgs(['pause', '--project', 'p']).command, 'pause');
});

test('parses doctor with no flags', () => {
  const r = parseArgs(['doctor']);
  assert.equal(r.command, 'doctor');
  assert.deepEqual(r.flags, {});
});

test('reports an unknown command', () => {
  const r = parseArgs(['frobnicate']);
  assert.equal(r.command, null);
  assert.equal(r.error, 'Unknown command: frobnicate');
});

test('reports no command when argv is empty', () => {
  const r = parseArgs([]);
  assert.equal(r.command, null);
  assert.match(r.error ?? '', /Usage/);
});

test('a flag value containing spaces or Vietnamese text is kept as one value', () => {
  const r = parseArgs(['start', '--project', 'D:\\proj', '--task', 'Sửa lỗi ở src/sum.js']);
  assert.equal(r.flags.task, 'Sửa lỗi ở src/sum.js');
});

test('a flag with no following value is rejected, not silently dropped', () => {
  const r = parseArgs(['start', '--project']);
  assert.equal(r.command, null);
  assert.match(r.error ?? '', /--project/);
});
