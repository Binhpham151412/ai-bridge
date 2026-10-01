import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import type { WorkflowDefinition } from './definition.ts';
import { readEventLog } from './event-log.ts';
import { WorkflowStore } from './store.ts';
import type { EvidenceLevel, WorkflowAttempt, WorkflowEvent, WorkflowInstance } from './types.ts';

/**
 * M5.7 — the workflow journal (docs/27 §3.5): `workflows/instances/<workflowId>/workflow.md`,
 * a human-readable view DERIVED from the verified event log (chronology) and the persisted
 * snapshot (current state). It is never read back: not for state, recovery or decisions.
 *
 * Rules (as for the M4.2 run journal): nothing is inferred — unavailable data is UNKNOWN;
 * events are shown in persisted `seq` order, every one of them (types M5 does not produce are
 * rendered generically, never dropped); output depends only on persisted data, so identical
 * inputs give identical bytes; generation is write-if-changed. AI_ATTESTED is always labelled
 * as AI attestation, never as VERIFIED. Execution details are LINKED, not copied.
 */

export interface ExecutionArtifactLinks {
  /** Present M4.2 run-journal files of the execution, relative to workflow.md. */
  sessionIndex: string | null;
  finalReport: string | null;
}

export interface WorkflowJournalInput {
  definition: WorkflowDefinition;
  /** The persisted snapshot (as verified by the store against the log). */
  instance: WorkflowInstance;
  /** The verified event chain (rendered by seq). */
  events: readonly WorkflowEvent[];
  /** Keyed by executionId (runId). */
  executions: ReadonlyMap<string, ExecutionArtifactLinks>;
  /** Attempts whose `attempts/<stepId>-<n>/task.md` exists, by attemptId. */
  taskFiles: ReadonlySet<string>;
  /** The store reported a pending repair (read-only view). */
  repairPending: boolean;
}

const UNKNOWN = 'UNKNOWN';
const orUnknown = (v: string | number | null | undefined): string => (v === null || v === undefined || v === '' ? UNKNOWN : String(v));
const str = (v: unknown): string => (v === null || v === undefined ? UNKNOWN : typeof v === 'string' ? v : canonicalJson(v));

function cell(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ↵ ');
}

export function evidenceLabel(level: EvidenceLevel | null | undefined): string {
  switch (level) {
    case 'AI_ATTESTED':
      return 'AI_ATTESTED (OutcomeOnly: the execution claimed DONE; not deterministically checked)';
    case 'VERIFIED':
      return 'VERIFIED (deterministic checks passed)';
    case 'NONE':
      return 'NONE';
    default:
      return UNKNOWN;
  }
}

