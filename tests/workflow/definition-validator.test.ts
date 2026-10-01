import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowDefinition, validateWorkflowDefinitionJson, type WorkflowValidationError } from '../../src/core/workflow/validator.ts';
import { workflowInputEntries } from '../../src/core/workflow/definition.ts';
import { fullDefinition, minimalDefinition, step, type Mutable } from './definition-fixtures.ts';

function errorsOf(input: unknown): WorkflowValidationError[] {
  const r = validateWorkflowDefinition(input);
  assert.equal(r.valid, false, 'expected the definition to be rejected');
  assert.equal(r.definition, null);
  return r.errors;
}

/** Exactly one error, with this path and code. */
function onlyError(input: unknown, path: string, code: string): WorkflowValidationError {
  const errors = errorsOf(input);
  assert.deepEqual(
    errors.map((x) => [x.path, x.code]),
    [[path, code]],
    JSON.stringify(errors, null, 2),
  );
  return errors[0];
}

function withStep(i: number, patch: (s: Mutable) => void): Mutable {
  const d = minimalDefinition();
  patch(d.steps[i]);
  return d;
}

// ---------------------------------------------------------------------------
// valid definitions
// ---------------------------------------------------------------------------

test('accepts the minimal M5 definition', () => {
  const r = validateWorkflowDefinition(minimalDefinition());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.definition, minimalDefinition());
});

