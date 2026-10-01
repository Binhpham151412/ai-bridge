import { effectiveBudgets, type EffectiveBudgets } from './budgets.ts';
import { createWorkflowInstance } from './decider.ts';
import { validateAndHashWorkflowDefinition } from './hash.ts';
import { outputKey, renderTask } from './step-planner.ts';
import type { WorkflowValidationError } from './validator.ts';

/**
 * M5.5 — dry run (docs/36 §3.6, docs/39 M5.5): validates the definition and the inputs, and
 * returns the plan a real run would follow — steps in order, their attempt ids, iteration
 * limits under the workflow budgets (worst case: every earlier step uses its full
 * maxIterations), the verification mode, and each step's task text. Pure: no execution
 * host, no Claude/Codex, no filesystem, no quota. Outputs of earlier steps exist only at run
 * time, so the preview shows where they will be inserted.
 */

export const DRY_RUN_WORKFLOW_ID = 'wf_0000-00-00_000';

export interface DryRunStep {
  index: number;
  stepId: string;
  title: string;
  /** The attempt id a real run would use (with its own workflowId). */
  attemptId: string;
  maxAttempts: 1;
  maxIterations: number;
  /** maxIterations after the worst-case iteration-budget clamp; 0 = the budget runs out first. */
  plannedMaxIterations: number;
  clamped: boolean;
  /** This step would exceed maxExecutions. */
  exceedsMaxExecutions: boolean;
  outputs: string[];
  contextFrom: string[];
  taskPreview: string;
}

export type DryRunResult =
  | {
      ok: true;
      definitionId: string;
      version: number;
      definitionHash: string;
      budgets: EffectiveBudgets;
      verification: { mode: 'OUTCOME_ONLY'; evidenceLevel: 'AI_ATTESTED'; deterministicChecks: 0 };
      steps: DryRunStep[];
      expectedTransitions: { instance: string[]; step: string[]; attempt: string[] };
    }
  | { ok: false; errors: WorkflowValidationError[] };

export function dryRunWorkflow(rawDefinition: unknown, inputs: unknown): DryRunResult {
  const v = validateAndHashWorkflowDefinition(rawDefinition);
  if (!v.valid) return { ok: false, errors: v.errors };
  const definition = v.definition;
  const created = createWorkflowInstance(definition, { workflowId: DRY_RUN_WORKFLOW_ID, definitionHash: v.definitionHash, inputs, at: '1970-01-01T00:00:00.000Z' });
  if (!created.ok) return { ok: false, errors: created.errors };

  const budgets = effectiveBudgets(definition);
  const placeholders = new Map<string, string>();
  for (const s of definition.steps) for (const o of s.outputs ?? []) placeholders.set(outputKey(s.id, o), `(the "${o}" output of step "${s.id}", inserted at run time)`);

  let usedIterations = 0;
  const steps = definition.steps.map((s, index): DryRunStep => {
    const remaining = Math.max(0, budgets.maxTotalIterations - usedIterations);
    const planned = Math.min(s.executor.maxIterations, remaining);
    usedIterations += planned;
    return {
      index,
      stepId: s.id,
      title: s.title,
      attemptId: `<workflowId>/${s.id}/1`,
      maxAttempts: 1,
      maxIterations: s.executor.maxIterations,
      plannedMaxIterations: planned,
      clamped: planned < s.executor.maxIterations,
      exceedsMaxExecutions: index + 1 > budgets.maxExecutions,
      outputs: [...(s.outputs ?? [])],
      contextFrom: (s.context?.fromSteps ?? []).map((r) => outputKey(r.step, r.output)),
      taskPreview: renderTask(definition, created.instance.inputs, s.id, placeholders).task,
    };
  });

  return {
    ok: true,
    definitionId: definition.id,
    version: definition.version,
    definitionHash: v.definitionHash,
    budgets,
    verification: { mode: 'OUTCOME_ONLY', evidenceLevel: 'AI_ATTESTED', deterministicChecks: 0 },
    steps,
    expectedTransitions: {
      instance: ['CREATED', 'RUNNING', 'COMPLETED'],
      step: ['PENDING', 'ACTIVE', 'SUCCEEDED'],
      attempt: ['PLANNED', 'LAUNCHING', 'EXECUTING', 'EXECUTION_ENDED', 'VERIFYING', 'PASSED'],
    },
  };
}
