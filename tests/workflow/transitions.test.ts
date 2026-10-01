import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidAttemptTransition,
  assertValidInstanceTransition,
  assertValidStepTransition,
  isValidAttemptTransition,
  isValidInstanceTransition,
  isValidStepTransition,
} from '../../src/core/workflow/transitions.ts';
import { TERMINAL_ATTEMPT_STATES, TERMINAL_INSTANCE_STATES, WORKFLOW_ATTEMPT_STATES, WORKFLOW_INSTANCE_STATES, WORKFLOW_STEP_STATES } from '../../src/core/workflow/types.ts';

// The expected tables, written out independently from docs/22 §4.1 / §5 / §6.
const INSTANCE: Record<string, string[]> = {
  CREATED: ['RUNNING', 'STOPPED'],
  RUNNING: ['RUNNING', 'PAUSED', 'WAITING_HUMAN', 'BLOCKED', 'COMPLETED', 'FAILED', 'STOPPED'],
  PAUSED: ['RUNNING', 'STOPPED'],
  WAITING_HUMAN: ['RUNNING', 'FAILED', 'STOPPED'],
  BLOCKED: ['RUNNING', 'STOPPED'],
  COMPLETED: [],
  FAILED: [],
  STOPPED: [],
};
const STEP: Record<string, string[]> = { PENDING: ['ACTIVE'], ACTIVE: ['ACTIVE', 'SUCCEEDED', 'FAILED', 'STOPPED'], SUCCEEDED: [], FAILED: [], STOPPED: [] };
const ATTEMPT: Record<string, string[]> = {
  PLANNED: ['LAUNCHING', 'STOPPED'],
  LAUNCHING: ['EXECUTING', 'NOT_STARTED', 'LAUNCH_UNKNOWN', 'PLANNED'],
  EXECUTING: ['PAUSED_EXECUTION', 'EXECUTION_ENDED', 'EXECUTION_FAILED', 'NEEDS_HUMAN', 'STOPPED', 'NOT_STARTED'],
  PAUSED_EXECUTION: ['EXECUTING', 'STOPPED', 'NEEDS_HUMAN'],
  EXECUTION_ENDED: ['VERIFYING', 'REJECTED', 'STOPPED'],
  VERIFYING: ['PASSED', 'REJECTED', 'NEEDS_HUMAN', 'STOPPED'],
  LAUNCH_UNKNOWN: ['EXECUTING', 'NEEDS_HUMAN', 'PLANNED', 'STOPPED'],
  NOT_STARTED: ['LAUNCHING'],
  PASSED: [],
  REJECTED: [],
  EXECUTION_FAILED: [],
  NEEDS_HUMAN: [],
  STOPPED: [],
};

function exhaustive<S extends string>(states: readonly S[], table: Record<string, string[]>, isValid: (a: S, b: S) => boolean, assertValid: (a: S, b: S) => void, kind: string): void {
  for (const from of states) {
    for (const to of states) {
      const expected = table[from].includes(to);
      assert.equal(isValid(from, to), expected, `${kind} ${from} -> ${to}`);
      if (expected) assert.doesNotThrow(() => assertValid(from, to));
      else assert.throws(() => assertValid(from, to), new RegExp(`INVALID_WORKFLOW_TRANSITION: ${kind} ${from} -> ${to}`));
    }
  }
}

test('instance: every pair of states is valid exactly as docs/22 §4.1 lists', () => {
  exhaustive(WORKFLOW_INSTANCE_STATES, INSTANCE, isValidInstanceTransition, assertValidInstanceTransition, 'instance');
});

test('step: every pair of states is valid exactly as docs/22 §5 lists', () => {
  exhaustive(WORKFLOW_STEP_STATES, STEP, isValidStepTransition, assertValidStepTransition, 'step');
});

test('attempt: every pair of states is valid exactly as docs/22 §6 lists', () => {
  exhaustive(WORKFLOW_ATTEMPT_STATES, ATTEMPT, isValidAttemptTransition, assertValidAttemptTransition, 'attempt');
});

test('the invalid examples named in docs/22 §4.2 and §5 are rejected', () => {
  for (const [from, to] of [
    ['CREATED', 'COMPLETED'],
    ['PAUSED', 'COMPLETED'],
    ['WAITING_HUMAN', 'COMPLETED'],
    ['BLOCKED', 'PAUSED'],
    ['BLOCKED', 'COMPLETED'],
  ] as const) {
    assert.equal(isValidInstanceTransition(from, to), false, `${from} -> ${to}`);
  }
  assert.equal(isValidStepTransition('PENDING', 'SUCCEEDED'), false);
  for (const to of WORKFLOW_STEP_STATES) assert.equal(isValidStepTransition('SUCCEEDED', to), false);
});

test('terminal instance states and terminal attempt states have no way out (NOT_STARTED only relaunches)', () => {
  for (const s of TERMINAL_INSTANCE_STATES) for (const to of WORKFLOW_INSTANCE_STATES) assert.equal(isValidInstanceTransition(s, to), false);
  for (const s of TERMINAL_ATTEMPT_STATES) {
    for (const to of WORKFLOW_ATTEMPT_STATES) assert.equal(isValidAttemptTransition(s, to), s === 'NOT_STARTED' && to === 'LAUNCHING', `${s} -> ${to}`);
  }
});

test('an unknown state is never a valid source', () => {
  assert.equal(isValidInstanceTransition('BOGUS' as never, 'RUNNING'), false);
  assert.throws(() => assertValidAttemptTransition('BOGUS' as never, 'PLANNED'), /INVALID_WORKFLOW_TRANSITION/);
});
