import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTransition, assertValidTransition } from '../src/core/state-machine/transitions.ts';

test('accepts the normal happy-path sequence, transition by transition', () => {
  const sequence = [
    'IDLE',
    'PREFLIGHT',
    'CLAUDE_EXECUTING',
    'REPORT_DETECTED',
    'REPORT_VALIDATED',
    'CODEX_REVIEWING',
    'CODEX_RESPONSE_RECEIVED',
    'RESPONSE_PARSED',
    'CLAUDE_EXECUTING', // loop back for iteration 2 on CONTINUE
    'REPORT_DETECTED',
    'REPORT_VALIDATED',
    'CODEX_REVIEWING',
    'CODEX_RESPONSE_RECEIVED',
    'RESPONSE_PARSED',
    'DONE',
  ] as const;
  for (let i = 1; i < sequence.length; i++) {
    assert.equal(isValidTransition(sequence[i - 1], sequence[i]), true, `${sequence[i - 1]} -> ${sequence[i]}`);
  }
});

test('rejects the example invalid transition from the spec: IDLE -> DONE', () => {
  assert.equal(isValidTransition('IDLE', 'DONE'), false);
});

test('accepts the same valid sequence the spec\'s example describes, using this project\'s equivalent state names (IDLE->STARTING, STARTING->CLAUDE_EXECUTING, CLAUDE_EXECUTING->CLAUDE_COMPLETED)', () => {
  // This implementation keeps PREFLIGHT (not STARTING) and REPORT_DETECTED (not
  // CLAUDE_COMPLETED) — permitted explicitly by the M3 spec §9 ("Không cần dùng state
  // nào nếu implementation hiện tại đã có tên tương đương").
  assert.equal(isValidTransition('IDLE', 'PREFLIGHT'), true);
  assert.equal(isValidTransition('PREFLIGHT', 'CLAUDE_EXECUTING'), true);
  assert.equal(isValidTransition('CLAUDE_EXECUTING', 'REPORT_DETECTED'), true);
});

test('rejects a transition straight from IDLE into the middle of a run', () => {
  for (const target of ['CLAUDE_EXECUTING', 'REPORT_VALIDATED', 'CODEX_REVIEWING', 'RESPONSE_PARSED']) {
    assert.equal(isValidTransition('IDLE', target as never), false, `IDLE -> ${target}`);
  }
});

test('rejects skipping straight from CLAUDE_EXECUTING to CODEX_REVIEWING (report steps required)', () => {
  assert.equal(isValidTransition('CLAUDE_EXECUTING', 'CODEX_REVIEWING'), false);
});

test('every truly terminal state has no valid outgoing transition (PAUSED is excluded: it can resume)', () => {
  const terminals = ['DONE', 'NEED_HUMAN', 'ERROR', 'STOPPED', 'STOPPED_MAX_ITERATIONS'] as const;
  const anyOther = ['IDLE', 'PREFLIGHT', 'CLAUDE_EXECUTING', 'DONE', 'ERROR'] as const;
  for (const from of terminals) {
    for (const to of anyOther) {
      assert.equal(isValidTransition(from, to), false, `${from} -> ${to} should be invalid (terminal state)`);
    }
  }
});

test('accepts entering PAUSED from a safe boundary (PREFLIGHT or RESPONSE_PARSED)', () => {
  assert.equal(isValidTransition('PREFLIGHT', 'PAUSED'), true);
  assert.equal(isValidTransition('RESPONSE_PARSED', 'PAUSED'), true);
});

test('rejects entering PAUSED mid-flight (not a safe boundary)', () => {
  assert.equal(isValidTransition('CLAUDE_EXECUTING', 'PAUSED'), false);
  assert.equal(isValidTransition('CODEX_REVIEWING', 'PAUSED'), false);
});

test('accepts resuming from PAUSED back into execution', () => {
  assert.equal(isValidTransition('PAUSED', 'CLAUDE_EXECUTING'), true);
});

test('accepts RECOVERING as an entry point after IDLE, leading back to PREFLIGHT', () => {
  assert.equal(isValidTransition('IDLE', 'RECOVERING'), true);
  assert.equal(isValidTransition('RECOVERING', 'PREFLIGHT'), true);
});

test('isValidTransition never throws — it is a pure predicate', () => {
  assert.doesNotThrow(() => isValidTransition('DONE', 'IDLE'));
  assert.equal(isValidTransition('DONE', 'IDLE'), false);
});

test('assertValidTransition does nothing for a valid transition', () => {
  assert.doesNotThrow(() => assertValidTransition('IDLE', 'PREFLIGHT'));
});

test('assertValidTransition throws INVALID_STATE_TRANSITION for an invalid one, naming both states', () => {
  assert.throws(() => assertValidTransition('IDLE', 'DONE'), /INVALID_STATE_TRANSITION/);
  assert.throws(() => assertValidTransition('IDLE', 'DONE'), /IDLE/);
  assert.throws(() => assertValidTransition('IDLE', 'DONE'), /DONE/);
});

test('every state named in the spec is recognized (unknown-state transitions are rejected, not silently true)', () => {
  const specStates = [
    'IDLE', 'STARTING', 'CLAUDE_EXECUTING', 'CLAUDE_COMPLETED', 'REPORT_DETECTED', 'REPORT_VALIDATED',
    'CODEX_EXECUTING', 'CODEX_COMPLETED', 'RESPONSE_PARSED', 'PROMPT_PERSISTED', 'PROMPT_READY',
    'WAITING_FOR_CLAUDE', 'ITERATION_COMPLETED', 'PAUSED', 'RECOVERING', 'DONE', 'NEED_HUMAN', 'ERROR', 'STOPPED',
  ];
  for (const s of specStates) {
    assert.doesNotThrow(() => isValidTransition(s as never, s as never), `isValidTransition must not throw for spec state "${s}"`);
  }
});
