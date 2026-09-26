import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRecoveryStrategy } from '../src/core/recovery/recovery.ts';

const BASE = { status: 'DONE', iteration: 3, claudeSessionId: 'c1', codexThreadId: 't1' };

test('RESPONSE_PARSED: continues at iteration+1, resuming Claude, not skipping it', () => {
  const r = decideRecoveryStrategy({ ...BASE, status: 'RESPONSE_PARSED', iteration: 2 });
  assert.equal(r.kind, 'CONTINUE_FROM_PROMPT');
  if (r.kind === 'CONTINUE_FROM_PROMPT') {
    assert.equal(r.readPromptForIteration, 2);
    assert.deepEqual(r.resumeState, { startIteration: 3, claudeSessionId: 'c1', codexThreadId: 't1', skipClaudeThisIteration: false });
  }
});

test('PAUSED with iteration >= 1: same handling as RESPONSE_PARSED', () => {
  const r = decideRecoveryStrategy({ ...BASE, status: 'PAUSED', iteration: 4 });
  assert.equal(r.kind, 'CONTINUE_FROM_PROMPT');
  if (r.kind === 'CONTINUE_FROM_PROMPT') {
    assert.equal(r.readPromptForIteration, 4);
    assert.equal(r.resumeState.startIteration, 5);
  }
});

test('PAUSED with iteration 0: blocked — no persisted task to resume from', () => {
  const r = decideRecoveryStrategy({ ...BASE, status: 'PAUSED', iteration: 0 });
  assert.equal(r.kind, 'BLOCKED');
  if (r.kind === 'BLOCKED') assert.match(r.reason, /before any iteration/i);
});

test('REPORT_VALIDATED: re-sends the existing report, skipping Claude for that iteration', () => {
  const r = decideRecoveryStrategy({ ...BASE, status: 'REPORT_VALIDATED', iteration: 5 });
  assert.equal(r.kind, 'RESEND_REPORT_TO_CODEX');
  if (r.kind === 'RESEND_REPORT_TO_CODEX') {
    assert.equal(r.iteration, 5);
    assert.deepEqual(r.resumeState, { startIteration: 5, claudeSessionId: 'c1', codexThreadId: 't1', skipClaudeThisIteration: true });
  }
});

test('CODEX_REVIEWING: same handling as REPORT_VALIDATED', () => {
  const r = decideRecoveryStrategy({ ...BASE, status: 'CODEX_REVIEWING', iteration: 1 });
  assert.equal(r.kind, 'RESEND_REPORT_TO_CODEX');
});

for (const status of ['IDLE', 'PREFLIGHT', 'CLAUDE_EXECUTING', 'CODEX_RESPONSE_RECEIVED', 'DONE', 'NEED_HUMAN', 'ERROR', 'STOPPED', 'STOPPED_MAX_ITERATIONS']) {
  test(`${status}: blocked — not a safely resumable checkpoint`, () => {
    const r = decideRecoveryStrategy({ ...BASE, status });
    assert.equal(r.kind, 'BLOCKED');
    if (r.kind === 'BLOCKED') assert.match(r.reason, new RegExp(status));
  });
}

test('BLOCKED never suggests re-running Claude blindly (the reason names why)', () => {
  const r = decideRecoveryStrategy({ ...BASE, status: 'CLAUDE_EXECUTING' });
  assert.equal(r.kind, 'BLOCKED');
});
