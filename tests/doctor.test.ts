import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctorChecks } from '../src/core/preflight/doctor.ts';

const PASS = async () => ({ status: 'PASS' as const, detail: 'ok' });
const FAIL = async () => ({ status: 'FAIL' as const, detail: 'nope' });
const WARNING = async () => ({ status: 'WARNING' as const, detail: 'meh' });
const BLOCKED = async () => ({ status: 'BLOCKED' as const, detail: 'cost guard' });

test('overall is PASS when every check passes', async () => {
  const r = await runDoctorChecks([
    { name: 'node', run: PASS },
    { name: 'git', run: PASS },
  ]);
  assert.equal(r.overall, 'PASS');
  assert.deepEqual(r.checks.map((c) => c.status), ['PASS', 'PASS']);
});

test('preserves check order and names in the report', async () => {
  const r = await runDoctorChecks([
    { name: 'node', run: PASS },
    { name: 'git', run: PASS },
  ]);
  assert.deepEqual(r.checks.map((c) => c.name), ['node', 'git']);
});

test('overall is FAIL when any check fails', async () => {
  const r = await runDoctorChecks([
    { name: 'node', run: PASS },
    { name: 'git', run: FAIL },
  ]);
  assert.equal(r.overall, 'FAIL');
});

test('a WARNING alone does not turn overall away from PASS', async () => {
  const r = await runDoctorChecks([
    { name: 'node', run: PASS },
    { name: 'codex-on-path', run: WARNING },
  ]);
  assert.equal(r.overall, 'PASS');
});

test('overall is BLOCKED when any check is BLOCKED, even if others pass', async () => {
  const r = await runDoctorChecks([
    { name: 'node', run: PASS },
    { name: 'api-key-env', run: BLOCKED },
    { name: 'git', run: PASS },
  ]);
  assert.equal(r.overall, 'BLOCKED');
});

test('BLOCKED takes priority over FAIL for overall status', async () => {
  const r = await runDoctorChecks([
    { name: 'api-key-env', run: BLOCKED },
    { name: 'git', run: FAIL },
  ]);
  assert.equal(r.overall, 'BLOCKED');
});

test('a check that throws is recorded as FAIL, not left uncaught', async () => {
  const r = await runDoctorChecks([{ name: 'flaky', run: async () => { throw new Error('boom'); } }]);
  assert.equal(r.checks[0].status, 'FAIL');
  assert.match(r.checks[0].detail, /boom/);
  assert.equal(r.overall, 'FAIL');
});

test('runs every check even if an earlier one fails or throws', async () => {
  let ran2 = false;
  await runDoctorChecks([
    { name: 'a', run: async () => { throw new Error('x'); } },
    { name: 'b', run: async () => { ran2 = true; return { status: 'PASS' as const, detail: '' }; } },
  ]);
  assert.equal(ran2, true);
});
