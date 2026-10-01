import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../src/cli-args.ts';
import { WORKFLOW_EXIT, runWorkflowCommand, type WorkflowCliDeps } from '../../src/hosts/workflow-cli.ts';
import { WorkflowHost } from '../../src/hosts/workflow-host.ts';
import type { WorkflowSubcommand } from '../../src/cli-args.ts';
import { FakeExecutionPort } from './fake-execution-port.ts';
import { aiBridgeOf, hostDefinition, hostDeps, needsHumanPort, runCommand, stoppablePort, until, withProject, writeDefinition } from './host-fixtures.ts';

// M5.8: `ai-bridge workflow validate|run|status|pause|resume|stop|list` — line-oriented,
// deterministic output, stable exit codes, no stack traces. Scripted ports; no quota.

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

async function cli(sub: WorkflowSubcommand, flags: Record<string, string>, deps: WorkflowCliDeps = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runWorkflowCommand(sub, flags, { out: (l) => out.push(l), err: (l) => err.push(l) }, { engine: { pollIntervalMs: 5, preflightGraceMs: 0, isPidAlive: () => false }, controlPollMs: 10, ...deps });
  assert.ok(err.every((l) => !/^\s+at /.test(l)), 'never a stack trace');
  return { code, out, err };
}
const value = (lines: string[], key: string) => lines.find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2);
const port = (p: FakeExecutionPort) => ({ createPort: () => p });

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: unknown }).code ?? 1) : 0, stdout, stderr }));
  });
}

test('arguments: `workflow <subcommand>` with flags; unknown or missing subcommands are errors; other commands are unchanged', () => {
  const r = parseArgs(['workflow', 'run', '--project', 'D:\\p', '--definition', 'host-flow', '--inputs', '{"a":"b"}']);
  assert.deepEqual(r, { command: 'workflow', subcommand: 'run', flags: { project: 'D:\\p', definition: 'host-flow', inputs: '{"a":"b"}' }, error: null });
  assert.match(parseArgs(['workflow']).error ?? '', /^Usage: ai-bridge workflow <validate\|run\|status\|pause\|resume\|stop\|list>/);
  assert.match(parseArgs(['workflow', '--project', 'p']).error ?? '', /^Usage: ai-bridge workflow/);
  assert.equal(parseArgs(['workflow', 'exec']).error, 'Unknown workflow command: exec');
  assert.equal(parseArgs(['workflow', 'run', 'extra']).error, 'Unexpected argument: extra');
  assert.deepEqual(parseArgs(['start', '--project', 'p', '--task', 't']), { command: 'start', subcommand: null, flags: { project: 'p', task: 't' }, error: null });
});

