import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveControls, type ControlInput } from '../../src/desktop/shared/controls.ts';

const base: ControlInput = { hasProject: true, status: 'NOT_STARTED', iteration: 1, recovery: 'NONE', pendingAction: null, pauseRequested: false, runAttached: false };
const c = (over: Partial<ControlInput>) => deriveControls({ ...base, ...over });

test('IDLE (no session yet): only START', () => {
  assert.deepEqual(c({}), { canStart: true, canPause: false, canResume: false, stopMode: null });
});

test('RUNNING: PAUSE and STOP, never START/RESUME', () => {
  assert.deepEqual(c({ status: 'RUNNING', runAttached: true, recovery: 'RUNNING' }), { canStart: false, canPause: true, canResume: false, stopMode: 'STOP' });
});

test('RUNNING but still before iteration 1 (PREFLIGHT): no PAUSE — Core would make that pause un-resumable (regression)', () => {
  assert.deepEqual(c({ status: 'RUNNING', iteration: 0, runAttached: true }), { canStart: false, canPause: false, canResume: false, stopMode: 'STOP' });
});

test('RUNNING with a pause already requested: STOP stays available, PAUSE does not repeat', () => {
  assert.deepEqual(c({ status: 'RUNNING', runAttached: true, pauseRequested: true, pendingAction: 'pause' }), { canStart: false, canPause: false, canResume: false, stopMode: 'STOP' });
});

test('PAUSED + Core says RECOVERABLE: RESUME and STOP (discard), no START', () => {
  assert.deepEqual(c({ status: 'PAUSED', recovery: 'RECOVERABLE' }), { canStart: false, canPause: false, canResume: true, stopMode: 'DISCARD' });
});

test('PAUSED but Core says BLOCKED: no RESUME — React never decides recoverability', () => {
  assert.deepEqual(c({ status: 'PAUSED', recovery: 'BLOCKED' }), { canStart: false, canPause: false, canResume: false, stopMode: 'DISCARD' });
});

test('INTERRUPTED (crash): RESUME only if RECOVERABLE; START only once the session is not recoverable', () => {
  assert.deepEqual(c({ status: 'INTERRUPTED', recovery: 'RECOVERABLE' }), { canStart: false, canPause: false, canResume: true, stopMode: 'DISCARD' });
  assert.deepEqual(c({ status: 'INTERRUPTED', recovery: 'BLOCKED' }), { canStart: true, canPause: false, canResume: false, stopMode: 'DISCARD' });
});

test('ERROR / STOPPED / DONE / NEED_HUMAN / STOPPED_MAX_ITERATIONS: START again, nothing else', () => {
  for (const status of ['ERROR', 'STOPPED', 'DONE', 'NEED_HUMAN', 'STOPPED_MAX_ITERATIONS']) {
    assert.deepEqual(c({ status }), { canStart: true, canPause: false, canResume: false, stopMode: null }, status);
  }
});

test('a run started elsewhere (CLI) is still controllable: PAUSE/STOP through Core', () => {
  assert.deepEqual(c({ status: 'RUNNING', runAttached: false }), { canStart: false, canPause: true, canResume: false, stopMode: 'STOP' });
});

test('while an action is in flight nothing else can be started; no project disables everything', () => {
  assert.deepEqual(c({ pendingAction: 'start', runAttached: true }), { canStart: false, canPause: false, canResume: false, stopMode: null });
  assert.deepEqual(c({ hasProject: false, status: null }), { canStart: false, canPause: false, canResume: false, stopMode: null });
});
