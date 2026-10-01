import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowSubcommand } from '../cli-args.ts';
import { redactSecrets } from '../core/security/redact.ts';
import { dryRunWorkflow } from '../core/workflow/dry-run.ts';
import type { ExecutionPort } from '../core/workflow/execution-port.ts';
import { isValidWorkflowId, type WorkflowEvent, type WorkflowInstanceState } from '../core/workflow/types.ts';
import { createExecutionPort } from './execution-host-spawn.ts';
import { requestWorkflowControl } from './workflow-control-channel.ts';
import { WorkflowHost, type WorkflowHostDeps } from './workflow-host.ts';
import { isDefinitionId, isWorkflowInputValues, type WorkflowControlAction, type WorkflowErrorCode, type WorkflowHostCommand, type WorkflowHostEnd, type WorkflowHostError } from './workflow-host-protocol.ts';
import { formatValidationErrors, getWorkflowSnapshot, listWorkflows, loadWorkflowDefinition, readWorkflowActivity, type WorkflowSnapshot } from './workflow-read.ts';

/**
 * M5.8 — `ai-bridge workflow validate|run|status|pause|resume|stop|list` (docs/39). A thin host:
 * `run`/`resume` (and `stop` of a workflow no live host serves) make THIS process the Workflow
 * Host for as long as the instance is active — the way `ai-bridge start` is the run-lock holder
 * — with every execution in its own Execution Host (src/desktop/main/run-host-entry.ts). A
 * workflow hosted elsewhere (another terminal, the desktop app) is paused/stopped through the
 * control channel. Read commands never take a lock.
 *
 * Output is line-oriented `key: value` on stdout; errors are `ERROR <CODE>: <message>` on
 * stderr (plus indented detail lines), never a stack trace. Exit codes are stable:
 */
export const WORKFLOW_EXIT = {
  OK: 0,
  /** Bad usage, flags, ids, definition or inputs. */
  INVALID: 1,
  /** Refused in the current state: locked, active, a run in the way, not allowed. */
  REFUSED: 2,
  /** No such definition/workflow, or its audit log failed verification. */
  NOT_FOUND: 3,
  /** run/resume/stop ended in a resting state other than the one asked for (e.g. FAILED, PAUSED). */
  NOT_COMPLETED: 4,
  /** The Workflow Host failed, stalled or did not answer. */
  HOST: 5,
} as const;

const EXIT_BY_CODE: Record<WorkflowErrorCode, number> = {
  INVALID_REQUEST: WORKFLOW_EXIT.INVALID,
  DEFINITION_INVALID: WORKFLOW_EXIT.INVALID,
  DEFINITION_CHANGED: WORKFLOW_EXIT.INVALID,
  INPUTS_INVALID: WORKFLOW_EXIT.INVALID,
  DEFINITION_NOT_FOUND: WORKFLOW_EXIT.NOT_FOUND,
  WORKFLOW_NOT_FOUND: WORKFLOW_EXIT.NOT_FOUND,
  WORKFLOW_BROKEN: WORKFLOW_EXIT.NOT_FOUND,
  WORKFLOW_INCOMPLETE: WORKFLOW_EXIT.NOT_FOUND,
  WORKFLOW_LOCKED: WORKFLOW_EXIT.REFUSED,
  WORKFLOW_ACTIVE: WORKFLOW_EXIT.REFUSED,
  RUN_ACTIVE: WORKFLOW_EXIT.REFUSED,
  RUN_UNFINISHED: WORKFLOW_EXIT.REFUSED,
  NOT_ALLOWED: WORKFLOW_EXIT.REFUSED,
  NOT_HOSTED: WORKFLOW_EXIT.REFUSED,
  HOST_UNAVAILABLE: WORKFLOW_EXIT.HOST,
  HOST_FAILED: WORKFLOW_EXIT.HOST,
};

export interface WorkflowCliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface WorkflowCliDeps {
  /** Production: a ForkedExecutionPort over run-host-entry.ts Execution Hosts. */
  createPort?: (projectPath: string) => ExecutionPort;
  engine?: WorkflowHostDeps['engine'];
  controlPollMs?: number;
  /** How long pause/stop wait for a Workflow Host in another process (default 15 s). */
  controlTimeoutMs?: number;
}

