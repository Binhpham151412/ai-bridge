import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/core/workflow/canonical-json.ts';
import { canonicalizeDefinition, hashDefinition, validateAndHashWorkflowDefinition } from '../../src/core/workflow/hash.ts';
import { validateWorkflowDefinition } from '../../src/core/workflow/validator.ts';
import type { WorkflowDefinition } from '../../src/core/workflow/definition.ts';
import { fullDefinition, minimalDefinition, type Mutable } from './definition-fixtures.ts';

/** Deep copy with object keys in reverse insertion order at every level. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

function hashOf(input: unknown): string {
  const r = validateAndHashWorkflowDefinition(input);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  if (!r.valid) throw new Error('unreachable');
  return r.definitionHash;
}

// ---------------------------------------------------------------------------
// canonical JSON
// ---------------------------------------------------------------------------

test('canonicalJson sorts object keys recursively, keeps array order, emits no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: 'x y' } }), '{"a":{"c":"x y","d":[3,1,2]},"b":1}');
});

test('canonicalJson encodes every JSON scalar deterministically', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(false), 'false');
  assert.equal(canonicalJson(0), '0');
  assert.equal(canonicalJson(-0), '0');
  assert.equal(canonicalJson(1e21), '1e+21');
  assert.equal(canonicalJson(0.1), '0.1');
  assert.equal(canonicalJson('line\n"quoted"\\ é  '), JSON.stringify('line\n"quoted"\\ é  '));
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
});

test('canonicalJson sorts keys by UTF-16 code units (uppercase before lowercase, $ first)', () => {
  assert.equal(canonicalJson({ b: 0, B: 0, $comment: 'c', a: 0, _: 0 }), '{"$comment":"c","B":0,"_":0,"a":0,"b":0}');
});

test('canonicalJson throws on values outside the JSON subset instead of dropping them', () => {
  const circular: Mutable = {};
  circular.self = circular;
  const bad: unknown[] = [undefined, Number.NaN, Number.POSITIVE_INFINITY, 10n, () => 1, Symbol('s'), new Date(0), new Map(), { a: undefined }, [1, , 3], circular, { [Symbol('k')]: 1 }];
  for (const value of bad) assert.throws(() => canonicalJson(value), TypeError, String(value));
});

test('canonicalJson allows the same object twice when it is not a cycle', () => {
  const shared = { x: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

// ---------------------------------------------------------------------------
// definition hash
// ---------------------------------------------------------------------------

test('definitionHash is the SHA-256 hex of the canonical JSON', () => {
  const r = validateAndHashWorkflowDefinition(fullDefinition());
  assert.equal(r.valid, true);
  if (!r.valid) return;
  assert.equal(r.canonical, canonicalJson(fullDefinition()));
  assert.equal(r.definitionHash, createHash('sha256').update(r.canonical, 'utf8').digest('hex'));
  assert.match(r.definitionHash, /^[0-9a-f]{64}$/);
  assert.equal(hashDefinition(r.definition), r.definitionHash);
  assert.equal(canonicalizeDefinition(r.definition), r.canonical);
});

test('the hash is deterministic across calls', () => {
  assert.equal(hashOf(fullDefinition()), hashOf(fullDefinition()));
  assert.equal(hashOf(minimalDefinition()), hashOf(minimalDefinition()));
});

test('reordering object keys at any level does not change the hash', () => {
  const reordered = reverseKeys(fullDefinition());
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(fullDefinition()));
  assert.equal(hashOf(reordered), hashOf(fullDefinition()));
});

test('whitespace and formatting of the JSON text do not change the hash', () => {
  const compact = JSON.parse(JSON.stringify(fullDefinition()));
  const pretty = JSON.parse(JSON.stringify(fullDefinition(), null, 4));
  assert.equal(hashOf(compact), hashOf(pretty));
});

test('array order matters: reordering steps or outputs changes the hash', () => {
  const a = fullDefinition();
  const b = fullDefinition();
  b.steps[0].outputs = [...b.steps[0].outputs].reverse();
  assert.notEqual(hashOf(a), hashOf(b));

  const c = minimalDefinition();
  c.steps = [c.steps[0], { ...c.steps[0], id: 'second' }];
  const d = minimalDefinition();
  d.steps = [{ ...d.steps[0], id: 'second' }, d.steps[0]];
  assert.notEqual(hashOf(c), hashOf(d));
});

test('different content produces a different hash (value, version, instruction whitespace)', () => {
  const base = hashOf(fullDefinition());
  const changes: ((d: Mutable) => void)[] = [
    (d) => (d.version = 3),
    (d) => (d.title = 'Implement and document!'),
    (d) => (d.steps[0].executor.maxIterations = 11),
    (d) => (d.steps[0].instruction += ' '),
    (d) => (d.budgets.maxExecutions = 7),
  ];
  for (const change of changes) {
    const d = fullDefinition();
    change(d);
    assert.notEqual(hashOf(d), base, change.toString());
  }
});

test('$comment participates in the hash', () => {
  const withComment = fullDefinition();
  const changedComment = fullDefinition();
  changedComment.$comment = 'A different comment.';
  const noComment = fullDefinition();
  delete noComment.$comment;
  assert.notEqual(hashOf(withComment), hashOf(changedComment));
  assert.notEqual(hashOf(withComment), hashOf(noComment));
});

test('an inert reserved field present vs absent is a different definition (and a different hash)', () => {
  const absent = minimalDefinition();
  const present = minimalDefinition();
  present.steps[0].executor.requires = [];
  assert.notEqual(hashOf(absent), hashOf(present));
});

test('an invalid definition is never hashed', () => {
  const d = minimalDefinition();
  d.steps[0].retry.maxAttempts = 2;
  const r = validateAndHashWorkflowDefinition(d);
  assert.equal(r.valid, false);
  assert.equal(r.definitionHash, null);
  assert.equal(r.canonical, null);
  assert.equal(r.definition, null);
  assert.equal(r.errors[0].code, 'RESERVED_FEATURE');
});

test('hashing the frozen validated copy equals hashing the original input', () => {
  const input = fullDefinition();
  const r = validateWorkflowDefinition(input);
  assert.equal(r.valid, true);
  if (!r.valid) return;
  assert.equal(hashDefinition(r.definition), hashDefinition(input as WorkflowDefinition));
});
