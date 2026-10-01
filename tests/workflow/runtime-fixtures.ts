// Shared fixtures for the M5.2/M5.3 runtime tests: validated definitions, a fixed clock and
// a small simulator that feeds inputs through the pure decider and records every decision.
import assert from 'node:assert/strict';
import { validateWorkflowDefinition } from '../../src/core/workflow/validator.ts';
import { createWorkflowInstance, decideWorkflow, type WorkflowDecision } from '../../src/core/workflow/decider.ts';
import type { WorkflowDefinition } from '../../src/core/workflow/definition.ts';
import type { ExecutionResultSummary, WorkflowCommand, WorkflowEvent, WorkflowEventDraft, WorkflowInput, WorkflowInstance } from '../../src/core/workflow/types.ts';
import { step as stepDef, type Mutable } from './definition-fixtures.ts';

export const HASH = 'a'.repeat(64);
export const WF = 'wf_2026-10-01_001';
const T0 = Date.parse('2026-10-01T09:00:00.000Z');
/** Minutes after a fixed start — the decider never reads a clock. */
export const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

export function definition(stepIds: string[] = ['build', 'docs'], extra: Mutable = {}): WorkflowDefinition {
  const raw: Mutable = {
    schema: 1,
    id: 'test-flow',
    version: 1,
    title: 'Test flow',
    inputs: { task: { type: 'string', required: true, maxLength: 100 } },
    steps: stepIds.map((id) => stepDef(id, { executor: { role: 'executor', maxIterations: 10 }, outputs: ['report.summary'] })),
    ...extra,
  };
  const r = validateWorkflowDefinition(raw);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  if (!r.valid) throw new Error('unreachable');
  return r.definition;
}

export function created(def: WorkflowDefinition = definition(), workflowId = WF): { instance: WorkflowInstance; events: WorkflowEventDraft[] } {
  const r = createWorkflowInstance(def, { workflowId, definitionHash: HASH, inputs: { task: 'do it' }, at: at(0) });
  assert.equal(r.ok, true, JSON.stringify(!r.ok && r.errors));
  if (!r.ok) throw new Error('unreachable');
  return r;
}

export const ended = (executionId: string, finalStatus: Extract<ExecutionResultSummary, { kind: 'ENDED' }>['finalStatus'], o: Partial<Extract<ExecutionResultSummary, { kind: 'ENDED' }>> = {}): ExecutionResultSummary => ({
  kind: 'ENDED',
  executionId,
  finalStatus,
  errorCode: null,
  iterations: 1,
  reportedTokens: 100,
  usageLimitDetected: false,
  ...o,
});

/** Feeds inputs through decideWorkflow, asserting each is accepted, and records history. */
export class Sim {
  readonly def: WorkflowDefinition;
  instance: WorkflowInstance;
  readonly events: WorkflowEventDraft[];
  commands: WorkflowCommand[] = [];
  readonly decisions: Extract<WorkflowDecision, { accepted: true }>[] = [];

  constructor(def: WorkflowDefinition = definition()) {
    this.def = def;
    const c = created(def);
    this.instance = c.instance;
    this.events = [...c.events];
  }

  feed(input: WorkflowInput): Extract<WorkflowDecision, { accepted: true }> {
    const d = decideWorkflow(this.def, this.instance, input);
    assert.equal(d.accepted, true, `${input.type} rejected: ${!d.accepted ? d.reason : ''}`);
    if (!d.accepted) throw new Error('unreachable');
    this.instance = d.instance;
    this.events.push(...d.events);
    this.commands = d.commands;
    this.decisions.push(d);
    return d;
  }

  /** Feeds an input that must be rejected; the instance is unchanged. */
  reject(input: WorkflowInput): Extract<WorkflowDecision, { accepted: false }> {
    const d = decideWorkflow(this.def, this.instance, input);
    assert.equal(d.accepted, false, `${input.type} unexpectedly accepted`);
    if (d.accepted) throw new Error('unreachable');
    return d;
  }

  attempt(stepIndex = this.activeIndex(), n = -1) {
    return this.instance.steps[stepIndex].attempts.at(n)!;
  }

  activeIndex(): number {
    const i = this.instance.steps.findIndex((s) => s.state === 'ACTIVE');
    return i === -1 ? this.instance.steps.findLastIndex((s) => s.attempts.length > 0) : i;
  }

  /** START_EXECUTION → linked → ended with `result` for the current attempt. */
  runExecution(result: ExecutionResultSummary, minute: number): void {
    const a = this.attempt();
    const executionId = result.kind === 'ENDED' ? result.executionId : `2026-10-01_${String(minute).padStart(3, '0')}`;
    if (a.state === 'LAUNCHING') this.feed({ type: 'EXECUTION_LINKED', at: at(minute), attemptId: a.attemptId, executionId });
    this.feed({ type: 'EXECUTION_ENDED', at: at(minute), attemptId: a.attemptId, result });
  }

  pass(minute: number): void {
    this.feed({ type: 'VERIFICATION_COMPLETED', at: at(minute), attemptId: this.attempt().attemptId, verdict: 'PASS', evidenceLevel: 'AI_ATTESTED', failureSummary: null });
  }
}

/** Wraps drafts in minimal persisted envelopes (seq/ids) for replay tests without the store. */
export function envelopes(drafts: readonly WorkflowEventDraft[], workflowId = WF): WorkflowEvent[] {
  return drafts.map((d, i) => ({ ...d, schema: 1, eventId: `${workflowId}#${i + 1}`, seq: i + 1, workflowId, correlationId: workflowId, causationId: null, prevHash: null, hash: '' }));
}
