import {
  KEBAB_CASE_ID,
  WORKFLOW_DEFINITION_SCHEMA,
  WORKFLOW_INPUT_TYPES,
  WORKFLOW_LIMITS,
  WORKFLOW_OUTPUT_NAMES,
  isWorkflowOutputName,
  type WorkflowDefinition,
} from './definition.ts';

/**
 * M5.1 strict workflow-definition validator (docs/36 §3.5, ADR-020). Same philosophy as
 * `validateConfig` (core/config/config.ts): known fields only, every problem reported,
 * nothing coerced, stripped, clamped or migrated. Pure — no I/O, no clock, never throws for
 * invalid input. Errors come out in a fixed traversal order (known fields in schema order,
 * unknown fields sorted), so the same definition always yields the same error list
 * regardless of its key order.
 *
 * Reserved features of later milestones are rejected with code RESERVED_FEATURE and the
 * milestone that owns them — never ignored.
 */

export type WorkflowValidationErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'INVALID_VALUE'
  | 'OUT_OF_RANGE'
  | 'INVALID_ID'
  | 'DUPLICATE_STEP_ID'
  | 'RESERVED_FEATURE'
  | 'UNSUPPORTED_PLACEHOLDER'
  | 'MALFORMED_PLACEHOLDER'
  | 'UNKNOWN_INPUT_REFERENCE'
  | 'UNKNOWN_STEP_REFERENCE'
  | 'FORWARD_STEP_REFERENCE'
  | 'UNKNOWN_OUTPUT_NAME'
  | 'UNDECLARED_OUTPUT_REFERENCE';

/** The milestone that owns a reserved feature (ADR-020). */
export type ReservedMilestone = 'M6' | 'M7' | 'M8';

export interface WorkflowValidationError {
  /** e.g. `$`, `$.steps[1].executor.maxIterations`, `$.inputs.feature`. */
  path: string;
  code: WorkflowValidationErrorCode;
  message: string;
  /** Set only for RESERVED_FEATURE. */
  milestone?: ReservedMilestone;
}

export type WorkflowValidationResult =
  | { valid: true; definition: WorkflowDefinition; errors: [] }
  | { valid: false; definition: null; errors: WorkflowValidationError[] };

const COMMENT = '$comment';

type Json = Record<string, unknown>;