const FLAGS: Record<WorkflowSubcommand, readonly string[]> = {
  validate: ['project', 'definition', 'inputs'],
  run: ['project', 'definition', 'inputs'],
  status: ['project', 'workflow'],
  pause: ['project', 'workflow'],
  resume: ['project', 'workflow'],
  stop: ['project', 'workflow'],
  list: ['project'],
};

const RUN_HOST_ENTRY = fileURLToPath(new URL('../desktop/main/run-host-entry.ts', import.meta.url));

function defaultPort(projectPath: string): ExecutionPort {
  return createExecutionPort({ projectPath, scriptPath: RUN_HOST_ENTRY, execPath: process.execPath, env: process.env });
}

const error = (code: WorkflowErrorCode, message: string): WorkflowHostError => ({ code, message });

function printError(io: WorkflowCliIo, e: WorkflowHostError): number {
  io.err(`ERROR ${e.code}: ${redactSecrets(e.message)}`);
  for (const d of e.details ?? []) io.err(`  ${redactSecrets(d)}`);
  return EXIT_BY_CODE[e.code];
}

const orNone = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? 'none' : String(v));

function eventLine(e: WorkflowEvent): string {
  const p = e.payload;
  const move = typeof p.from === 'string' && typeof p.to === 'string' ? ` ${p.from}->${p.to}` : '';
  return `event: ${e.seq} ${e.type}${move}${e.stepId ? ` step=${e.stepId}` : ''}${e.attemptId ? ` attempt=${e.attemptId}` : ''}${e.executionId ? ` execution=${e.executionId}` : ''}`;
}

const journalPath = (workflowId: string) => path.join('.ai-bridge', 'workflows', 'instances', workflowId, 'workflow.md');

function printSnapshot(io: WorkflowCliIo, s: WorkflowSnapshot): void {
  io.out(`workflow: ${s.workflowId}`);
  io.out(`definition: ${s.definitionId} v${s.version} — ${s.title}`);
  io.out(`state: ${s.state}`);
  io.out(`display: ${s.displayState}`);
  io.out(`host: ${s.host.alive ? `alive pid ${s.host.pid ?? 'UNKNOWN'}` : 'none'}`);
  io.out(`integrity: ${s.integrity}`);
  io.out(`terminal-reason: ${orNone(s.terminalReason)}`);
  io.out(`evidence: ${s.evidenceLevel ?? 'UNKNOWN'}`);
  io.out(`pause-requested: ${s.pauseRequested ? 'yes' : 'no'}`);
  io.out(`stop-requested: ${s.stopRequested ?? 'no'}`);
  io.out(`waiting-for: ${s.waitingFor ? `${s.waitingFor.kind} ${s.waitingFor.reason} options=${s.waitingFor.options.join(',') || 'none'}` : 'none'}`);
  s.steps.forEach((st, i) => {
    const c = st.current;
    io.out(`step ${i + 1}: ${st.stepId} ${st.state} attempts=${st.attempts}/${st.maxAttempts} evidence=${st.evidenceLevel ?? 'UNKNOWN'}${c ? ` current=${c.attemptId} ${c.state} execution=${orNone(c.executionId)}` : ''}`);
  });
  for (const b of s.budgets) io.out(`budget ${b.name}: ${b.used}/${b.limit ?? 'unbounded'}${b.incomplete ? ' (incomplete: a segment reported no usage)' : ''}`);
  const c = s.controls;
  const allowed = [c.canStart && 'start', c.canPause && 'pause', c.canResume && 'resume', c.canStop && 'stop', ...c.canAnswer.map((a) => `answer:${a}`)].filter(Boolean);
  io.out(`controls: ${allowed.join(',') || 'none'}`);
  io.out(`journal: ${journalPath(s.workflowId)}`);
}

export async function runWorkflowCommand(sub: WorkflowSubcommand, flags: Record<string, string>, io: WorkflowCliIo, deps: WorkflowCliDeps = {}): Promise<number> {
  try {
    const unknown = Object.keys(flags).filter((f) => !FLAGS[sub].includes(f));
    if (unknown.length > 0) return printError(io, error('INVALID_REQUEST', `unknown flag(s) for "workflow ${sub}": ${unknown.map((f) => `--${f}`).join(', ')} (allowed: ${FLAGS[sub].map((f) => `--${f}`).join(', ')})`));
    const projectPath = path.resolve(flags.project ?? process.cwd());
    const cli = new WorkflowCli(projectPath, io, deps);
    switch (sub) {
      case 'validate':
      case 'run':
        return await cli.validateOrRun(sub, flags.definition, flags.inputs);
      case 'status':
        return await cli.status(flags.workflow);
      case 'list':
        return await cli.list();
      case 'pause':
      case 'stop':
        return await cli.control(sub, flags.workflow);
      case 'resume':
        return await cli.resume(flags.workflow);
    }
  } catch (err) {
    return printError(io, error('HOST_FAILED', err instanceof Error ? err.message : String(err)));
  }
}