function parseInput(e: WorkflowEvent): Record<string, unknown> | null {
  try {
    const v = JSON.parse(String(e.payload.input));
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A short, factual description of one event, from its own payload only. */
export function describeEvent(e: WorkflowEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'WORKFLOW_CREATED': {
      let names = UNKNOWN;
      try {
        names = Object.keys(JSON.parse(String(p.inputs))).join(', ') || '(none)';
      } catch {
        // stays UNKNOWN
      }
      return `definition ${str(p.definitionId)} v${str(p.definitionVersion)}; inputs: ${names}`;
    }
    case 'INPUT_RECEIVED': {
      const input = parseInput(e);
      if (!input) return `input ${str(p.inputType)} (unreadable)`;
      switch (String(input.type)) {
        case 'EXECUTION_ENDED': {
          const r = (input.result ?? {}) as Record<string, unknown>;
          if (r.kind === 'ENDED') return `input EXECUTION_ENDED: ENDED ${str(r.finalStatus)}, error ${str(r.errorCode)}, iterations ${str(r.iterations)}, reported tokens ${str(r.reportedTokens)}`;
          return `input EXECUTION_ENDED: ${str(r.kind)}${r.reason !== undefined ? ` (${str(r.reason)})` : ''}${r.executionId !== undefined ? `, execution ${str(r.executionId)}` : ''}`;
        }
        case 'EXECUTION_LINKED':
          return `input EXECUTION_LINKED: execution ${str(input.executionId)}`;
        case 'EXECUTION_HOST_SPAWNED':
          return `input EXECUTION_HOST_SPAWNED: host pid ${str(input.hostPid)}`;
        case 'EXECUTION_PROGRESS':
          return `input EXECUTION_PROGRESS: iteration ${str(input.iteration)}`;
        case 'VERIFICATION_COMPLETED':
          return `input VERIFICATION_COMPLETED: ${str(input.verdict)}, ${str(input.evidenceLevel)}`;
        case 'STOP_REQUESTED':
          return `input STOP_REQUESTED: cause ${str(input.cause)}`;
        case 'HUMAN_ANSWER':
          return `input HUMAN_ANSWER: ${str(input.answer)}`;
        case 'RECONCILED': {
          const f = (input.finding ?? {}) as Record<string, unknown>;
          return `input RECONCILED: ${str(f.kind)}${f.executionId !== undefined ? ` ${str(f.executionId)}` : ''}${f.reason !== undefined ? ` (${str(f.reason)})` : ''}`;
        }
        default:
          return `input ${String(input.type)}`;
      }
    }
    case 'WORKFLOW_STATE_CHANGED':
    case 'STEP_STATE_CHANGED':
    case 'ATTEMPT_STATE_CHANGED': {
      const extra = Object.entries(p)
        .filter(([k]) => k !== 'from' && k !== 'to')
        .map(([k, v]) => `${k} ${str(v)}`);
      return `${str(p.from)} → ${str(p.to)}${extra.length ? ` (${extra.join(', ')})` : ''}`;
    }
    case 'ATTEMPT_PLANNED':
      return `attempt ${str(p.attemptNo)} planned, maxIterations ${str(p.maxIterations)}${p.maxIterationsClamped === true ? ' (clamped by the iteration budget)' : ''}`;
    case 'ATTEMPT_LAUNCHING':
      return `launch ${str(p.launch)} requested (write-ahead intent), maxIterations ${str(p.maxIterations)}`;
    case 'EXECUTION_LINKED':
      return `linked to execution ${orUnknown(e.executionId)}`;
    case 'EXECUTION_ENDED':
      return `${str(p.finalStatus)}, error ${str(p.errorCode)}, iterations ${str(p.iterations)}, class ${str(p.class)}`;
    case 'VERIFICATION_STARTED':
      return 'OutcomeOnly verification requested';
    case 'VERIFICATION_COMPLETED':
      return `${str(p.verdict)} — ${evidenceLabel(p.evidenceLevel as EvidenceLevel)}`;
    case 'BUDGET_EXHAUSTED':
      return `budget exhausted: ${str(p.reason)}`;
    case 'HUMAN_INPUT_REQUESTED':
      return `a human decision is needed: ${str(p.reason)}; options ${Array.isArray(p.options) ? p.options.join(', ') : UNKNOWN}`;
    case 'HUMAN_INPUT_RECEIVED':
      return `human answered: ${str(p.answer)}`;
    case 'PAUSE_REQUESTED':
      return 'pause requested';
    case 'STOP_REQUESTED':
      return `stop requested (cause ${str(p.cause)})`;
    case 'RECONCILED':
      if (Array.isArray(p.repairs)) return `store repair: ${p.repairs.join('; ') || UNKNOWN}`;
      return `reconciliation finding ${str(p.finding)}${p.executionId !== undefined ? ` for execution ${str(p.executionId)}` : ''}${p.reason !== undefined ? ` (${str(p.reason)})` : ''}`;
    case 'WORKFLOW_COMPLETED':
      return `completed — ${evidenceLabel(p.evidenceLevel as EvidenceLevel)}`;
    default:
      // Declared in docs/27 but not produced by M5 (CHECK_COMPLETED, REVIEW_COMPLETED,
      // RETRY_DECIDED, BUDGET_CHECKED) — shown as-is, never dropped.
      return `event not produced by M5; payload ${canonicalJson(p)}`;
  }
}

function attemptLines(att: WorkflowAttempt, input: WorkflowJournalInput): string[] {
  const links = att.executionId ? (input.executions.get(att.executionId) ?? { sessionIndex: null, finalReport: null }) : null;
  const o = att.lastOutcome;
  const v = att.verification;
  const tokens = att.tokensIncomplete ? `${UNKNOWN} (a segment reported no usage; ${att.reportedTokens} reported by the others)` : String(att.reportedTokens);
  const task = `attempts/${att.stepId}-${att.attemptNo}/task.md`;
  return [
    `- Attempt \`${att.attemptId}\` — **${att.state}**`,
    `  - Execution (runId): ${att.executionId ? `\`${att.executionId}\`` : UNKNOWN}`,
    `  - Correlation sent with the execution: \`${att.attemptId}\` (the attemptId, ADR-017)`,
    `  - Launches: ${att.launches}; host pid: ${orUnknown(att.hostPid)}; maxIterations: ${att.maxIterations}${att.maxIterationsClamped ? ' (clamped by the iteration budget)' : ''}`,
    `  - Iterations used: ${att.iterationsUsed}; reported tokens: ${tokens}`,
    `  - Outcome: ${o ? `${o.kind} ${orUnknown(o.finalStatus)}, error ${orUnknown(o.errorCode)}, class ${o.class}` : UNKNOWN}`,
    `  - Verification: ${v ? `${v.verdict} — ${evidenceLabel(v.evidenceLevel)}${v.failureSummary ? `; ${v.failureSummary}` : ''}` : UNKNOWN}`,
    `  - Stop cause: ${orUnknown(att.stopCause)}`,
    `  - Task sent: ${input.taskFiles.has(att.attemptId) ? `[${task}](${task})` : UNKNOWN}`,
    `  - Execution journal: ${links === null ? UNKNOWN : links.sessionIndex ? `[session.md](${links.sessionIndex})` : `${UNKNOWN} (no session.md for \`${att.executionId}\`)`}${links?.finalReport ? ` · [final-report.md](${links.finalReport})` : ''}`,
  ];
}

/** Pure: workflow.md text for already-verified persisted data. */
export function renderWorkflowJournal(input: WorkflowJournalInput): string {
  const { definition: def, instance: inst } = input;
  const events = [...input.events].sort((a, b) => a.seq - b.seq);
  const last = events.at(-1);
  const out: string[] = [`# Workflow Journal — ${inst.workflowId}`, ''];
  out.push('> Derived from the workflow event log (`events.jsonl`) and snapshot (`instance.json`). This file', '> is a generated view, not a source of truth — it is never read for state, recovery or decisions.', '');

  out.push('## Summary', '', '| Field | Value |', '|---|---|');
  const rows: [string, string][] = [
    ['Workflow', inst.workflowId],
    ['Definition', `${def.id} v${def.version} — ${def.title}`],
    ['Definition hash', inst.definitionHash],
    ['State', inst.state],
    ['Terminal reason', orUnknown(inst.terminalReason)],
    ['Evidence level', evidenceLabel(inst.evidenceLevel)],
    ['Created', inst.createdAt],
    ['Started', orUnknown(inst.startedAt)],
    ['Ended', orUnknown(inst.endedAt)],
    ['Pause requested', inst.pauseRequested ? 'yes' : 'no'],
    ['Stop requested', inst.stopRequested ? `yes (${inst.stopRequested})` : 'no'],
    ['Waiting for', inst.waitingFor ? `${inst.waitingFor.kind}: ${inst.waitingFor.reason}; options ${inst.waitingFor.options.join(', ')}` : 'nothing'],
    ['Verification mode', 'OutcomeOnly (M5) — no deterministic checks run'],
    ['Event log', `${events.length} events, seq 1–${last?.seq ?? 0}, hash chain intact on read; last hash ${last ? last.hash : UNKNOWN}${input.repairPending ? ' — REPAIR PENDING (torn tail or snapshot behind; shown from the intact part of the log)' : ''}`],
  ];
  for (const [k, v] of rows) out.push(`| ${cell(k)} | ${cell(v)} |`);
  out.push('', '## Steps', '');
  inst.steps.forEach((s, i) => {
    const d = def.steps.find((x) => x.id === s.stepId);
    out.push(`### ${i + 1}. \`${s.stepId}\` — ${d?.title ?? UNKNOWN} (${s.state})`, '', `- Evidence: ${evidenceLabel(s.evidenceLevel)}`);
    if (s.attempts.length === 0) out.push('- Attempts: none');
    for (const att of s.attempts) out.push(...attemptLines(att, input));
    out.push('');
  });

  const recovery = events.filter((e) => {
    if (e.type === 'RECONCILED' || e.type === 'HUMAN_INPUT_REQUESTED' || e.type === 'HUMAN_INPUT_RECEIVED') return true;
    if (e.type !== 'INPUT_RECEIVED') return false;
    const input = parseInput(e);
    const kind = (input?.result as Record<string, unknown> | undefined)?.kind;
    return input?.type === 'RECONCILED' || kind === 'HOST_FAILED' || kind === 'RESUME_REFUSED';
  });
  out.push('## Recovery and decisions', '');
  if (recovery.length === 0) out.push('- none recorded');
  for (const e of recovery) out.push(`- seq ${e.seq} (${e.timestamp}) ${e.type}: ${describeEvent(e)}`);
  out.push('', '_Outcomes adopted, and executions linked, by reconciliation after a restart are recorded as ordinary', 'EXECUTION_ENDED / EXECUTION_LINKED inputs; the log does not mark them as reconciled._', '');

  out.push('## Timeline', '', '| Seq | Time | Event | Step | Attempt | Execution | Actor | Details |', '|---:|---|---|---|---|---|---|---|');
  for (const e of events) {
    out.push(`| ${e.seq} | ${cell(e.timestamp)} | ${cell(e.type)} | ${cell(orUnknown(e.stepId))} | ${cell(orUnknown(e.attemptId))} | ${cell(orUnknown(e.executionId))} | ${cell(e.actor)} | ${cell(describeEvent(e))} |`);
  }
  out.push('');
  return out.join('\n');
}

export type WorkflowJournalResult =
  | { ok: true; path: string; markdown: string; written: boolean; repairPending: boolean }
  | { ok: false; code: 'INVALID_ID' | 'NOT_FOUND' | 'INCOMPLETE' | 'BROKEN'; reason: string; path: string | null };

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  if ((await readFile(file, 'utf8').catch(() => null)) === content) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
  return true;
}

