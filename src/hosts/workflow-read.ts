import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BridgeRecoveryCheck, BridgeStatus } from '../core/bridge-engine.ts';
import { effectiveBudgets, workflowUsage } from '../core/workflow/budgets.ts';
import { deriveWorkflowControls, deriveWorkflowDisplayState, type WorkflowControls, type WorkflowDisplayState } from '../core/workflow/controls.ts';
import { WORKFLOW_LIMITS, workflowInputEntries, type WorkflowDefinition } from '../core/workflow/definition.ts';
import { dryRunWorkflow } from '../core/workflow/dry-run.ts';
import { readEventLog } from '../core/workflow/event-log.ts';
import { validateAndHashWorkflowDefinition } from '../core/workflow/hash.ts';
import { writeWorkflowJournal } from '../core/workflow/journal.ts';
import { WorkflowStore, type LoadResult } from '../core/workflow/store.ts';
import { isValidWorkflowId, type EvidenceLevel, type WorkflowAttempt, type WorkflowEvent, type WorkflowEventType, type WorkflowInstance, type WorkflowInstanceState, type WorkflowStepRuntime } from '../core/workflow/types.ts';
import type { WorkflowValidationError } from '../core/workflow/validator.ts';
import { readHostedWorkflow, type HostedWorkflow } from './workflow-control-channel.ts';
import { isDefinitionId, type WorkflowErrorCode, type WorkflowHostError } from './workflow-host-protocol.ts';

/**
 * M5.8 — the read side of workflows for hosts (Electron Main, the CLI). Everything here reads
 * what the WorkflowEngine persisted: never with repair, never under the workflow lock, never
 * writing state (the only file written is the derived `workflow.md`, rebuilt on demand —
 * docs/34 §4). Availability (`controls`) is Core's `deriveWorkflowControls`; the host/UI never
 * computes it.
 */

export type { WorkflowControls, WorkflowDisplayState, WorkflowEvent, WorkflowAttempt, HostedWorkflow };

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: WorkflowHostError };

const fail = (code: WorkflowErrorCode, message: string, details?: string[]): { ok: false; error: WorkflowHostError } => ({ ok: false, error: details?.length ? { code, message, details } : { code, message } });

export const definitionsDir = (aiBridgeDir: string) => path.join(aiBridgeDir, 'workflows', 'definitions');
/** A definition file larger than this is refused before it is parsed. */
export const MAX_DEFINITION_FILE_BYTES = 4 * 1024 * 1024;

export function formatValidationErrors(errors: readonly WorkflowValidationError[]): string[] {
  return errors.map((e) => `${e.path} ${e.code}: ${e.message}`);
}

/** Maps a store load failure to the shared error categories. */
export function loadFailure(result: Extract<LoadResult, { ok: false }>): { ok: false; error: WorkflowHostError } {
  switch (result.code) {
    case 'INVALID_ID':
      return fail('INVALID_REQUEST', result.reason);
    case 'NOT_FOUND':
      return fail('WORKFLOW_NOT_FOUND', result.reason);
    case 'INCOMPLETE':
      return fail('WORKFLOW_INCOMPLETE', result.reason);
    case 'BROKEN':
      return fail('WORKFLOW_BROKEN', `the workflow's audit log failed verification: ${result.reason}`);
  }
}

// ---------------------------------------------------------------------------
// definitions (ADR-018: <project>/.ai-bridge/workflows/definitions/<definitionId>.json)
// ---------------------------------------------------------------------------

export type LoadedDefinition = { ok: true; raw: unknown; definition: WorkflowDefinition; definitionHash: string } | { ok: false; error: WorkflowHostError };