class Errors {
  readonly list: WorkflowValidationError[] = [];
  add(path: string, code: WorkflowValidationErrorCode, message: string, milestone?: ReservedMilestone): void {
    this.list.push(milestone ? { path, code, message, milestone } : { path, code, message });
  }
  reserved(path: string, milestone: ReservedMilestone, message: string): void {
    this.add(path, 'RESERVED_FEATURE', `${message} (reserved for ${milestone}; not available in M5)`, milestone);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `${typeof value} ${JSON.stringify(value) ?? String(value)}`;
}

function isPlainObject(value: unknown): value is Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Checks `value` is a plain object, reports unknown fields (sorted) and a non-string
 * `$comment`. Returns the object, or null when it is not one. */
function objectWithFields(value: unknown, path: string, known: readonly string[], e: Errors): Json | null {
  if (!isPlainObject(value)) {
    e.add(path, 'INVALID_TYPE', `must be an object, got ${describe(value)}`);
    return null;
  }
  const unknown = Object.keys(value)
    .filter((k) => k !== COMMENT && !known.includes(k))
    .sort();
  for (const key of unknown) e.add(`${path}.${key}`, 'UNKNOWN_FIELD', `unknown field "${key}" (allowed: ${[...known, COMMENT].join(', ')})`);
  checkComment(value, path, e);
  return value;
}

function checkComment(obj: Json, path: string, e: Errors): void {
  if (COMMENT in obj && typeof obj[COMMENT] !== 'string') e.add(`${path}.${COMMENT}`, 'INVALID_TYPE', `must be a string, got ${describe(obj[COMMENT])}`);
}

function required(obj: Json, key: string, path: string, e: Errors): unknown {
  if (!(key in obj)) {
    e.add(`${path}.${key}`, 'MISSING_FIELD', `required field "${key}" is missing`);
    return undefined;
  }
  return obj[key];
}

function checkId(value: unknown, path: string, e: Errors, what: string): value is string {
  if (typeof value !== 'string') {
    e.add(path, 'INVALID_TYPE', `${what} must be a string, got ${describe(value)}`);
    return false;
  }
  if (value.length > WORKFLOW_LIMITS.maxIdLength || !KEBAB_CASE_ID.test(value)) {
    e.add(path, 'INVALID_ID', `${what} must be lowercase kebab-case (e.g. "update-docs"), at most ${WORKFLOW_LIMITS.maxIdLength} characters, got ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

function checkText(value: unknown, path: string, e: Errors, maxChars: number | null, maxBytes: number | null): void {
  if (typeof value !== 'string') {
    e.add(path, 'INVALID_TYPE', `must be a string, got ${describe(value)}`);
    return;
  }
  if (value.trim() === '') e.add(path, 'INVALID_VALUE', 'must not be empty');
  else if (maxChars !== null && value.length > maxChars) e.add(path, 'OUT_OF_RANGE', `must be at most ${maxChars} characters, got ${value.length}`);
  else if (maxBytes !== null && utf8Bytes(value) > maxBytes) e.add(path, 'OUT_OF_RANGE', `must be at most ${maxBytes} bytes (UTF-8), got ${utf8Bytes(value)}`);
}

/** Positive integer within [1, max]; `max === null` means no documented cap. */
function checkBoundedInteger(value: unknown, path: string, e: Errors, max: number | null, capNote: string): void {
  if (!isPositiveInteger(value)) {
    e.add(path, typeof value === 'number' ? 'OUT_OF_RANGE' : 'INVALID_TYPE', `must be a positive integer, got ${describe(value)}`);
    return;
  }
  if (max !== null && value > max) e.add(path, 'OUT_OF_RANGE', `must be at most ${max} (${capNote}; values beyond a hard cap are rejected, never clamped), got ${value}`);
}

/** An optional field that must be an empty array in M5. */
function checkReservedEmptyArray(obj: Json, key: string, path: string, e: Errors, milestone: ReservedMilestone, feature: string): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (!Array.isArray(value)) {
    e.add(`${path}.${key}`, 'INVALID_TYPE', `must be an array, got ${describe(value)}`);
    return;
  }
  if (value.length > 0) e.reserved(`${path}.${key}`, milestone, `${feature}; in M5 "${key}" must be []`);
}

// ---------------------------------------------------------------------------
// top level
// ---------------------------------------------------------------------------

const TOP_FIELDS = ['schema', 'id', 'version', 'title', 'inputs', 'budgets', 'steps'] as const;

export function validateWorkflowDefinition(input: unknown): WorkflowValidationResult {
  const e = new Errors();
  const root = objectWithFields(input, '$', TOP_FIELDS, e);
  if (root) validateRoot(root, e);
  if (e.list.length > 0) return { valid: false, definition: null, errors: e.list };
  // The accepted definition is detached from the caller's object and frozen: a definition
  // is immutable once validated (docs/36 §4), so later mutation of `input` cannot change it.
  return { valid: true, definition: deepFreeze(structuredClone(input)) as WorkflowDefinition, errors: [] };
}

/** Parses JSON text first (JSON only — docs/36 §3.1), then validates. */
export function validateWorkflowDefinitionJson(text: string): WorkflowValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { valid: false, definition: null, errors: [{ path: '$', code: 'INVALID_JSON', message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  return validateWorkflowDefinition(parsed);
}

function validateRoot(root: Json, e: Errors): void {
  const schema = required(root, 'schema', '$', e);
  if (schema !== undefined && schema !== WORKFLOW_DEFINITION_SCHEMA) {
    e.add('$.schema', typeof schema === 'number' ? 'INVALID_VALUE' : 'INVALID_TYPE', `unsupported workflow definition schema ${describe(schema)} (supported: ${WORKFLOW_DEFINITION_SCHEMA})`);
  }
  const id = required(root, 'id', '$', e);
  if (id !== undefined) checkId(id, '$.id', e, 'definition id');
  const version = required(root, 'version', '$', e);
  if (version !== undefined) checkBoundedInteger(version, '$.version', e, null, '');
  const title = required(root, 'title', '$', e);
  if (title !== undefined) checkText(title, '$.title', e, WORKFLOW_LIMITS.maxTitleLength, null);

  const inputNames = 'inputs' in root ? validateInputs(root.inputs, e) : new Set<string>();
  if ('budgets' in root) validateBudgets(root.budgets, e);

  const steps = required(root, 'steps', '$', e);
  if (steps !== undefined) validateSteps(steps, inputNames, e);
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

const INPUT_FIELDS = ['type', 'required', 'maxLength'] as const;

/** Returns the declared input names (valid kebab-case names only). */
function validateInputs(value: unknown, e: Errors): Set<string> {
  const names = new Set<string>();
  if (!isPlainObject(value)) {
    e.add('$.inputs', 'INVALID_TYPE', `must be an object mapping input names to input definitions, got ${describe(value)}`);
    return names;
  }
  checkComment(value, '$.inputs', e);
  for (const [name, def] of Object.entries(value)) {
    if (name === COMMENT) continue;
    const path = `$.inputs.${name}`;
    if (checkId(name, path, e, 'input name')) names.add(name);
    const obj = objectWithFields(def, path, INPUT_FIELDS, e);
    if (!obj) continue;
    const type = required(obj, 'type', path, e);
    if (type !== undefined && !(WORKFLOW_INPUT_TYPES as readonly unknown[]).includes(type)) {
      e.add(`${path}.type`, typeof type === 'string' ? 'INVALID_VALUE' : 'INVALID_TYPE', `unsupported input type ${describe(type)} (supported: ${WORKFLOW_INPUT_TYPES.join(', ')})`);
    }
    const req = required(obj, 'required', path, e);
    if (req !== undefined && typeof req !== 'boolean') e.add(`${path}.required`, 'INVALID_TYPE', `must be a boolean, got ${describe(req)}`);
    const maxLength = required(obj, 'maxLength', path, e);
    if (maxLength !== undefined) checkBoundedInteger(maxLength, `${path}.maxLength`, e, WORKFLOW_LIMITS.maxTextBytes, 'task text limit, docs/34 §5');
  }
  return names;
}

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

const BUDGET_CAPS: readonly [field: string, cap: number | null, note: string][] = [
  ['maxDurationMs', WORKFLOW_LIMITS.maxDurationMs, 'workflow duration hard cap of 72 h, docs/26 §7'],
  ['maxTotalIterations', WORKFLOW_LIMITS.maxTotalIterations, 'total-iterations hard cap, docs/26 §7'],
  ['maxExecutions', WORKFLOW_LIMITS.maxExecutions, 'executions hard cap, docs/26 §7'],
  ['maxReportedTokens', null, ''],
];

function validateBudgets(value: unknown, e: Errors): void {
  const obj = objectWithFields(
    value,
    '$.budgets',
    BUDGET_CAPS.map(([f]) => f),
    e,
  );
  if (!obj) return;
  for (const [field, cap, note] of BUDGET_CAPS) {
    if (field in obj) checkBoundedInteger(obj[field], `$.budgets.${field}`, e, cap, note);
  }
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

const STEP_FIELDS = ['id', 'title', 'instruction', 'executor', 'outputs', 'verification', 'retry', 'context'] as const;

interface StepIndex {
  /** Every step id that appears anywhere (for forward-reference detection). */
  all: Set<string>;
  /** Step id → declared outputs, for steps before the one being validated. */
  earlier: Map<string, Set<string>>;
}

function validateSteps(value: unknown, inputNames: Set<string>, e: Errors): void {
  if (!Array.isArray(value)) {
    e.add('$.steps', 'INVALID_TYPE', `must be an array of steps, got ${describe(value)}`);
    return;
  }
  if (value.length < 1 || value.length > WORKFLOW_LIMITS.maxSteps) {
    e.add('$.steps', 'OUT_OF_RANGE', `must contain 1 to ${WORKFLOW_LIMITS.maxSteps} steps (hard cap, docs/26 §7), got ${value.length}`);
    if (value.length === 0) return;
  }
  const all = new Set<string>();
  for (const step of value) if (isPlainObject(step) && typeof step.id === 'string') all.add(step.id);
  const index: StepIndex = { all, earlier: new Map() };
  const seen = new Set<string>();

  for (let i = 0; i < value.length; i++) {
    const path = `$.steps[${i}]`;
    const step = objectWithFields(value[i], path, STEP_FIELDS, e);
    if (!step) continue;

    const id = required(step, 'id', path, e);
    let stepId: string | null = null;
    if (id !== undefined && checkId(id, `${path}.id`, e, 'step id')) {
      if (seen.has(id)) e.add(`${path}.id`, 'DUPLICATE_STEP_ID', `step id "${id}" is already used by an earlier step`);
      else stepId = id;
      seen.add(id);
    }
    const title = required(step, 'title', path, e);
    if (title !== undefined) checkText(title, `${path}.title`, e, WORKFLOW_LIMITS.maxTitleLength, null);

    const executor = required(step, 'executor', path, e);
    if (executor !== undefined) validateExecutor(executor, `${path}.executor`, e);
    const outputs = 'outputs' in step ? validateOutputs(step.outputs, `${path}.outputs`, e) : new Set<string>();
    const verification = required(step, 'verification', path, e);
    if (verification !== undefined) validateVerification(verification, `${path}.verification`, e);
    const retry = required(step, 'retry', path, e);
    if (retry !== undefined) validateRetry(retry, `${path}.retry`, e);
    if ('context' in step) validateContext(step.context, `${path}.context`, index, stepId, e);

    const instruction = required(step, 'instruction', path, e);
    if (instruction !== undefined) {
      checkText(instruction, `${path}.instruction`, e, null, WORKFLOW_LIMITS.maxTextBytes);
      if (typeof instruction === 'string') validatePlaceholders(instruction, `${path}.instruction`, inputNames, index, stepId, e);
    }

    // Only now does this step become "earlier" for the steps after it.
    if (stepId !== null) index.earlier.set(stepId, outputs);
  }
}

const EXECUTOR_FIELDS = ['role', 'maxIterations', 'requires'] as const;

function validateExecutor(value: unknown, path: string, e: Errors): void {
  const obj = objectWithFields(value, path, EXECUTOR_FIELDS, e);
  if (!obj) return;
  const role = required(obj, 'role', path, e);
  if (role !== undefined && role !== 'executor') {
    e.add(`${path}.role`, typeof role === 'string' ? 'INVALID_VALUE' : 'INVALID_TYPE', `must be "executor" (a step is executed by the existing executor role through BridgeEngine), got ${describe(role)}`);
  }
  const maxIterations = required(obj, 'maxIterations', path, e);
  if (maxIterations !== undefined) checkBoundedInteger(maxIterations, `${path}.maxIterations`, e, WORKFLOW_LIMITS.maxIterationsPerExecution, 'per-execution iteration ceiling');
  checkReservedEmptyArray(obj, 'requires', path, e, 'M7', 'capability requirements belong to the Capability Registry');
}

function validateOutputs(value: unknown, path: string, e: Errors): Set<string> {
  const declared = new Set<string>();
  if (!Array.isArray(value)) {
    e.add(path, 'INVALID_TYPE', `must be an array of output names, got ${describe(value)}`);
    return declared;
  }
  value.forEach((name, i) => {
    if (!isWorkflowOutputName(name)) {
      e.add(`${path}[${i}]`, typeof name === 'string' ? 'UNKNOWN_OUTPUT_NAME' : 'INVALID_TYPE', `unknown output ${describe(name)} (M5 outputs: ${WORKFLOW_OUTPUT_NAMES.join(', ')})`);
    } else if (declared.has(name)) {
      e.add(`${path}[${i}]`, 'INVALID_VALUE', `output "${name}" is declared more than once`);
    } else {
      declared.add(name);
    }
  });
  return declared;
}

const VERIFICATION_FIELDS = ['checks', 'acceptAiOnly', 'requireReviewer', 'acceptMaxIterationsOutcome'] as const;

function validateVerification(value: unknown, path: string, e: Errors): void {
  const obj = objectWithFields(value, path, VERIFICATION_FIELDS, e);
  if (!obj) return;
  const checks = required(obj, 'checks', path, e);
  if (checks !== undefined) {
    if (!Array.isArray(checks)) e.add(`${path}.checks`, 'INVALID_TYPE', `must be an array, got ${describe(checks)}`);
    else if (checks.length > 0) e.reserved(`${path}.checks`, 'M6', 'deterministic verification checks belong to M6; M5 verification is OutcomeOnly (AI_ATTESTED), so "checks" must be []');
  }
  const acceptAiOnly = required(obj, 'acceptAiOnly', path, e);
  if (acceptAiOnly !== undefined) {
    if (typeof acceptAiOnly !== 'boolean') e.add(`${path}.acceptAiOnly`, 'INVALID_TYPE', `must be a boolean, got ${describe(acceptAiOnly)}`);
    else if (!acceptAiOnly) e.reserved(`${path}.acceptAiOnly`, 'M6', 'M5 accepts step results only as AI_ATTESTED (OutcomeOnly verification), so "acceptAiOnly" must be true; requiring deterministic verification belongs to M6');
  }
  for (const [key, feature] of [
    ['requireReviewer', 'the step-level Reviewer belongs to M6'],
    ['acceptMaxIterationsOutcome', 'accepting a STOPPED_MAX_ITERATIONS outcome requires deterministic verification, which belongs to M6'],
  ] as const) {
    if (!(key in obj)) continue;
    if (typeof obj[key] !== 'boolean') e.add(`${path}.${key}`, 'INVALID_TYPE', `must be a boolean, got ${describe(obj[key])}`);
    else if (obj[key]) e.reserved(`${path}.${key}`, 'M6', `${feature}; in M5 "${key}" must be false`);
  }
}

const RETRY_FIELDS = ['maxAttempts', 'retryOn'] as const;

function validateRetry(value: unknown, path: string, e: Errors): void {
  const obj = objectWithFields(value, path, RETRY_FIELDS, e);
  if (!obj) return;
  const maxAttempts = required(obj, 'maxAttempts', path, e);
  if (maxAttempts !== undefined && maxAttempts !== WORKFLOW_LIMITS.m5MaxAttempts) {
    if (isPositiveInteger(maxAttempts)) e.reserved(`${path}.maxAttempts`, 'M6', `retries belong to M6; in M5 every step runs exactly once, so "maxAttempts" must be 1 (got ${maxAttempts})`);
    else e.add(`${path}.maxAttempts`, typeof maxAttempts === 'number' ? 'OUT_OF_RANGE' : 'INVALID_TYPE', `must be 1 in M5, got ${describe(maxAttempts)}`);
  }
  checkReservedEmptyArray(obj, 'retryOn', path, e, 'M6', 'retry conditions belong to M6');
}

const CONTEXT_FIELDS = ['fromSteps', 'memory'] as const;
const REFERENCE_FIELDS = ['step', 'output', 'maxChars'] as const;

function validateContext(value: unknown, path: string, index: StepIndex, self: string | null, e: Errors): void {
  const obj = objectWithFields(value, path, CONTEXT_FIELDS, e);
  if (!obj) return;
  if ('fromSteps' in obj) {
    const refs = obj.fromSteps;
    if (!Array.isArray(refs)) {
      e.add(`${path}.fromSteps`, 'INVALID_TYPE', `must be an array, got ${describe(refs)}`);
    } else {
      const seen = new Set<string>();
      refs.forEach((ref, i) => {
        const refPath = `${path}.fromSteps[${i}]`;
        const r = objectWithFields(ref, refPath, REFERENCE_FIELDS, e);
        if (!r) return;
        const step = required(r, 'step', refPath, e);
        const output = required(r, 'output', refPath, e);
        const maxChars = required(r, 'maxChars', refPath, e);
        if (maxChars !== undefined) checkBoundedInteger(maxChars, `${refPath}.maxChars`, e, WORKFLOW_LIMITS.maxContextChars, 'per-section context cap, docs/21 §6');
        if (step === undefined || output === undefined) return;
        if (typeof step !== 'string') return void e.add(`${refPath}.step`, 'INVALID_TYPE', `must be a step id string, got ${describe(step)}`);
        if (typeof output !== 'string') return void e.add(`${refPath}.output`, 'INVALID_TYPE', `must be an output name string, got ${describe(output)}`);
        checkStepOutputReference(step, output, refPath, index, self, e);
        const key = `${step}\u0000${output}`;
        if (seen.has(key)) e.add(refPath, 'INVALID_VALUE', `"${step}" output "${output}" is referenced more than once`);
        seen.add(key);
      });
    }
  }
  checkReservedEmptyArray(obj, 'memory', path, e, 'M8', 'project and long-term memory belong to M8');
}

/** A reference to `<step>`'s output `<output>` must name an EARLIER step, a known output
 * name, and an output that step declares. */
function checkStepOutputReference(step: string, output: string, path: string, index: StepIndex, self: string | null, e: Errors): void {
  if (!index.earlier.has(step)) {
    if (step === self) e.add(path, 'FORWARD_STEP_REFERENCE', `step "${step}" cannot reference its own outputs`);
    else if (index.all.has(step)) e.add(path, 'FORWARD_STEP_REFERENCE', `step "${step}" comes later in the workflow; only earlier steps can be referenced`);
    else e.add(path, 'UNKNOWN_STEP_REFERENCE', `unknown step "${step}"`);
    return;
  }
  if (!isWorkflowOutputName(output)) {
    e.add(path, 'UNKNOWN_OUTPUT_NAME', `unknown output "${output}" (M5 outputs: ${WORKFLOW_OUTPUT_NAMES.join(', ')})`);
    return;
  }
  if (!index.earlier.get(step)!.has(output)) e.add(path, 'UNDECLARED_OUTPUT_REFERENCE', `step "${step}" does not declare output "${output}" in its "outputs"`);
}

// ---------------------------------------------------------------------------
// placeholders — validated only; there is no template engine in M5.1
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const INPUT_PLACEHOLDER = /^inputs\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const STEP_PLACEHOLDER = /^steps\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.outputs\.([^\s]+)$/;

function validatePlaceholders(text: string, path: string, inputNames: Set<string>, index: StepIndex, self: string | null, e: Errors): void {
  for (const match of text.matchAll(PLACEHOLDER)) {
    const body = match[1];
    const inputRef = INPUT_PLACEHOLDER.exec(body);
    if (inputRef) {
      if (!inputNames.has(inputRef[1])) e.add(path, 'UNKNOWN_INPUT_REFERENCE', `placeholder {{${body}}} references undeclared input "${inputRef[1]}"`);
      continue;
    }
    const stepRef = STEP_PLACEHOLDER.exec(body);
    if (stepRef) {
      checkStepOutputReference(stepRef[1], stepRef[2], path, index, self, e);
      continue;
    }
    e.add(path, 'UNSUPPORTED_PLACEHOLDER', `unsupported placeholder {{${body}}}: only {{inputs.<name>}} and {{steps.<id>.outputs.<name>}} are allowed (no expressions, conditionals or functions)`);
  }
  const rest = text.replace(PLACEHOLDER, '');
  if (rest.includes('{{') || rest.includes('}}')) e.add(path, 'MALFORMED_PLACEHOLDER', 'contains an unmatched or nested "{{" / "}}"');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
