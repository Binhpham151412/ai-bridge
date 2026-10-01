import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkflowHostCommand, isWorkflowHostControl, isWorkflowHostMessage } from '../../src/hosts/workflow-host-protocol.ts';

// M5.8: the Workflow Host protocol is validated in both directions — nothing a parent or a host
// sends is trusted, and anything unknown or malformed is refused, never acted on.

const HASH = 'a'.repeat(64);
const WF = 'wf_2026-10-01_001';
const run = { type: 'run', projectPath: 'D:\\p', definitionId: 'host-flow', definitionHash: HASH, inputs: { feature: 'x' } };

test('lifecycle commands: the four M5 commands with exactly their fields are accepted', () => {
  assert.equal(isWorkflowHostCommand(run), true);
  assert.equal(isWorkflowHostCommand({ ...run, inputs: {} }), true);
  assert.equal(isWorkflowHostCommand({ type: 'resume', projectPath: 'p', workflowId: WF }), true);
  assert.equal(isWorkflowHostCommand({ type: 'stop', projectPath: 'p', workflowId: WF }), true);
  assert.equal(isWorkflowHostCommand({ type: 'answer', projectPath: 'p', workflowId: WF, answer: 'fail' }), true);
  assert.equal(isWorkflowHostCommand({ type: 'answer', projectPath: 'p', workflowId: WF, answer: 'stop' }), true);
});

test('lifecycle commands: unknown types, extra fields, bad ids, paths, hashes, inputs and M6 answers are refused', () => {
  const bad: unknown[] = [
    null,
    'run',
    [],
    { ...run, type: 'exec' },
    { ...run, command: 'calc.exe' },
    { ...run, projectPath: '' },
    { ...run, projectPath: 42 },
    { ...run, definitionId: '../etc' },
    { ...run, definitionId: 'Host_Flow' },
    { ...run, definitionId: 'a'.repeat(65) },
    { ...run, definitionHash: 'abc' },
    { ...run, definitionHash: 'A'.repeat(64) },
    { ...run, inputs: [] },
    { ...run, inputs: { feature: 1 } },
    { ...run, inputs: { 'Bad Name': 'x' } },
    { ...run, inputs: { feature: 'a\u0000b' } },
    { type: 'resume', projectPath: 'p', workflowId: '../../state' },
    { type: 'resume', projectPath: 'p', workflowId: WF, extra: true },
    { type: 'stop', projectPath: 'p' },
    { type: 'answer', projectPath: 'p', workflowId: WF, answer: 'retry' },
    { type: 'answer', projectPath: 'p', workflowId: WF, answer: 'resume-execution' },
    { type: 'control', requestId: 'r1', action: 'stop' },
  ];
  for (const v of bad) assert.equal(isWorkflowHostCommand(v), false, JSON.stringify(v));
});

test('control requests: only pause/stop with a safe request id', () => {
  assert.equal(isWorkflowHostControl({ type: 'control', requestId: '1700000000000-42-1', action: 'pause' }), true);
  assert.equal(isWorkflowHostControl({ type: 'control', requestId: 'r', action: 'stop' }), true);
  for (const v of [
    { type: 'control', requestId: 'r', action: 'resume' },
    { type: 'control', requestId: 'r', action: 'answer' },
    { type: 'control', requestId: '../x', action: 'stop' },
    { type: 'control', requestId: '', action: 'stop' },
    { type: 'control', requestId: 'r', action: 'stop', workflowId: WF },
    { type: 'run', requestId: 'r', action: 'stop' },
  ]) {
    assert.equal(isWorkflowHostControl(v), false, JSON.stringify(v));
  }
});

test('host messages: typed shapes accepted; malformed ones (bad state, code, event) refused', () => {
  const event = { type: 'WORKFLOW_CREATED', workflowId: WF, seq: 1, eventId: `${WF}#1`, timestamp: 't', hash: 'h', prevHash: null, payload: {} };
  const good: unknown[] = [
    { type: 'accepted', workflowId: WF, state: 'RUNNING' },
    { type: 'rejected', error: { code: 'WORKFLOW_LOCKED', message: 'm' } },
    { type: 'rejected', error: { code: 'INPUTS_INVALID', message: 'm', details: ['$.x MISSING: y'] } },
    { type: 'event', event },
    { type: 'control-result', requestId: 'r', result: { ok: true, state: 'RUNNING' } },
    { type: 'control-result', requestId: 'r', result: { ok: false, error: { code: 'NOT_ALLOWED', message: 'm' } } },
    { type: 'ended', end: { workflowId: WF, state: 'COMPLETED', reason: 'REST', errors: [] } },
    { type: 'failed', message: 'boom' },
  ];
  for (const v of good) assert.equal(isWorkflowHostMessage(v), true, JSON.stringify(v));
  const bad: unknown[] = [
    { type: 'accepted', workflowId: WF, state: 'DONE' },
    { type: 'accepted', workflowId: 'x', state: 'RUNNING' },
    { type: 'rejected', error: { code: 'SOMETHING', message: 'm' } },
    { type: 'rejected', error: { code: 'NOT_ALLOWED' } },
    { type: 'event', event: { ...event, type: 'RUN_STARTED' } },
    { type: 'event', event: { ...event, seq: 0 } },
    { type: 'event', event: { ...event, payload: null } },
    { type: 'control-result', requestId: 'r', result: { ok: true } },
    { type: 'ended', end: { workflowId: WF, state: 'COMPLETED', reason: 'CRASHED', errors: [] } },
    { type: 'outcome', outcome: {} },
    'plain text',
  ];
  for (const v of bad) assert.equal(isWorkflowHostMessage(v), false, JSON.stringify(v));
});