export async function loadWorkflowDefinition(aiBridgeDir: string, definitionId: string): Promise<LoadedDefinition> {
  if (!isDefinitionId(definitionId)) return fail('INVALID_REQUEST', 'definitionId must be a kebab-case id of at most 64 characters');
  const file = path.join(definitionsDir(aiBridgeDir), `${definitionId}.json`);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return fail('DEFINITION_NOT_FOUND', `no workflow definition ${definitionId} (.ai-bridge/workflows/definitions/${definitionId}.json)`);
  }
  if (size > MAX_DEFINITION_FILE_BYTES) return fail('DEFINITION_INVALID', `the definition file is larger than ${MAX_DEFINITION_FILE_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    return fail('DEFINITION_INVALID', 'the definition file is not valid JSON', [err instanceof Error ? err.message : String(err)]);
  }
  const v = validateAndHashWorkflowDefinition(raw);
  if (!v.valid) return fail('DEFINITION_INVALID', `workflow definition ${definitionId} is invalid`, formatValidationErrors(v.errors));
  if (v.definition.id !== definitionId) return fail('DEFINITION_INVALID', `the file ${definitionId}.json declares id "${v.definition.id}" — the file name must be the definition id`);
  return { ok: true, raw, definition: v.definition, definitionHash: v.definitionHash };
}

export interface WorkflowDefinitionSummary {
  /** From the file name. */
  definitionId: string;
  valid: boolean;
  definitionHash: string | null;
  version: number | null;
  title: string | null;
  steps: { stepId: string; title: string }[];
  inputs: { name: string; required: boolean; maxLength: number }[];
  errors: string[];
}

export async function listWorkflowDefinitions(aiBridgeDir: string): Promise<WorkflowDefinitionSummary[]> {
  const names = (await readdir(definitionsDir(aiBridgeDir)).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
  const out: WorkflowDefinitionSummary[] = [];
  for (const name of names) {
    const definitionId = name.slice(0, -'.json'.length);
    if (!isDefinitionId(definitionId)) continue;
    const loaded = await loadWorkflowDefinition(aiBridgeDir, definitionId);
    if (!loaded.ok) {
      out.push({ definitionId, valid: false, definitionHash: null, version: null, title: null, steps: [], inputs: [], errors: [loaded.error.message, ...(loaded.error.details ?? [])] });
      continue;
    }
    const d = loaded.definition;
    out.push({
      definitionId,
      valid: true,
      definitionHash: loaded.definitionHash,
      version: d.version,
      title: d.title,
      steps: d.steps.map((s) => ({ stepId: s.id, title: s.title })),
      inputs: workflowInputEntries(d).map(([name, input]) => ({ name, required: input.required, maxLength: input.maxLength })),
      errors: [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// activity — the Core-derived mutual-exclusion facts (docs/35 §3.1)
// ---------------------------------------------------------------------------

export interface WorkflowActivity {
  /** The live Workflow Host (workflow-lock holder), if any. */
  host: HostedWorkflow | null;
  /** Instances persisted as RUNNING: the hosted one, or ones whose host died (INTERRUPTED). */
  running: string[];
  /** A workflow owns the project's execution resources: ordinary runs must not start or resume. */
  active: boolean;
}

/** Cheap enough to poll: the lock, the host record, and each instance's snapshot state. The
 * snapshot is a checked cache (store.ts); used here only to *restrict* controls, never to permit. */
export async function readWorkflowActivity(aiBridgeDir: string): Promise<WorkflowActivity> {
  const host = await readHostedWorkflow(aiBridgeDir);
  const store = new WorkflowStore(aiBridgeDir);
  const running: string[] = [];
  for (const id of await store.list()) {
    try {
      const snap = JSON.parse(await readFile(store.paths(id).snapshot, 'utf8')) as { instance?: { state?: unknown } };
      if (snap.instance?.state === 'RUNNING') running.push(id);
    } catch {
      // no snapshot yet (creation in progress) or unreadable: the lock covers a live host
    }
  }
  return { host, running, active: host !== null || running.length > 0 };
}

const hostServes = (activity: WorkflowActivity, instance: WorkflowInstance): boolean =>
  activity.host !== null && (activity.host.workflowId === instance.workflowId || (activity.host.workflowId === null && instance.state === 'RUNNING'));

/** Whether a NEW workflow may start now. Shared by the Workflow Host's own precheck and by
 * Main, so both refuse for the same reason. The run lock stays the final guard (a run that
 * starts in between makes the first attempt NOT_STARTED → BLOCKED, docs/22). */
export async function checkWorkflowStartAvailability(
  aiBridgeDir: string,
  run: { status: BridgeStatus; recovery: BridgeRecoveryCheck } | null,
  knownActivity?: WorkflowActivity,
): Promise<{ ok: true } | { ok: false; error: WorkflowHostError }> {
  const activity = knownActivity ?? (await readWorkflowActivity(aiBridgeDir));
  if (activity.host) return fail('WORKFLOW_LOCKED', `a Workflow Host (pid ${activity.host.pid}) is already running${activity.host.workflowId ? ` ${activity.host.workflowId}` : ''} in this project`);
  if (activity.running.length > 0) return fail('WORKFLOW_ACTIVE', `workflow ${activity.running[0]} is RUNNING without a host (interrupted) — resume or stop it first`);
  if (run) {
    if (run.status.status === 'RUNNING') return fail('RUN_ACTIVE', `a run (${run.status.runId ?? 'UNKNOWN'}) is running in this project`);
    if (run.status.status === 'PAUSED') return fail('RUN_UNFINISHED', `run ${run.status.runId ?? 'UNKNOWN'} is PAUSED — resume or discard it first`);
    if (run.status.status === 'INTERRUPTED' && run.recovery.kind === 'RECOVERABLE') return fail('RUN_UNFINISHED', `run ${run.status.runId ?? 'UNKNOWN'} was interrupted and can be resumed — resume or discard it first`);
  }
  return { ok: true };
}

/** Main's check of a start request (docs/35 §3.3: inputs are validated against the definition's
 * declared inputs in Main before anything is forwarded). The Workflow Host re-checks all of it. */
export async function validateWorkflowStart(aiBridgeDir: string, definitionId: string, definitionHash: string, inputs: Record<string, string>): Promise<ReadResult<{ definitionHash: string }>> {
  const def = await loadWorkflowDefinition(aiBridgeDir, definitionId);
  if (!def.ok) return def;
  if (def.definitionHash !== definitionHash) return fail('DEFINITION_CHANGED', `workflow definition ${definitionId} changed since it was listed — reload the definitions`);
  const plan = dryRunWorkflow(def.raw, inputs);
  if (!plan.ok) return fail('INPUTS_INVALID', 'the inputs do not match the definition', formatValidationErrors(plan.errors));
  return { ok: true, value: { definitionHash } };
}

// ---------------------------------------------------------------------------
// instances
// ---------------------------------------------------------------------------

/** Instance ids, oldest first (directory names only — nothing is loaded). */
export function listWorkflowIds(aiBridgeDir: string): Promise<string[]> {
  return new WorkflowStore(aiBridgeDir).list();
}

/** M5.9: the step a UI highlights — the ACTIVE step, else the last step that ran (null before any ran). */
function currentStepOf(instance: WorkflowInstance): WorkflowStepRuntime | null {
  return instance.steps.find((s) => s.state === 'ACTIVE') ?? [...instance.steps].reverse().find((s) => s.attempts.length > 0) ?? null;
}

export interface WorkflowListItem {
  workflowId: string;
  integrity: 'OK' | 'REPAIR_PENDING' | 'BROKEN' | 'INCOMPLETE';
  /** null when the instance cannot be trusted (BROKEN/INCOMPLETE) — nothing unverified is shown. */
  definitionId: string | null;
  version: number | null;
  state: WorkflowInstanceState | null;
  displayState: WorkflowDisplayState | null;
  terminalReason: string | null;
  evidenceLevel: EvidenceLevel | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** M5.9 (additive): the current step and its latest attempt; null when none (or untrusted). */
  currentStep: { stepId: string; state: string } | null;
  currentAttempt: { attemptId: string; state: string; executionId: string | null } | null;
}

export async function listWorkflows(aiBridgeDir: string, activity?: WorkflowActivity): Promise<WorkflowListItem[]> {
  const act = activity ?? (await readWorkflowActivity(aiBridgeDir));
  const store = new WorkflowStore(aiBridgeDir);
  const out: WorkflowListItem[] = [];
  for (const workflowId of await store.list()) {
    const loaded = await store.load(workflowId, { repair: false });
    if (!loaded.ok) {
      const integrity = loaded.code === 'INCOMPLETE' ? 'INCOMPLETE' : 'BROKEN';
      out.push({ workflowId, integrity, definitionId: null, version: null, state: null, displayState: null, terminalReason: null, evidenceLevel: null, createdAt: null, updatedAt: null, currentStep: null, currentAttempt: null });
      continue;
    }
    const inst = loaded.handle.instance;
    const step = currentStepOf(inst);
    const attempt = step?.attempts.at(-1) ?? null;
    out.push({
      workflowId,
      integrity: loaded.needsRepair ? 'REPAIR_PENDING' : 'OK',
      definitionId: inst.definitionId,
      version: inst.definitionVersion,
      state: inst.state,
      displayState: deriveWorkflowDisplayState(inst, hostServes(act, inst)),
      terminalReason: inst.terminalReason,
      evidenceLevel: inst.evidenceLevel,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
      currentStep: step ? { stepId: step.stepId, state: step.state } : null,
      currentAttempt: attempt ? { attemptId: attempt.attemptId, state: attempt.state, executionId: attempt.executionId } : null,
    });
  }
  return out;
}

export interface WorkflowStepView {
  stepId: string;
  title: string;
  state: string;
  evidenceLevel: EvidenceLevel | null;
  attempts: number;
  maxAttempts: number;
  /** The step's latest attempt. */
  current: {
    attemptId: string;
    state: string;
    executionId: string | null;
    iterationsUsed: number;
    maxIterations: number;
    /** M5.9 (additive): the execution outcome recorded for the attempt (null until it ended). */
    outcome: { kind: string; finalStatus: string | null; errorCode: string | null; class: string } | null;
  } | null;
  lastVerification: { verdict: string; evidenceLevel: EvidenceLevel } | null;
}

/** M5.9: a recovery decision or repair, straight from a persisted event (M5.6 / M5.3) — never inferred.
 * ADOPT and LINK are not persisted as findings (they are ordinary EXECUTION_ENDED / EXECUTION_LINKED
 * inputs, the M5.7 open item), so they never appear here. */
export interface WorkflowRecoveryEntry {
  seq: number;
  timestamp: string;
  type: WorkflowEventType;
  /** FINDING (RECONCILED: NOT_STARTED | WATCH | RESUME | UNRESOLVABLE), STORE_REPAIR (RECONCILED by the
   * store), or an execution-host failure the engine received (HOST_FAILED | RESUME_REFUSED). */
  kind: 'FINDING' | 'STORE_REPAIR' | 'HOST_FAILED' | 'RESUME_REFUSED';
  finding: string | null;
  attemptId: string | null;
  executionId: string | null;
  reason: string | null;
}

export function recoveryEntries(events: readonly WorkflowEvent[]): WorkflowRecoveryEntry[] {
  const out: WorkflowRecoveryEntry[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  for (const e of events) {
    const base = { seq: e.seq, timestamp: e.timestamp, type: e.type, attemptId: e.attemptId, executionId: e.executionId };
    if (e.type === 'RECONCILED') {
      if (Array.isArray(e.payload.repairs)) out.push({ ...base, kind: 'STORE_REPAIR', finding: null, reason: e.payload.repairs.join('; ') });
      else out.push({ ...base, kind: 'FINDING', finding: str(e.payload.finding), executionId: str(e.payload.executionId) ?? e.executionId, reason: str(e.payload.reason) });
      continue;
    }
    if (e.type !== 'INPUT_RECEIVED' || e.payload.inputType !== 'EXECUTION_ENDED') continue;
    let result: { kind?: unknown; executionId?: unknown; reason?: unknown } | undefined;
    try {
      result = (JSON.parse(String(e.payload.input)) as { result?: typeof result }).result;
    } catch {
      result = undefined;
    }
    if (result?.kind === 'HOST_FAILED' || result?.kind === 'RESUME_REFUSED') out.push({ ...base, kind: result.kind, finding: null, executionId: str(result.executionId) ?? e.executionId, reason: str(result.reason) });
  }
  return out;
}

/** One instance as a UI may show it (docs/35 §3.2). Plain data; no input values (only names). */
export interface WorkflowSnapshot {
  workflowId: string;
  definitionId: string;
  version: number;
  title: string;
  definitionHash: string;
  state: WorkflowInstanceState;
  /** INTERRUPTED = persisted RUNNING while no live Workflow Host serves it (docs/22 §4). */
  displayState: WorkflowDisplayState;
  terminalReason: string | null;
  /** M5: AI_ATTESTED at best — never VERIFIED (ADR-020). */
  evidenceLevel: EvidenceLevel | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  pauseRequested: boolean;
  stopRequested: string | null;
  integrity: 'OK' | 'REPAIR_PENDING';
  host: { alive: boolean; pid: number | null };
  inputNames: string[];
  steps: WorkflowStepView[];
  /** M5.9 (additive): the step to highlight (see currentStepOf). */
  currentStepId: string | null;
  /** M5.9 (additive): M5 verification is OutcomeOnly (ADR-020) — the execution's own DONE claim, AI_ATTESTED at best. */
  verification: { mode: 'OUTCOME_ONLY'; deterministicChecks: number };
  /** M5.9 (additive): recovery decisions/repairs from the verified event log, in seq order. */
  recovery: WorkflowRecoveryEntry[];
  budgets: { name: 'executions' | 'iterations' | 'reportedTokens'; used: number; limit: number | null; incomplete: boolean }[];
  deadlineAt: string | null;
  waitingFor: { kind: string; reason: string; attemptId: string | null; options: string[] } | null;
  /** Derived in Core (deriveWorkflowControls); the renderer never decides availability. */
  controls: WorkflowControls;
  lastEventSeq: number;
  /** BridgeEngine's status of the current attempt's execution, when it is the project's current run. */
  execution: BridgeStatus | null;
}

export function buildWorkflowSnapshot(
  definition: WorkflowDefinition,
  instance: WorkflowInstance,
  o: { lastEventSeq: number; needsRepair: boolean; activity: WorkflowActivity; execution: BridgeStatus | null; recovery?: WorkflowRecoveryEntry[] },
): WorkflowSnapshot {
  const hostAlive = hostServes(o.activity, instance);
  const budgets = effectiveBudgets(definition);
  const usage = workflowUsage(instance);
  const latest = instance.steps.flatMap((s) => s.attempts).at(-1) ?? null;
  const currentRun = latest?.executionId ?? null;
  return {
    workflowId: instance.workflowId,
    definitionId: instance.definitionId,
    version: instance.definitionVersion,
    title: definition.title,
    definitionHash: instance.definitionHash,
    state: instance.state,
    displayState: deriveWorkflowDisplayState(instance, hostAlive),
    terminalReason: instance.terminalReason,
    evidenceLevel: instance.evidenceLevel,
    createdAt: instance.createdAt,
    startedAt: instance.startedAt,
    endedAt: instance.endedAt,
    updatedAt: instance.updatedAt,
    pauseRequested: instance.pauseRequested,
    stopRequested: instance.stopRequested,
    integrity: o.needsRepair ? 'REPAIR_PENDING' : 'OK',
    host: { alive: hostAlive, pid: hostAlive ? (o.activity.host?.pid ?? null) : null },
    inputNames: Object.keys(instance.inputs).sort(),
    steps: instance.steps.map((s): WorkflowStepView => {
      const def = definition.steps.find((d) => d.id === s.stepId);
      const last = s.attempts.at(-1) ?? null;
      const verified = [...s.attempts].reverse().find((a) => a.verification !== null)?.verification ?? null;
      return {
        stepId: s.stepId,
        title: def?.title ?? s.stepId,
        state: s.state,
        evidenceLevel: s.evidenceLevel,
        attempts: s.attempts.length,
        maxAttempts: def?.retry.maxAttempts ?? 1,
        current: last
          ? {
              attemptId: last.attemptId,
              state: last.state,
              executionId: last.executionId,
              iterationsUsed: last.iterationsUsed,
              maxIterations: last.maxIterations,
              outcome: last.lastOutcome ? { kind: last.lastOutcome.kind, finalStatus: last.lastOutcome.finalStatus, errorCode: last.lastOutcome.errorCode, class: last.lastOutcome.class } : null,
            }
          : null,
        lastVerification: verified ? { verdict: verified.verdict, evidenceLevel: verified.evidenceLevel } : null,
      };
    }),
    currentStepId: currentStepOf(instance)?.stepId ?? null,
    verification: { mode: 'OUTCOME_ONLY', deterministicChecks: definition.steps.reduce((n, s) => n + s.verification.checks.length, 0) },
    recovery: o.recovery ?? [],
    budgets: [
      { name: 'executions', used: usage.executions, limit: budgets.maxExecutions, incomplete: false },
      { name: 'iterations', used: usage.iterations, limit: budgets.maxTotalIterations, incomplete: false },
      { name: 'reportedTokens', used: usage.reportedTokens, limit: budgets.maxReportedTokens, incomplete: usage.tokensIncomplete },
    ],
    deadlineAt: instance.startedAt ? new Date(Date.parse(instance.startedAt) + budgets.maxDurationMs).toISOString() : null,
    waitingFor: instance.waitingFor ? { kind: instance.waitingFor.kind, reason: instance.waitingFor.reason, attemptId: instance.waitingFor.attemptId, options: [...instance.waitingFor.options] } : null,
    controls: deriveWorkflowControls(instance, { hostAlive }),
    lastEventSeq: o.lastEventSeq,
    execution: o.execution && currentRun !== null && o.execution.runId === currentRun ? o.execution : null,
  };
}

export async function getWorkflowSnapshot(aiBridgeDir: string, workflowId: string, o: { activity?: WorkflowActivity; execution?: BridgeStatus | null } = {}): Promise<ReadResult<WorkflowSnapshot>> {
  const loaded = await new WorkflowStore(aiBridgeDir).load(workflowId, { repair: false });
  if (!loaded.ok) return loadFailure(loaded);
  const activity = o.activity ?? (await readWorkflowActivity(aiBridgeDir));
  const h = loaded.handle;
  const log = await readEventLog(h.paths.events, workflowId);
  const recovery = log.ok ? recoveryEntries(log.events.filter((e) => e.seq <= h.lastSeq)) : [];
  return { ok: true, value: buildWorkflowSnapshot(h.definition, h.instance, { lastEventSeq: h.lastSeq, needsRepair: loaded.needsRepair, activity, execution: o.execution ?? null, recovery }) };
}

export const MAX_EVENTS_PER_READ = 1000;

/** Events after `afterSeq`, in seq order, from the verified log (a broken chain returns nothing). */
export async function getWorkflowEvents(aiBridgeDir: string, workflowId: string, afterSeq: number, limit: number): Promise<ReadResult<WorkflowEvent[]>> {
  if (!isValidWorkflowId(workflowId)) return fail('INVALID_REQUEST', `not a workflow id: ${JSON.stringify(workflowId)}`);
  const store = new WorkflowStore(aiBridgeDir);
  if ((await store.list()).indexOf(workflowId) === -1) return fail('WORKFLOW_NOT_FOUND', `no workflow ${workflowId}`);
  const log = await readEventLog(store.paths(workflowId).events, workflowId);
  if (!log.ok) return fail('WORKFLOW_BROKEN', `the workflow's audit log failed verification: ${log.reason}`);
  return { ok: true, value: log.events.filter((e) => e.seq > afterSeq).slice(0, Math.min(limit, MAX_EVENTS_PER_READ)) };
}