/**
 * Generates `workflow.md` from the verified log. Loads WITHOUT repair — a journal never writes
 * the log, snapshot or attempts. A BROKEN log gets no journal: workflow.md is replaced by a
 * short notice, so a stale journal cannot pass for current. Nothing is repaired.
 */
export async function writeWorkflowJournal(aiBridgeDir: string, workflowId: string, deps: { store?: WorkflowStore } = {}): Promise<WorkflowJournalResult> {
  const store = deps.store ?? new WorkflowStore(aiBridgeDir);
  const loaded = await store.load(workflowId, { repair: false });
  if (!loaded.ok) {
    if (loaded.code !== 'BROKEN') return { ok: false, code: loaded.code, reason: loaded.reason, path: null };
    const file = path.join(store.paths(workflowId).dir, 'workflow.md');
    await writeIfChanged(file, `# Workflow Journal — ${workflowId}\n\n**INTEGRITY BROKEN** — ${loaded.reason}.\n\nNo journal is rendered: the event log cannot be trusted. Nothing was repaired.\n`);
    return { ok: false, code: 'BROKEN', reason: loaded.reason, path: file };
  }
  const { handle } = loaded;
  const log = await readEventLog(handle.paths.events, workflowId);
  if (!log.ok) return { ok: false, code: 'BROKEN', reason: log.reason, path: null };

  const executions = new Map<string, ExecutionArtifactLinks>();
  const taskFiles = new Set<string>();
  for (const att of handle.instance.steps.flatMap((s) => s.attempts)) {
    if (await exists(path.join(handle.paths.attempts, `${att.stepId}-${att.attemptNo}`, 'task.md'))) taskFiles.add(att.attemptId);
    if (!att.executionId || executions.has(att.executionId)) continue;
    const sessionDir = path.join(aiBridgeDir, 'sessions', att.executionId);
    const rel = `../../../sessions/${att.executionId}`;
    executions.set(att.executionId, {
      sessionIndex: (await exists(path.join(sessionDir, 'session.md'))) ? `${rel}/session.md` : null,
      finalReport: (await exists(path.join(sessionDir, 'final-report.md'))) ? `${rel}/final-report.md` : null,
    });
  }
  // Only complete, verified lines are rendered; a torn tail stays excluded (repair is the lock holder's job).
  const markdown = renderWorkflowJournal({ definition: handle.definition, instance: handle.instance, events: log.events, executions, taskFiles, repairPending: loaded.needsRepair });
  const file = path.join(handle.paths.dir, 'workflow.md');
  return { ok: true, path: file, markdown, written: await writeIfChanged(file, markdown), repairPending: loaded.needsRepair };
}
