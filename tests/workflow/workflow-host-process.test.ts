import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from '../../src/core/workflow/store.ts';
import { readWorkflowLockOwner } from '../../src/core/workflow/workflow-lock.ts';
import { forkChildHost } from '../../src/desktop/main/fork-run-host.ts';
import type { RunHostExit } from '../../src/desktop/main/run-controller.ts';
import { isWorkflowHostMessage, type WorkflowHostMessage } from '../../src/hosts/workflow-host-protocol.ts';
import { aiBridgeOf, runCommand, until, withProject, writeDefinition } from './host-fixtures.ts';

// M5.8 across REAL process boundaries: a forked Workflow Host (the production
// serveWorkflowHost) driving REAL Execution Host processes (the production run host +
// BridgeEngine with fake Claude/Codex CLIs). No real CLI, no quota.

const HOST = fileURLToPath(new URL('../fixtures/workflow/fake-workflow-host.ts', import.meta.url));
const FORKED = { FAKE_WF_PORT: 'forked', FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' };

function forkHost(env: Record<string, string> = {}) {
  const child = forkChildHost<unknown>({ scriptPath: HOST, execPath: process.execPath, env: { ...process.env, ...env } });
  const messages: WorkflowHostMessage[] = [];
  const invalid: unknown[] = [];
  child.onMessage((m) => (isWorkflowHostMessage(m) ? messages.push(m) : invalid.push(m)));
  const exited = new Promise<RunHostExit>((resolve) => child.onExit(resolve));
  return { child, messages, invalid, exited };
}

const of = <T extends WorkflowHostMessage['type']>(messages: WorkflowHostMessage[], type: T) => messages.filter((m): m is Extract<WorkflowHostMessage, { type: T }> => m.type === type);

test('a forked Workflow Host runs a 2-step workflow over real Execution Hosts: events → accepted → ended; exits; one session per step', { timeout: 120_000 }, () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const h = forkHost(FORKED);
    h.child.send(runCommand(p, hash));
    const exit = await h.exited;
    assert.equal(exit.code, 0, exit.stderrTail);
    assert.deepEqual(h.invalid, []);
    const [accepted] = of(h.messages, 'accepted');
    assert.ok(accepted);
    const last = h.messages.at(-1);
    assert.equal(last?.type, 'ended');
    assert.deepEqual(last?.type === 'ended' && last.end, { workflowId: accepted.workflowId, state: 'COMPLETED', reason: 'REST', errors: [] });
    const seqs = of(h.messages, 'event').map((m) => m.event.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'every persisted event, once, in order');
    const loaded = await new WorkflowStore(aiBridgeOf(p)).load(accepted.workflowId);
    assert.ok(loaded.ok);
    assert.equal(loaded.handle.lastSeq, seqs.length);
    assert.equal((await readdir(path.join(aiBridgeOf(p), 'sessions'))).length, 2);
    assert.equal(await readWorkflowLockOwner(aiBridgeOf(p)), null);
  }));

test('the process boundary: invalid command → exit 2; refusal → exit 0; a second host process is refused by the lock; malformed controls are never acted on', { timeout: 60_000 }, () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const invalid = forkHost();
    invalid.child.send({ type: 'exec', projectPath: p, command: 'calc.exe' });
    assert.equal((await invalid.exited).code, 2);
    assert.equal(of(invalid.messages, 'rejected')[0]?.error.code, 'INVALID_REQUEST');

    const changed = forkHost();
    changed.child.send(runCommand(p, 'c'.repeat(64)));
    assert.equal((await changed.exited).code, 0);
    assert.equal(of(changed.messages, 'rejected')[0]?.error.code, 'DEFINITION_CHANGED');

    const first = forkHost({ FAKE_WF_BEHAVE: 'stoppable' });
    first.child.send(runCommand(p, hash));
    await until(() => of(first.messages, 'accepted').length === 1, 30_000, 'the first host to accept');
    const workflowId = of(first.messages, 'accepted')[0].workflowId;

    const second = forkHost();
    second.child.send(runCommand(p, hash));
    await second.exited;
    assert.equal(of(second.messages, 'rejected')[0]?.error.code, 'WORKFLOW_LOCKED', 'the workflow lock refuses a second supervisor process');
    const rehost = forkHost();
    rehost.child.send({ type: 'resume', projectPath: p, workflowId });
    await rehost.exited;
    assert.equal(of(rehost.messages, 'rejected')[0]?.error.code, 'WORKFLOW_LOCKED');

    first.child.send({ type: 'control', requestId: 'r1', action: 'resume' });
    first.child.send({ type: 'control', requestId: 'r2', action: 'stop' });
    const exit = await first.exited;
    assert.equal(exit.code, 0, exit.stderrTail);
    const results = of(first.messages, 'control-result');
    assert.equal(results.find((r) => r.requestId === 'r1')?.result.ok, false);
    assert.deepEqual(results.find((r) => r.requestId === 'r2')?.result, { ok: true, state: 'RUNNING' });
    const last = first.messages.at(-1);
    assert.equal(last?.type === 'ended' && last.end.state, 'STOPPED');
  }));

// The Workflow Host crash scenarios (Execution Host survival, WATCH/ADOPT, execution identity, STOP,
// Execution Host death) live in process-lifetime.windows.test.ts (M5.8.1): they assert real Windows
// process lifetime and are isolated there.