test('accepts multiple sequential steps with inputs, budgets, fixed outputs, context references and $comment', () => {
  const r = validateWorkflowDefinition(fullDefinition());
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test('accepts explicitly inert reserved fields (requires/retryOn/memory [], requireReviewer/acceptMaxIterationsOutcome false)', () => {
  const d = withStep(0, (s) => {
    s.executor.requires = [];
    s.verification.requireReviewer = false;
    s.verification.acceptMaxIterationsOutcome = false;
    s.retry.retryOn = [];
    s.context = { memory: [], fromSteps: [] };
  });
  assert.deepEqual(validateWorkflowDefinition(d).errors, []);
});

test('accepts every fixed M5 output name and a context reference to each from a later step', () => {
  const d = minimalDefinition();
  d.steps = [
    step('produce', { outputs: ['report.summary', 'report.remainingWork', 'report.filesChanged'] }),
    step('consume', {
      context: {
        fromSteps: [
          { step: 'produce', output: 'report.summary', maxChars: 1 },
          { step: 'produce', output: 'report.remainingWork', maxChars: 100 },
          { step: 'produce', output: 'report.filesChanged', maxChars: 16384 },
        ],
      },
    }),
  ];
  assert.deepEqual(validateWorkflowDefinition(d).errors, []);
});

test('accepts $comment on every object level', () => {
  const d = fullDefinition();
  d.budgets.$comment = 'b';
  d.steps[0].executor.$comment = 'e';
  d.steps[0].verification.$comment = 'v';
  d.steps[0].retry.$comment = 'r';
  d.steps[0].context.$comment = 'c';
  d.steps[1].context.fromSteps[0].$comment = 'f';
  d.inputs.feature.$comment = 'i';
  assert.deepEqual(validateWorkflowDefinition(d).errors, []);
});

test('accepts exactly 50 steps and the documented hard caps themselves', () => {
  const d = minimalDefinition();
  d.steps = Array.from({ length: 50 }, (_, i) => step(`s${i}`, { executor: { role: 'executor', maxIterations: 100 } }));
  d.budgets = { maxDurationMs: 259_200_000, maxTotalIterations: 1000, maxExecutions: 100 };
  d.inputs = { big: { type: 'string', required: true, maxLength: 262_144 } };
  assert.deepEqual(validateWorkflowDefinition(d).errors, []);
});

test('the accepted definition is a frozen copy, detached from the input', () => {
  const input = fullDefinition();
  const r = validateWorkflowDefinition(input);
  assert.equal(r.valid, true);
  if (!r.valid) return;
  assert.notEqual(r.definition, input);
  assert.ok(Object.isFrozen(r.definition) && Object.isFrozen(r.definition.steps[0].executor));
  input.steps[0].title = 'changed after validation';
  assert.equal(r.definition.steps[0].title, 'Step implement');
});

test('workflowInputEntries lists declared inputs in order and skips $comment', () => {
  const r = validateWorkflowDefinition(fullDefinition());
  assert.equal(r.valid, true);
  if (!r.valid) return;
  assert.deepEqual(
    workflowInputEntries(r.definition).map(([name]) => name),
    ['feature', 'extra-notes'],
  );
});

// ---------------------------------------------------------------------------
// top level / structure
// ---------------------------------------------------------------------------

test('rejects a wrong schema version', () => {
  onlyError({ ...minimalDefinition(), schema: 2 }, '$.schema', 'INVALID_VALUE');
  onlyError({ ...minimalDefinition(), schema: '1' }, '$.schema', 'INVALID_TYPE');
});

test('rejects invalid definition ids', () => {
  for (const id of ['Implement', 'implement_it', '-lead', 'trail-', 'a--b', '', '1abc', 'a'.repeat(65)]) {
    onlyError({ ...minimalDefinition(), id }, '$.id', 'INVALID_ID');
  }
  onlyError({ ...minimalDefinition(), id: 7 }, '$.id', 'INVALID_TYPE');
});

test('rejects a non-positive or non-integer version', () => {
  onlyError({ ...minimalDefinition(), version: 0 }, '$.version', 'OUT_OF_RANGE');
  onlyError({ ...minimalDefinition(), version: 1.5 }, '$.version', 'OUT_OF_RANGE');
  onlyError({ ...minimalDefinition(), version: '1' }, '$.version', 'INVALID_TYPE');
});

test('rejects an empty, non-string or over-long title', () => {
  onlyError({ ...minimalDefinition(), title: '   ' }, '$.title', 'INVALID_VALUE');
  onlyError({ ...minimalDefinition(), title: 3 }, '$.title', 'INVALID_TYPE');
  onlyError({ ...minimalDefinition(), title: 't'.repeat(201) }, '$.title', 'OUT_OF_RANGE');
});

test('reports every missing required top-level field in one result', () => {
  const errors = errorsOf({});
  assert.deepEqual(
    errors.map((x) => [x.path, x.code]),
    [
      ['$.schema', 'MISSING_FIELD'],
      ['$.id', 'MISSING_FIELD'],
      ['$.version', 'MISSING_FIELD'],
      ['$.title', 'MISSING_FIELD'],
      ['$.steps', 'MISSING_FIELD'],
    ],
  );
});

test('rejects non-object input without throwing', () => {
  for (const input of [null, undefined, 42, 'workflow', [], [minimalDefinition()], new Date()]) {
    onlyError(input, '$', 'INVALID_TYPE');
  }
});

test('rejects zero steps and more than 50 steps', () => {
  onlyError({ ...minimalDefinition(), steps: [] }, '$.steps', 'OUT_OF_RANGE');
  const d = minimalDefinition();
  d.steps = Array.from({ length: 51 }, (_, i) => step(`s${i}`));
  onlyError(d, '$.steps', 'OUT_OF_RANGE');
  onlyError({ ...minimalDefinition(), steps: {} }, '$.steps', 'INVALID_TYPE');
});

// ---------------------------------------------------------------------------
// unknown fields
// ---------------------------------------------------------------------------

test('rejects unknown fields at every level instead of ignoring or stripping them', () => {
  onlyError({ ...minimalDefinition(), description: 'x' }, '$.description', 'UNKNOWN_FIELD');
  onlyError(withStep(0, (s) => (s.timeout = 5)), '$.steps[0].timeout', 'UNKNOWN_FIELD');
  onlyError(withStep(0, (s) => (s.executor.model = 'opus')), '$.steps[0].executor.model', 'UNKNOWN_FIELD');
  onlyError(withStep(0, (s) => (s.verification.command = 'pnpm test')), '$.steps[0].verification.command', 'UNKNOWN_FIELD');
  onlyError(withStep(0, (s) => (s.retry.backoff = 'exp')), '$.steps[0].retry.backoff', 'UNKNOWN_FIELD');
  onlyError(withStep(0, (s) => (s.context = { fromInputs: [] })), '$.steps[0].context.fromInputs', 'UNKNOWN_FIELD');
  onlyError({ ...minimalDefinition(), budgets: { maxCostUsd: 5 } }, '$.budgets.maxCostUsd', 'UNKNOWN_FIELD');
  onlyError({ ...minimalDefinition(), inputs: { x: { type: 'string', required: true, maxLength: 5, default: 'a' } } }, '$.inputs.x.default', 'UNKNOWN_FIELD');
});

test('rejects a non-string $comment', () => {
  onlyError({ ...minimalDefinition(), $comment: 5 }, '$.$comment', 'INVALID_TYPE');
  onlyError(withStep(0, (s) => (s.retry.$comment = null)), '$.steps[0].retry.$comment', 'INVALID_TYPE');
});

test('error output is deterministic regardless of key order', () => {
  const a = { schema: 3, id: 'Bad', version: 0, title: '', steps: [], zeta: 1, alpha: 2 };
  const b = { alpha: 2, steps: [], title: '', zeta: 1, version: 0, id: 'Bad', schema: 3 };
  assert.deepEqual(errorsOf(a), errorsOf(b));
  assert.deepEqual(
    errorsOf(a).map((x) => x.path),
    ['$.alpha', '$.zeta', '$.schema', '$.id', '$.version', '$.title', '$.steps'],
  );
});

// ---------------------------------------------------------------------------
// steps and executor
// ---------------------------------------------------------------------------

test('rejects duplicate step ids', () => {
  const d = minimalDefinition();
  d.steps = [step('build'), step('test'), step('build')];
  onlyError(d, '$.steps[2].id', 'DUPLICATE_STEP_ID');
});

test('rejects invalid or missing step ids', () => {
  onlyError(withStep(0, (s) => (s.id = 'Build Step')), '$.steps[0].id', 'INVALID_ID');
  onlyError(withStep(0, (s) => (s.id = '')), '$.steps[0].id', 'INVALID_ID');
  onlyError(withStep(0, (s) => delete s.id), '$.steps[0].id', 'MISSING_FIELD');
});

test('reports every missing required step field', () => {
  const d = minimalDefinition();
  d.steps = [{}];
  assert.deepEqual(
    errorsOf(d).map((x) => x.path),
    ['$.steps[0].id', '$.steps[0].title', '$.steps[0].executor', '$.steps[0].verification', '$.steps[0].retry', '$.steps[0].instruction'],
  );
  onlyError({ ...minimalDefinition(), steps: ['build'] }, '$.steps[0]', 'INVALID_TYPE');
});

test('rejects an empty or oversized instruction', () => {
  onlyError(withStep(0, (s) => (s.instruction = '')), '$.steps[0].instruction', 'INVALID_VALUE');
  onlyError(withStep(0, (s) => (s.instruction = 'é'.repeat(131_073))), '$.steps[0].instruction', 'OUT_OF_RANGE');
});

test('rejects maxIterations of 0, above 100, or non-integer — never clamps', () => {
  onlyError(withStep(0, (s) => (s.executor.maxIterations = 0)), '$.steps[0].executor.maxIterations', 'OUT_OF_RANGE');
  const over = onlyError(withStep(0, (s) => (s.executor.maxIterations = 101)), '$.steps[0].executor.maxIterations', 'OUT_OF_RANGE');
  assert.match(over.message, /at most 100/);
  assert.match(over.message, /never clamped/);
  onlyError(withStep(0, (s) => (s.executor.maxIterations = 2.5)), '$.steps[0].executor.maxIterations', 'OUT_OF_RANGE');
  onlyError(withStep(0, (s) => (s.executor.maxIterations = '10')), '$.steps[0].executor.maxIterations', 'INVALID_TYPE');
});

test('rejects an invalid executor', () => {
  onlyError(withStep(0, (s) => (s.executor.role = 'reviewer')), '$.steps[0].executor.role', 'INVALID_VALUE');
  onlyError(withStep(0, (s) => delete s.executor.role), '$.steps[0].executor.role', 'MISSING_FIELD');
  onlyError(withStep(0, (s) => delete s.executor.maxIterations), '$.steps[0].executor.maxIterations', 'MISSING_FIELD');
  onlyError(withStep(0, (s) => (s.executor = 'claude')), '$.steps[0].executor', 'INVALID_TYPE');
});

test('rejects unknown or duplicate step outputs', () => {
  onlyError(withStep(0, (s) => (s.outputs = ['report.summary', 'report.diff'])), '$.steps[0].outputs[1]', 'UNKNOWN_OUTPUT_NAME');
  onlyError(withStep(0, (s) => (s.outputs = ['report.summary', 'report.summary'])), '$.steps[0].outputs[1]', 'INVALID_VALUE');
  onlyError(withStep(0, (s) => (s.outputs = 'report.summary')), '$.steps[0].outputs', 'INVALID_TYPE');
});

// ---------------------------------------------------------------------------
// reserved features — rejected, naming the milestone that owns them
// ---------------------------------------------------------------------------

function assertReserved(err: WorkflowValidationError, milestone: string): void {
  assert.equal(err.code, 'RESERVED_FEATURE');
  assert.equal(err.milestone, milestone);
  assert.match(err.message, new RegExp(`\\b${milestone}\\b`));
}

test('non-empty executor.requires is rejected as an M7 capability feature', () => {
  const err = onlyError(withStep(0, (s) => (s.executor.requires = ['execute:file-edit'])), '$.steps[0].executor.requires', 'RESERVED_FEATURE');
  assertReserved(err, 'M7');
  assert.match(err.message, /Capability Registry/);
  onlyError(withStep(0, (s) => (s.executor.requires = 'x')), '$.steps[0].executor.requires', 'INVALID_TYPE');
});

test('non-empty verification.checks is rejected as M6 deterministic verification, not ignored', () => {
  const err = onlyError(
    withStep(0, (s) => (s.verification.checks = [{ kind: 'command', id: 'tests', command: 'pnpm', args: ['test'], timeoutMs: 600000, required: true }])),
    '$.steps[0].verification.checks',
    'RESERVED_FEATURE',
  );
  assertReserved(err, 'M6');
  assert.match(err.message, /deterministic verification/);
});

test('acceptAiOnly false is rejected as M6; a missing or non-boolean value is a structural error', () => {
  const err = onlyError(withStep(0, (s) => (s.verification.acceptAiOnly = false)), '$.steps[0].verification.acceptAiOnly', 'RESERVED_FEATURE');
  assertReserved(err, 'M6');
  assert.match(err.message, /AI_ATTESTED/);
  onlyError(withStep(0, (s) => delete s.verification.acceptAiOnly), '$.steps[0].verification.acceptAiOnly', 'MISSING_FIELD');
  onlyError(withStep(0, (s) => (s.verification.acceptAiOnly = 'yes')), '$.steps[0].verification.acceptAiOnly', 'INVALID_TYPE');
  onlyError(withStep(0, (s) => delete s.verification.checks), '$.steps[0].verification.checks', 'MISSING_FIELD');
});

test('requireReviewer true is rejected as the M6 step-level Reviewer', () => {
  const err = onlyError(withStep(0, (s) => (s.verification.requireReviewer = true)), '$.steps[0].verification.requireReviewer', 'RESERVED_FEATURE');
  assertReserved(err, 'M6');
  assert.match(err.message, /Reviewer/);
});

test('acceptMaxIterationsOutcome true is rejected as M6', () => {
  const err = onlyError(withStep(0, (s) => (s.verification.acceptMaxIterationsOutcome = true)), '$.steps[0].verification.acceptMaxIterationsOutcome', 'RESERVED_FEATURE');
  assertReserved(err, 'M6');
});

test('retry.maxAttempts other than 1 is rejected: >1 as M6 retries, invalid numbers structurally', () => {
  for (const n of [2, 5, 6]) {
    const err = onlyError(withStep(0, (s) => (s.retry.maxAttempts = n)), '$.steps[0].retry.maxAttempts', 'RESERVED_FEATURE');
    assertReserved(err, 'M6');
    assert.match(err.message, /retries/);
  }
  onlyError(withStep(0, (s) => (s.retry.maxAttempts = 0)), '$.steps[0].retry.maxAttempts', 'OUT_OF_RANGE');
  onlyError(withStep(0, (s) => (s.retry.maxAttempts = '1')), '$.steps[0].retry.maxAttempts', 'INVALID_TYPE');
  onlyError(withStep(0, (s) => delete s.retry.maxAttempts), '$.steps[0].retry.maxAttempts', 'MISSING_FIELD');
});

test('non-empty retry.retryOn is rejected as M6', () => {
  const err = onlyError(withStep(0, (s) => (s.retry.retryOn = ['VERIFICATION_FAILED'])), '$.steps[0].retry.retryOn', 'RESERVED_FEATURE');
  assertReserved(err, 'M6');
});

test('non-empty context.memory is rejected as M8', () => {
  const err = onlyError(withStep(0, (s) => (s.context = { memory: ['project:build-commands'] })), '$.steps[0].context.memory', 'RESERVED_FEATURE');
  assertReserved(err, 'M8');
  assert.match(err.message, /memory/);
});

test('the documented docs/36 example is rejected only for its M6 features', () => {
  const example = {
    schema: 1,
    id: 'implement-and-verify',
    version: 1,
    title: 'Implement a feature and verify it',
    inputs: { feature: { type: 'string', maxLength: 4000, required: true } },
    budgets: { maxDurationMs: 14400000, maxTotalIterations: 40, maxExecutions: 6 },
    steps: [
      {
        id: 'implement',
        title: 'Implement',
        instruction: 'Implement the following feature:\n{{inputs.feature}}',
        executor: { role: 'executor', maxIterations: 10, requires: [] },
        outputs: ['report.summary'],
        verification: {
          checks: [{ kind: 'command', id: 'typecheck', command: 'pnpm', args: ['typecheck'], timeoutMs: 600000, required: true }],
          requireReviewer: false,
          acceptAiOnly: false,
          acceptMaxIterationsOutcome: false,
        },
        retry: { maxAttempts: 2, retryOn: ['VERIFICATION_FAILED', 'REPORT_MISSING_OR_INVALID'] },
        context: { fromSteps: [], memory: [] },
      },
      {
        id: 'document',
        title: 'Update docs',
        instruction: 'Update README for the change summarized below.',
        executor: { role: 'executor', maxIterations: 3 },
        context: { fromSteps: [{ step: 'implement', output: 'report.summary', maxChars: 8000 }] },
        verification: { checks: [], acceptAiOnly: true },
        retry: { maxAttempts: 1 },
      },
    ],
  };
  const errors = errorsOf(example);
  assert.deepEqual(
    errors.map((x) => [x.path, x.code, x.milestone]),
    [
      ['$.steps[0].verification.checks', 'RESERVED_FEATURE', 'M6'],
      ['$.steps[0].verification.acceptAiOnly', 'RESERVED_FEATURE', 'M6'],
      ['$.steps[0].retry.maxAttempts', 'RESERVED_FEATURE', 'M6'],
      ['$.steps[0].retry.retryOn', 'RESERVED_FEATURE', 'M6'],
    ],
  );
});

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

test('rejects invalid input types', () => {
  for (const type of ['number', 'enum', 'String']) {
    onlyError({ ...minimalDefinition(), inputs: { x: { type, required: true, maxLength: 10 } } }, '$.inputs.x.type', 'INVALID_VALUE');
  }
  onlyError({ ...minimalDefinition(), inputs: { x: { type: 1, required: true, maxLength: 10 } } }, '$.inputs.x.type', 'INVALID_TYPE');
});

test('rejects invalid maxLength values', () => {
  for (const maxLength of [0, -1, 1.5, 262_145]) {
    onlyError({ ...minimalDefinition(), inputs: { x: { type: 'string', required: true, maxLength } } }, '$.inputs.x.maxLength', 'OUT_OF_RANGE');
  }
  onlyError({ ...minimalDefinition(), inputs: { x: { type: 'string', required: true, maxLength: '10' } } }, '$.inputs.x.maxLength', 'INVALID_TYPE');
});

test('rejects malformed input declarations', () => {
  onlyError({ ...minimalDefinition(), inputs: { x: { type: 'string', maxLength: 10 } } }, '$.inputs.x.required', 'MISSING_FIELD');
  onlyError({ ...minimalDefinition(), inputs: { x: { type: 'string', required: 'yes', maxLength: 10 } } }, '$.inputs.x.required', 'INVALID_TYPE');
  onlyError({ ...minimalDefinition(), inputs: { Feature: { type: 'string', required: true, maxLength: 10 } } }, '$.inputs.Feature', 'INVALID_ID');
  onlyError({ ...minimalDefinition(), inputs: { x: 'string' } }, '$.inputs.x', 'INVALID_TYPE');
  onlyError({ ...minimalDefinition(), inputs: ['x'] }, '$.inputs', 'INVALID_TYPE');
});

// ---------------------------------------------------------------------------
// placeholders and context references
// ---------------------------------------------------------------------------

test('rejects a placeholder referencing an undeclared input', () => {
  onlyError(withStep(0, (s) => (s.instruction = 'Build {{inputs.feature}}')), '$.steps[0].instruction', 'UNKNOWN_INPUT_REFERENCE');
});

test('rejects a placeholder referencing an unknown step', () => {
  onlyError(withStep(0, (s) => (s.instruction = 'Use {{steps.nowhere.outputs.report.summary}}')), '$.steps[0].instruction', 'UNKNOWN_STEP_REFERENCE');
});

test('rejects forward and self step references in placeholders and in context', () => {
  const d = minimalDefinition();
  d.steps = [step('first', { instruction: 'Use {{steps.second.outputs.report.summary}}' }), step('second', { outputs: ['report.summary'] })];
  onlyError(d, '$.steps[0].instruction', 'FORWARD_STEP_REFERENCE');

  const self = minimalDefinition();
  self.steps = [step('loop', { outputs: ['report.summary'], context: { fromSteps: [{ step: 'loop', output: 'report.summary', maxChars: 100 }] } })];
  onlyError(self, '$.steps[0].context.fromSteps[0]', 'FORWARD_STEP_REFERENCE');

  const fwd = minimalDefinition();
  fwd.steps = [step('a', { context: { fromSteps: [{ step: 'b', output: 'report.summary', maxChars: 10 }] } }), step('b', { outputs: ['report.summary'] })];
  onlyError(fwd, '$.steps[0].context.fromSteps[0]', 'FORWARD_STEP_REFERENCE');
});

test('rejects references to outputs an earlier step does not declare, or outside the fixed vocabulary', () => {
  const undeclared = minimalDefinition();
  undeclared.steps = [step('a', { outputs: ['report.summary'] }), step('b', { instruction: 'x {{steps.a.outputs.report.filesChanged}}' })];
  onlyError(undeclared, '$.steps[1].instruction', 'UNDECLARED_OUTPUT_REFERENCE');

  const unknown = minimalDefinition();
  unknown.steps = [step('a', { outputs: ['report.summary'] }), step('b', { context: { fromSteps: [{ step: 'a', output: 'report.diff', maxChars: 10 }] } })];
  onlyError(unknown, '$.steps[1].context.fromSteps[0]', 'UNKNOWN_OUTPUT_NAME');
});

test('rejects expressions, conditionals, functions and arbitrary interpolation in placeholders', () => {
  const d = minimalDefinition();
  d.inputs = { feature: { type: 'string', required: true, maxLength: 100 } };
  for (const body of ['inputs.feature | upper', 'if inputs.feature', 'len(inputs.feature)', 'env.PATH', ' inputs.feature ', 'inputs.feature + 1', 'steps.only', '#each steps', 'inputs']) {
    d.steps[0].instruction = `x {{${body}}} y`;
    onlyError(d, '$.steps[0].instruction', 'UNSUPPORTED_PLACEHOLDER');
  }
});

test('rejects unmatched or nested placeholder braces', () => {
  for (const text of ['x {{inputs.feature', 'x }} y', '{{ {{inputs.x}} }}']) {
    const d = minimalDefinition();
    d.inputs = { x: { type: 'string', required: true, maxLength: 10 }, feature: { type: 'string', required: true, maxLength: 10 } };
    d.steps[0].instruction = text;
    assert.ok(
      errorsOf(d).some((x) => x.code === 'MALFORMED_PLACEHOLDER' || x.code === 'UNSUPPORTED_PLACEHOLDER'),
      text,
    );
  }
});

test('rejects malformed context references', () => {
  const d = minimalDefinition();
  d.steps = [step('a', { outputs: ['report.summary'] }), step('b', { context: { fromSteps: [{ step: 'a', output: 'report.summary', maxChars: 16385 }] } })];
  onlyError(d, '$.steps[1].context.fromSteps[0].maxChars', 'OUT_OF_RANGE');
  d.steps[1].context.fromSteps = [{ step: 'a', output: 'report.summary' }];
  onlyError(d, '$.steps[1].context.fromSteps[0].maxChars', 'MISSING_FIELD');
  d.steps[1].context.fromSteps = [
    { step: 'a', output: 'report.summary', maxChars: 5 },
    { step: 'a', output: 'report.summary', maxChars: 9 },
  ];
  onlyError(d, '$.steps[1].context.fromSteps[1]', 'INVALID_VALUE');
  d.steps[1].context.fromSteps = 'a';
  onlyError(d, '$.steps[1].context.fromSteps', 'INVALID_TYPE');
});

// ---------------------------------------------------------------------------
// budgets
// ---------------------------------------------------------------------------

test('rejects workflow budgets beyond the hard caps or not positive integers — never clamps', () => {
  const cases: [string, unknown][] = [
    ['maxDurationMs', 259_200_001],
    ['maxTotalIterations', 1001],
    ['maxExecutions', 101],
    ['maxExecutions', 0],
    ['maxTotalIterations', -5],
    ['maxReportedTokens', 1.5],
  ];
  for (const [field, value] of cases) {
    const err = onlyError({ ...minimalDefinition(), budgets: { [field]: value } }, `$.budgets.${field}`, 'OUT_OF_RANGE');
    assert.doesNotMatch(err.message, /clamped to/);
  }
  onlyError({ ...minimalDefinition(), budgets: { maxExecutions: '6' } }, '$.budgets.maxExecutions', 'INVALID_TYPE');
  onlyError({ ...minimalDefinition(), budgets: [] }, '$.budgets', 'INVALID_TYPE');
});

// ---------------------------------------------------------------------------
// JSON text entry point
// ---------------------------------------------------------------------------

test('validateWorkflowDefinitionJson rejects invalid JSON and non-object JSON, accepts a valid document', () => {
  for (const text of ['', '{', "{ schema: 1 }", '{"schema":1,}', 'undefined']) {
    const r = validateWorkflowDefinitionJson(text);
    assert.equal(r.valid, false);
    assert.deepEqual(
      r.errors.map((x) => [x.path, x.code]),
      [['$', 'INVALID_JSON']],
      text,
    );
  }
  for (const text of ['[]', '"workflow"', '42', 'null']) {
    const r = validateWorkflowDefinitionJson(text);
    assert.deepEqual(
      r.errors.map((x) => [x.path, x.code]),
      [['$', 'INVALID_TYPE']],
      text,
    );
  }
  const ok = validateWorkflowDefinitionJson(JSON.stringify(fullDefinition(), null, 2));
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, []);
});

test('a JSON "__proto__" key is an unknown field, never a prototype change', () => {
  const r = validateWorkflowDefinitionJson('{"schema":1,"id":"x","version":1,"title":"t","steps":[],"__proto__":{"polluted":true}}');
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((x) => x.path === '$.__proto__' && x.code === 'UNKNOWN_FIELD'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