test('validate: the dry-run plan (OutcomeOnly, AI_ATTESTED), deterministic; bad definitions/inputs/flags map to stable exit codes', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p, hostDefinition({ inputs: { feature: { type: 'string', required: true, maxLength: 20 } } }));
    const ok = await cli('validate', { project: p, definition: 'host-flow', inputs: '{"feature":"x"}' });
    assert.equal(ok.code, WORKFLOW_EXIT.OK, ok.err.join('\n'));
    assert.equal(value(ok.out, 'hash'), hash);
    assert.equal(value(ok.out, 'verification'), 'OUTCOME_ONLY (evidence AI_ATTESTED, 0 deterministic checks)');
    assert.ok(ok.out.some((l) => l.startsWith('step 1: build max-iterations=3 planned=3')));
    assert.equal(ok.out.at(-1), 'valid: yes');
    assert.deepEqual((await cli('validate', { project: p, definition: 'host-flow', inputs: '{"feature":"x"}' })).out, ok.out, 'same input, same bytes');

    const missingInput = await cli('validate', { project: p, definition: 'host-flow' });
    assert.equal(missingInput.code, WORKFLOW_EXIT.INVALID);
    assert.match(missingInput.err[0], /^ERROR INPUTS_INVALID: /);
    assert.ok(missingInput.err.length > 1 && missingInput.err.slice(1).every((l) => l.startsWith('  ')), 'details indented under the error');
    assert.match((await cli('validate', { project: p, definition: 'host-flow', inputs: 'not json' })).err[0], /^ERROR INVALID_REQUEST: --inputs/);
    assert.equal((await cli('validate', { project: p, definition: 'no-such' })).code, WORKFLOW_EXIT.NOT_FOUND);
    assert.equal((await cli('validate', { project: p })).code, WORKFLOW_EXIT.INVALID);
    const unknownFlag = await cli('validate', { project: p, definition: 'host-flow', task: 'x' });
    assert.equal(unknownFlag.code, WORKFLOW_EXIT.INVALID);
    assert.match(unknownFlag.err[0], /^ERROR INVALID_REQUEST: unknown flag\(s\) for "workflow validate": --task/);

    const dir = path.join(aiBridgeOf(p), 'workflows', 'definitions');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'm6-flow.json'), JSON.stringify({ ...hostDefinition({ id: 'm6-flow' }), steps: [{ ...hostDefinition().steps[0], retry: { maxAttempts: 2 } }] }), 'utf8');
    const invalid = await cli('validate', { project: p, definition: 'm6-flow' });
    assert.equal(invalid.code, WORKFLOW_EXIT.INVALID);
    assert.match(invalid.err[0], /^ERROR DEFINITION_INVALID: /);
  }));

test('run → COMPLETED (exit 0) with one event line per persisted event; list and status report it; the journal exists', () =>
  withProject(async (p) => {
    await writeDefinition(p);
    const run = await cli('run', { project: p, definition: 'host-flow' }, port(new FakeExecutionPort()));
    assert.equal(run.code, WORKFLOW_EXIT.OK, run.err.join('\n'));
    const id = value(run.out, 'workflow')!;
    assert.match(id, /^wf_\d{4}-\d{2}-\d{2}_\d{3}$/);
    const events = run.out.filter((l) => l.startsWith('event: '));
    assert.equal(events[0], 'event: 1 WORKFLOW_CREATED');
    assert.deepEqual(events.map((l) => Number(l.split(' ')[1])), events.map((_, i) => i + 1));
    assert.equal(value(run.out, 'state'), 'COMPLETED');
    assert.equal(value(run.out, 'evidence'), 'AI_ATTESTED');
    assert.ok((await stat(path.join(p, value(run.out, 'journal')!))).isFile());

    assert.deepEqual((await cli('list', { project: p })).out, [`${id} COMPLETED COMPLETED host-flow v1 OK`]);
    const status = await cli('status', { project: p });
    assert.equal(status.code, WORKFLOW_EXIT.OK);
    assert.equal(value(status.out, 'workflow'), id);
    assert.equal(value(status.out, 'display'), 'COMPLETED');
    assert.equal(value(status.out, 'controls'), 'none');
    assert.ok(status.out.includes('step 1: build SUCCEEDED attempts=1/1 evidence=AI_ATTESTED current=' + `${id}/build/1 PASSED execution=2026-10-01_001`));
    assert.equal((await cli('status', { project: p, workflow: '../../state' })).code, WORKFLOW_EXIT.INVALID);
    assert.equal((await cli('status', { project: p, workflow: 'wf_2026-01-01_404' })).code, WORKFLOW_EXIT.NOT_FOUND);
  }));

test('exit codes: a run resting short of COMPLETED is 4; an ordinary run in the way is 2 and creates nothing', () =>
  withProject(async (p) => {
    await writeDefinition(p);
    const human = await cli('run', { project: p, definition: 'host-flow' }, port(needsHumanPort()));
    assert.equal(human.code, WORKFLOW_EXIT.NOT_COMPLETED);
    assert.equal(value(human.out, 'state'), 'WAITING_HUMAN');
    assert.match(value(human.out, 'waiting-for') ?? '', /^HUMAN [A-Z_]+$/);
    const busy = new FakeExecutionPort();
    busy.statusValue = { runId: '2026-10-01_009', status: 'RUNNING', iteration: 1, claudePid: null, codexPid: null };
    const refused = await cli('run', { project: p, definition: 'host-flow' }, port(busy));
    assert.equal(refused.code, WORKFLOW_EXIT.REFUSED);
    assert.match(refused.err[0], /^ERROR RUN_ACTIVE: /);
    assert.equal((await cli('list', { project: p })).out.length, 1, 'the refused run created no instance');
  }));

