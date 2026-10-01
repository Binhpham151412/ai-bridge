import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveWorkflowControls, deriveWorkflowDisplayState } from '../../src/core/workflow/controls.ts';
import type { WorkflowInstance } from '../../src/core/workflow/types.ts';
import { created } from './runtime-fixtures.ts';

function inState(state: WorkflowInstance['state'], patch: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return { ...structuredClone(created().instance), state, ...patch };
}

const ctl = (inst: WorkflowInstance, hostAlive = true) => deriveWorkflowControls(inst, { hostAlive });

test('CREATED: start or stop', () => {
  assert.deepEqual(ctl(inState('CREATED')), { canStart: true, canPause: false, canResume: false, canStop: true, canAnswer: [] });
});

test('RUNNING: pause and stop, until one is pending', () => {
  assert.deepEqual(ctl(inState('RUNNING')), { canStart: false, canPause: true, canResume: false, canStop: true, canAnswer: [] });
  assert.equal(ctl(inState('RUNNING', { pauseRequested: true })).canPause, false);
  assert.deepEqual(ctl(inState('RUNNING', { stopRequested: 'USER' })), { canStart: false, canPause: false, canResume: false, canStop: false, canAnswer: [] });
});

test('RUNNING with a dead host is INTERRUPTED: resume (re-host) or stop, never pause', () => {
  const inst = inState('RUNNING');
  assert.equal(deriveWorkflowDisplayState(inst, false), 'INTERRUPTED');
  assert.equal(deriveWorkflowDisplayState(inst, true), 'RUNNING');
  assert.deepEqual(ctl(inst, false), { canStart: false, canPause: false, canResume: true, canStop: true, canAnswer: [] });
  assert.equal(deriveWorkflowDisplayState(inState('PAUSED'), false), 'PAUSED', 'only RUNNING can be interrupted');
});

test('PAUSED and BLOCKED: resume or stop', () => {
  for (const s of ['PAUSED', 'BLOCKED'] as const) {
    assert.deepEqual(ctl(inState(s)), { canStart: false, canPause: false, canResume: true, canStop: true, canAnswer: [] });
  }
});

test('WAITING_HUMAN: only the answers the M5 decider accepts are offered', () => {
  const inst = inState('WAITING_HUMAN', { waitingFor: { kind: 'HUMAN', reason: 'HUMAN_REQUESTED', attemptId: null, options: ['fail', 'stop', 'retry', 'resume-execution'] } });
  assert.deepEqual(ctl(inst), { canStart: false, canPause: false, canResume: false, canStop: true, canAnswer: ['fail', 'stop'] });
});

test('terminal states offer nothing', () => {
  for (const s of ['COMPLETED', 'FAILED', 'STOPPED'] as const) {
    assert.deepEqual(ctl(inState(s)), { canStart: false, canPause: false, canResume: false, canStop: false, canAnswer: [] });
    assert.deepEqual(ctl(inState(s), false), { canStart: false, canPause: false, canResume: false, canStop: false, canAnswer: [] });
  }
});
