import { MAX_RUN_ITERATIONS } from '../config/config.ts';

/**
 * M5.1 — the declarative workflow definition (docs/36, ADR-013/018/020). A definition is
 * DATA: it is validated (validator.ts), canonicalized and hashed (hash.ts), and never
 * executed or evaluated. It will live at
 * `<project>/.ai-bridge/workflows/definitions/<definitionId>.json` (ADR-018); loading it
 * from disk is not part of M5.1.
 *
 * The types describe exactly the M5 acceptance subset (ADR-020). Fields that are reserved
 * for later milestones can only hold their inert default here — `executor.requires` (M7),
 * `verification.checks`/`requireReviewer`/`acceptMaxIterationsOutcome` (M6),
 * `retry.maxAttempts > 1`/`retryOn` (M6), `context.memory` (M8) — so that a later milestone
 * widens a type instead of discovering a field that was silently ignored. Runtime state
 * (instances, attempts, evidence) is deliberately not modelled in this file.
 */

export const WORKFLOW_DEFINITION_SCHEMA = 1;

/**
 * Hard caps (docs/26 §7, ADR-009). A value beyond a cap is rejected, never clamped.
 * Values not fixed by those documents are marked with their source.
 */
export const WORKFLOW_LIMITS = {
  /** Steps per definition (docs/26 §7 `maxSteps`). */
  maxSteps: 50,
  /** Claude→Codex rounds per execution — the existing per-run ceiling (config.ts). */
  maxIterationsPerExecution: MAX_RUN_ITERATIONS,
  /** Workflow budget caps (docs/26 §7). */
  maxExecutions: 100,
  maxTotalIterations: 1000,
  maxDurationMs: 72 * 60 * 60 * 1000,
  /** M5 accepts exactly one attempt per step (ADR-020); retries are M6. */
  m5MaxAttempts: 1,
  /** Task text per attempt ≤ 256 KB (docs/34 §5); bounds instructions and input values. */
  maxTextBytes: 256 * 1024,
  /** Per-section context cap between steps (docs/21 §6). */
  maxContextChars: 16 * 1024,
  /** M5.1 choice (not fixed by the architecture docs): keeps ids usable as file names
   * (`<definitionId>.json`) and titles displayable. */
  maxIdLength: 64,
  maxTitleLength: 200,
} as const;

/** Lowercase kebab-case: `implement`, `update-docs`, `step-2`. Used for definition ids,
 * step ids and input names. */
export const KEBAB_CASE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The fixed M5 step-output vocabulary (docs/36 §3.4). */
export const WORKFLOW_OUTPUT_NAMES = ['report.summary', 'report.remainingWork', 'report.filesChanged'] as const;
export type WorkflowOutputName = (typeof WORKFLOW_OUTPUT_NAMES)[number];

export function isWorkflowOutputName(value: unknown): value is WorkflowOutputName {
  return typeof value === 'string' && (WORKFLOW_OUTPUT_NAMES as readonly string[]).includes(value);
}

/** Documented input types. M5 supports only `string`. */
export const WORKFLOW_INPUT_TYPES = ['string'] as const;
export type WorkflowInputType = (typeof WORKFLOW_INPUT_TYPES)[number];

/** `$comment` is allowed on any object (docs/36 §3.1): ignored by the engine, hashed. */
interface Commentable {
  readonly $comment?: string;
}

export interface WorkflowInputDefinition extends Commentable {
  readonly type: WorkflowInputType;
  readonly required: boolean;
  /** Maximum length of the supplied value (characters), 1..WORKFLOW_LIMITS.maxTextBytes. */
  readonly maxLength: number;
}

/**
 * Declared inputs keyed by kebab-case name. The only non-definition value the map may
 * hold is a `$comment` string — use `workflowInputEntries()` to iterate the inputs.
 */
export type WorkflowInputs = Readonly<Record<string, WorkflowInputDefinition | string>>;

export interface WorkflowBudgets extends Commentable {
  readonly maxDurationMs?: number;
  readonly maxTotalIterations?: number;
  readonly maxExecutions?: number;
  /** Advisory guard on CLI-reported token usage (docs/26 §7); no hard cap is defined. */
  readonly maxReportedTokens?: number;
}

export interface WorkflowExecutorDefinition extends Commentable {
  /** A step is always executed by the existing executor role (Claude via BridgeEngine). */
  readonly role: 'executor';
  /** 1..WORKFLOW_LIMITS.maxIterationsPerExecution — passed to BridgeEngine.start(). */
  readonly maxIterations: number;
  /** Capability requirements — reserved for M7; must be empty in M5. */
  readonly requires?: readonly [];
}

export interface WorkflowVerificationDefinition extends Commentable {
  /** Deterministic checks — reserved for M6; must be empty in M5. */
  readonly checks: readonly [];
  /** M5 verification is OutcomeOnly: every step result is AI_ATTESTED. */
  readonly acceptAiOnly: true;
  /** Step-level Reviewer — reserved for M6. */
  readonly requireReviewer?: false;
  /** Accepting STOPPED_MAX_ITERATIONS needs deterministic verification — reserved for M6. */
  readonly acceptMaxIterationsOutcome?: false;
}

export interface WorkflowRetryDefinition extends Commentable {
  /** M5 runs each step exactly once; retries are reserved for M6. */
  readonly maxAttempts: 1;
  readonly retryOn?: readonly [];
}

/** A declared output of an earlier step that this step receives as context. */
export interface WorkflowOutputReference extends Commentable {
  readonly step: string;
  readonly output: WorkflowOutputName;
  /** 1..WORKFLOW_LIMITS.maxContextChars. */
  readonly maxChars: number;
}

export interface WorkflowContextDefinition extends Commentable {
  readonly fromSteps?: readonly WorkflowOutputReference[];
  /** Project/long-term memory — reserved for M8; must be empty in M5. */
  readonly memory?: readonly [];
}

export interface WorkflowStepDefinition extends Commentable {
  readonly id: string;
  readonly title: string;
  /** May contain only `{{inputs.<name>}}` and `{{steps.<id>.outputs.<name>}}` placeholders. */
  readonly instruction: string;
  readonly executor: WorkflowExecutorDefinition;
  readonly outputs?: readonly WorkflowOutputName[];
  readonly verification: WorkflowVerificationDefinition;
  readonly retry: WorkflowRetryDefinition;
  readonly context?: WorkflowContextDefinition;
}

export interface WorkflowDefinition extends Commentable {
  readonly schema: typeof WORKFLOW_DEFINITION_SCHEMA;
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly inputs?: WorkflowInputs;
  readonly budgets?: WorkflowBudgets;
  readonly steps: readonly WorkflowStepDefinition[];
}

/** The declared inputs of a validated definition, in declaration order, `$comment` excluded. */
export function workflowInputEntries(definition: WorkflowDefinition): [string, WorkflowInputDefinition][] {
  return Object.entries(definition.inputs ?? {}).filter((e): e is [string, WorkflowInputDefinition] => e[0] !== '$comment' && typeof e[1] === 'object');
}