test('pause / stop reach a Workflow Host in another process through the control channel; resume and stop at rest re-host', () =>
  withProject(async (p) => {
    const hash = await writeDefinition(p);
    const open = async () => {
      const host = new WorkflowHost(hostDeps(p, stoppablePort()));
      const began = await host.begin(runCommand(p, hash));
      assert.ok(began.ok);
      await until(() => host.engine?.instance.steps[0].attempts[0]?.observedIteration === 1, 5000, 'iteration 1');
      return { host, id: began.ok ? began.workflowId : '' };
    };

    const a = await open();
    assert.equal((await cli('resume', { project: p, workflow: a.id })).code, WORKFLOW_EXIT.REFUSED, 'already hosted');
    const pause = await cli('pause', { project: p, workflow: a.id });
    assert.equal(pause.code, WORKFLOW_EXIT.OK, pause.err.join('\n'));
    assert.deepEqual(pause.out, [`workflow: ${a.id}`, 'pause: requested', 'state: RUNNING']);
    assert.equal((await a.host.finished()).state, 'PAUSED');
    const notHosted = await cli('pause', { project: p, workflow: a.id });
    assert.equal(notHosted.code, WORKFLOW_EXIT.REFUSED);
    assert.match(notHosted.err[0], /^ERROR NOT_ALLOWED: only a workflow running in a Workflow Host can be paused/);
    const resumed = await cli('resume', { project: p, workflow: a.id }, port(new FakeExecutionPort()));
    assert.equal(resumed.code, WORKFLOW_EXIT.OK, resumed.err.join('\n'));
    assert.equal(value(resumed.out, 'state'), 'COMPLETED');

    const b = await open();
    const stop = await cli('stop', { project: p, workflow: b.id });
    assert.equal(stop.code, WORKFLOW_EXIT.OK, stop.err.join('\n'));
    assert.equal(value(stop.out, 'stop'), 'requested');
    assert.equal((await b.host.finished()).state, 'STOPPED');

    const c = await open();
    await c.host.control('pause');
    await c.host.finished();
    const stopAtRest = await cli('stop', { project: p, workflow: c.id }, port(new FakeExecutionPort()));
    assert.equal(stopAtRest.code, WORKFLOW_EXIT.OK, stopAtRest.err.join('\n'));
    assert.equal(value(stopAtRest.out, 'state'), 'STOPPED');
    assert.equal((await cli('stop', { project: p, workflow: c.id })).code, WORKFLOW_EXIT.REFUSED, 'already stopped');
  }));

test('the real CLI process: workflow validate / list / bad subcommand / bad id — exit codes and output, no stack trace', { timeout: 120_000 }, () =>
  withProject(async (p) => {
    await writeDefinition(p);
    const validate = await runCli(['workflow', 'validate', '--project', p, '--definition', 'host-flow']);
    assert.equal(validate.code, 0, validate.stderr);
    assert.match(validate.stdout, /^valid: yes$/m);
    const list = await runCli(['workflow', 'list', '--project', p]);
    assert.deepEqual([list.code, list.stdout], [0, '']);
    const bad = await runCli(['workflow', 'exec']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Unknown workflow command: exec/);
    const badId = await runCli(['workflow', 'status', '--project', p, '--workflow', '..\\..\\state']);
    assert.equal(badId.code, 1);
    assert.match(badId.stderr, /^ERROR INVALID_REQUEST: /m);
    assert.doesNotMatch(badId.stderr + bad.stderr, /\n\s+at /);
  }));
