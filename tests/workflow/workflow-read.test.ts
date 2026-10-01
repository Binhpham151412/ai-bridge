import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { sealEvents } from '../../src/core/workflow/event-log.ts';
import type { WorkflowEventDraft } from '../../src/core/workflow/types.ts';
import { workflowLockPath } from '../../src/core/workflow/workflow-lock.ts';
import { WorkflowHost } from '../../src/hosts/workflow-host.ts';
import { getWorkflowSnapshot, listWorkflows, recoveryEntries } from '../../src/hosts/workflow-read.ts';
import { FakeExecutionPort, hang } from './fake-execution-port.ts';
import { DEAD_PID, aiBridgeOf, hostDeps, runCommand, until, withProject, writeDefinition } from './host-fixtures.ts';

// M5.9 read-side additions for the desktop UI — all computed in Core's read side from persisted
// state, so the renderer never derives them: the current step/attempt, the attempt outcome, the
// verification mode, and the recovery entries (straight from persisted events, never inferred).

test('list + snapshot: current step/attempt, attempt outcome and verification mode come from the persisted instance', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const host = new WorkflowHost(hostDeps(p, new FakeExecutionPort()));
    const began = await host.begin(runCommand(p, hash));
    assert.ok(began.ok);
    await host.finished();
    const id = began.ok ? began.workflowId : '';

    const [item] = await listWorkflows(aiBridgeOf(p));
    assert.deepEqual(item.currentStep, { stepId: 'docs', state: 'SUCCEEDED' }, 'no ACTIVE step: the last step that ran');
    assert.deepEqual(item.currentAttempt, { attemptId: `${id}/docs/1`, state: 'PASSED', executionId: '2026-10-01_002' });

    const snap = await getWorkflowSnapshot(aiBridgeOf(p), id);
    assert.ok(snap.ok);
    assert.equal(snap.value.currentStepId, 'docs');
    assert.deepEqual(snap.value.verification, { mode: 'OUTCOME_ONLY', deterministicChecks: 0 });
    const outcome = snap.value.steps[0].current?.outcome;
    assert.deepEqual([outcome?.kind, outcome?.finalStatus, outcome?.errorCode], ['ENDED', 'DONE', null]);
    assert.match(outcome?.class ?? '', /^[A-Z_]+$/, "the outcome table's class, as persisted");
    assert.deepEqual(snap.value.recovery, [], 'nothing was reconciled');
  }));

test('recovery entries: a real reconciliation after a Workflow Host crash appears as its persisted finding', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const a = new FakeExecutionPort();
    a.behave = async () => hang();
    const host = new WorkflowHost(hostDeps(p, a));
    const began = await host.begin(runCommand(p, hash));
    assert.ok(began.ok);
    await until(() => host.engine?.instance.steps[0].attempts[0]?.state === 'LAUNCHING', 5000, 'LAUNCHING');
    host.abandon();
    await writeFile(workflowLockPath(aiBridgeOf(p)), JSON.stringify({ pid: DEAD_PID }), 'utf8');
    const b = new WorkflowHost(hostDeps(p, new FakeExecutionPort()));
    const id = began.ok ? began.workflowId : '';
    assert.ok((await b.begin({ type: 'resume', projectPath: p, workflowId: id })).ok);
    await b.finished();

    const snap = await getWorkflowSnapshot(aiBridgeOf(p), id);
    assert.ok(snap.ok);
    assert.deepEqual(
      snap.value.recovery.map((r) => [r.kind, r.finding, r.attemptId]),
      [['FINDING', 'NOT_STARTED', `${id}/build/1`]],
    );
  }));

test('recoveryEntries: findings, store repairs and execution-host failures — nothing else, and no ADOPT (not in the log)', () => {
  const WF = 'wf_2026-10-01_001';
  const d = (type: WorkflowEventDraft['type'], payload: WorkflowEventDraft['payload'], executionId: string | null = null): WorkflowEventDraft => ({ type, timestamp: '2026-10-01T09:00:00.000Z', stepId: 'build', attemptId: `${WF}/build/1`, executionId, actor: 'workflow-engine', provider: null, payload, artifacts: [] });
  const events = sealEvents(WF, { seq: 0, hash: null }, [
    d('WORKFLOW_CREATED', {}),
    d('RECONCILED', { repairs: ['truncated a torn final line (9 bytes)'], tornTailBytes: 9, reappended: 0, snapshotWasBehind: false }),
    d('RECONCILED', { finding: 'WATCH', executionId: 'r1' }),
    d('INPUT_RECEIVED', { inputType: 'EXECUTION_ENDED', input: JSON.stringify({ type: 'EXECUTION_ENDED', result: { kind: 'ENDED', executionId: 'r1', finalStatus: 'DONE' } }) }),
    d('INPUT_RECEIVED', { inputType: 'EXECUTION_ENDED', input: JSON.stringify({ type: 'EXECUTION_ENDED', result: { kind: 'HOST_FAILED', executionId: 'r2' } }) }),
    d('INPUT_RECEIVED', { inputType: 'EXECUTION_ENDED', input: JSON.stringify({ type: 'EXECUTION_ENDED', result: { kind: 'RESUME_REFUSED', reason: 'NOT_CURRENT_SESSION' } }) }),
    d('RECONCILED', { finding: 'UNRESOLVABLE', reason: 'EXECUTION_NOT_RECOVERABLE' }),
  ]);
  assert.deepEqual(
    recoveryEntries(events).map((r) => [r.seq, r.kind, r.finding, r.executionId, r.reason]),
    [
      [2, 'STORE_REPAIR', null, null, 'truncated a torn final line (9 bytes)'],
      [3, 'FINDING', 'WATCH', 'r1', null],
      [5, 'HOST_FAILED', null, 'r2', null],
      [6, 'RESUME_REFUSED', null, null, 'NOT_CURRENT_SESSION'],
      [7, 'FINDING', 'UNRESOLVABLE', null, 'EXECUTION_NOT_RECOVERABLE'],
    ],
    'the adopted outcome (seq 4) is an ordinary input — not listed',
  );
});