class WorkflowCli {
  readonly #projectPath: string;
  readonly #aiBridgeDir: string;
  readonly #io: WorkflowCliIo;
  readonly #deps: WorkflowCliDeps;

  constructor(projectPath: string, io: WorkflowCliIo, deps: WorkflowCliDeps) {
    this.#projectPath = projectPath;
    this.#aiBridgeDir = path.join(projectPath, '.ai-bridge');
    this.#io = io;
    this.#deps = deps;
  }

  async validateOrRun(sub: 'validate' | 'run', definitionId: string | undefined, rawInputs: string | undefined): Promise<number> {
    const io = this.#io;
    if (!isDefinitionId(definitionId)) return printError(io, error('INVALID_REQUEST', `usage: ai-bridge workflow ${sub} --project <path> --definition <definition-id> [--inputs '{"name":"value"}']`));
    let inputs: Record<string, string> = {};
    if (rawInputs !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawInputs);
      } catch {
        parsed = null;
      }
      if (!isWorkflowInputValues(parsed)) return printError(io, error('INVALID_REQUEST', '--inputs must be a JSON object mapping input names to strings'));
      inputs = parsed;
    }
    const def = await loadWorkflowDefinition(this.#aiBridgeDir, definitionId);
    if (!def.ok) return printError(io, def.error);
    const plan = dryRunWorkflow(def.raw, inputs);
    if (!plan.ok) return printError(io, { code: 'INPUTS_INVALID', message: 'the inputs do not match the definition', details: formatValidationErrors(plan.errors) });

    if (sub === 'validate') {
      const b = plan.budgets;
      io.out(`definition: ${plan.definitionId} v${plan.version}`);
      io.out(`title: ${def.definition.title}`);
      io.out(`hash: ${plan.definitionHash}`);
      io.out(`verification: ${plan.verification.mode} (evidence ${plan.verification.evidenceLevel}, ${plan.verification.deterministicChecks} deterministic checks)`);
      io.out(`budgets: executions=${b.maxExecutions} iterations=${b.maxTotalIterations} reported-tokens=${b.maxReportedTokens ?? 'unbounded'} duration-ms=${b.maxDurationMs}`);
      for (const s of plan.steps) io.out(`step ${s.index + 1}: ${s.stepId} max-iterations=${s.maxIterations} planned=${s.plannedMaxIterations}${s.clamped ? ' clamped' : ''}${s.exceedsMaxExecutions ? ' exceeds-max-executions' : ''} outputs=${s.outputs.join(',') || 'none'}`);
      io.out('valid: yes');
      return WORKFLOW_EXIT.OK;
    }
    return this.#host({ type: 'run', projectPath: this.#projectPath, definitionId, definitionHash: def.definitionHash, inputs }, 'COMPLETED');
  }

  async status(workflowId: string | undefined): Promise<number> {
    const io = this.#io;
    let id = workflowId;
    if (id !== undefined && !isValidWorkflowId(id)) return printError(io, error('INVALID_REQUEST', '--workflow must look like wf_YYYY-MM-DD_NNN'));
    if (id === undefined) {
      const activity = await readWorkflowActivity(this.#aiBridgeDir);
      id = activity.host?.workflowId ?? activity.running.at(-1) ?? (await listWorkflows(this.#aiBridgeDir, activity)).at(-1)?.workflowId;
      if (id === undefined) return printError(io, error('WORKFLOW_NOT_FOUND', 'there are no workflows in this project'));
    }
    const snap = await getWorkflowSnapshot(this.#aiBridgeDir, id);
    if (!snap.ok) return printError(io, snap.error);
    printSnapshot(io, snap.value);
    return WORKFLOW_EXIT.OK;
  }

  async list(): Promise<number> {
    for (const w of await listWorkflows(this.#aiBridgeDir)) {
      this.#io.out(`${w.workflowId} ${w.state ?? '-'} ${w.displayState ?? '-'} ${w.definitionId ? `${w.definitionId} v${w.version}` : '-'} ${w.integrity}`);
    }
    return WORKFLOW_EXIT.OK;
  }

  async control(action: WorkflowControlAction, workflowId: string | undefined): Promise<number> {
    const io = this.#io;
    if (!isValidWorkflowId(workflowId)) return printError(io, error('INVALID_REQUEST', `usage: ai-bridge workflow ${action} --project <path> --workflow <wf_YYYY-MM-DD_NNN>`));
    const activity = await readWorkflowActivity(this.#aiBridgeDir);
    if (activity.host?.workflowId === workflowId) {
      const r = await requestWorkflowControl(this.#aiBridgeDir, workflowId, action, { timeoutMs: this.#deps.controlTimeoutMs, pollMs: this.#deps.controlPollMs });
      if (!r.ok) return printError(io, r.error);
      io.out(`workflow: ${workflowId}`);
      io.out(`${action}: requested`);
      io.out(`state: ${r.state}`);
      return WORKFLOW_EXIT.OK;
    }
    if (action === 'pause') {
      const snap = await getWorkflowSnapshot(this.#aiBridgeDir, workflowId, { activity });
      if (!snap.ok) return printError(io, snap.error);
      return printError(io, error('NOT_ALLOWED', `only a workflow running in a Workflow Host can be paused (${workflowId} is ${snap.value.displayState})`));
    }
    // No live host serves it: this process hosts it just long enough to stop it.
    return this.#host({ type: 'stop', projectPath: this.#projectPath, workflowId }, 'STOPPED');
  }

  async resume(workflowId: string | undefined): Promise<number> {
    const io = this.#io;
    if (!isValidWorkflowId(workflowId)) return printError(io, error('INVALID_REQUEST', 'usage: ai-bridge workflow resume --project <path> --workflow <wf_YYYY-MM-DD_NNN>'));
    const activity = await readWorkflowActivity(this.#aiBridgeDir);
    if (activity.host?.workflowId === workflowId) return printError(io, error('WORKFLOW_LOCKED', `${workflowId} is already running in a Workflow Host (pid ${activity.host.pid})`));
    return this.#host({ type: 'resume', projectPath: this.#projectPath, workflowId }, 'COMPLETED');
  }

  /** This process becomes the Workflow Host until the instance rests. */
  async #host(command: WorkflowHostCommand, success: WorkflowInstanceState): Promise<number> {
    const io = this.#io;
    let announced = false;
    const host = new WorkflowHost(
      { projectPath: this.#projectPath, port: (this.#deps.createPort ?? defaultPort)(this.#projectPath), engine: this.#deps.engine, controlPollMs: this.#deps.controlPollMs },
      (event) => {
        if (!announced) {
          announced = true;
          io.out(`workflow: ${event.workflowId}`);
        }
        io.out(eventLine(event));
      },
    );
    const began = await host.begin(command);
    if (!began.ok) return printError(io, began.error);
    if (!announced) io.out(`workflow: ${began.workflowId}`);
    return this.#printEnd(await host.finished(), success);
  }

  async #printEnd(end: WorkflowHostEnd, success: WorkflowInstanceState): Promise<number> {
    const io = this.#io;
    const snap = await getWorkflowSnapshot(this.#aiBridgeDir, end.workflowId);
    io.out(`state: ${end.state}`);
    if (snap.ok) {
      io.out(`terminal-reason: ${orNone(snap.value.terminalReason)}`);
      io.out(`evidence: ${snap.value.evidenceLevel ?? 'UNKNOWN'}`);
      io.out(`waiting-for: ${snap.value.waitingFor ? `${snap.value.waitingFor.kind} ${snap.value.waitingFor.reason}` : 'none'}`);
    }
    io.out(`journal: ${journalPath(end.workflowId)}`);
    if (end.reason === 'STALLED') {
      return printError(io, { code: 'HOST_FAILED', message: `the workflow stopped making progress while RUNNING; resume it to reconcile (ai-bridge workflow resume --workflow ${end.workflowId})`, details: end.errors });
    }
    return end.state === success ? WORKFLOW_EXIT.OK : WORKFLOW_EXIT.NOT_COMPLETED;
  }
}