export const ATTEMPT_ID_PATTERN = /^(wf_\d{4}-\d{2}-\d{2}_\d{3})\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([1-9]\d{0,2})$/;

export interface WorkflowAttemptView {
  workflowId: string;
  attempt: WorkflowAttempt;
  /** The exact task text sent (attempts/<step>-<n>/task.md); null when none was written. */
  task: string | null;
}

export async function getWorkflowAttempt(aiBridgeDir: string, attemptId: string): Promise<ReadResult<WorkflowAttemptView>> {
  const m = ATTEMPT_ID_PATTERN.exec(attemptId);
  if (!m) return fail('INVALID_REQUEST', `not an attempt id: ${JSON.stringify(attemptId)}`);
  const store = new WorkflowStore(aiBridgeDir);
  const loaded = await store.load(m[1], { repair: false });
  if (!loaded.ok) return loadFailure(loaded);
  const attempt = loaded.handle.instance.steps.flatMap((s) => s.attempts).find((a) => a.attemptId === attemptId);
  if (!attempt) return fail('WORKFLOW_NOT_FOUND', `no attempt ${attemptId}`);
  const taskFile = path.join(loaded.handle.paths.attempts, `${attempt.stepId}-${attempt.attemptNo}`, 'task.md');
  let task: string | null = null;
  try {
    if ((await stat(taskFile)).size <= WORKFLOW_LIMITS.maxTextBytes * 2) task = await readFile(taskFile, 'utf8');
  } catch {
    task = null;
  }
  return { ok: true, value: { workflowId: m[1], attempt, task } };
}

/** `workflow.md` for one instance, rebuilt on demand from the verified log (M5.7, derived). */
export async function getWorkflowJournal(aiBridgeDir: string, workflowId: string): Promise<ReadResult<{ workflowId: string; markdown: string }>> {
  const r = await writeWorkflowJournal(aiBridgeDir, workflowId);
  if (!r.ok) {
    if (r.code === 'BROKEN') return fail('WORKFLOW_BROKEN', `the workflow's audit log failed verification: ${r.reason}`);
    return loadFailure({ ok: false, code: r.code, reason: r.reason });
  }
  return { ok: true, value: { workflowId, markdown: r.markdown } };
}
