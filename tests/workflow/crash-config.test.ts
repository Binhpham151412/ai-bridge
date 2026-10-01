import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecutionPort, ExecutionPortResult } from '../../src/core/workflow/execution-port.ts';
import type { BridgeEvent } from '../../src/core/observability/events.ts';
import { CRASH_ENV, CRASH_POINTS, MARKER_ENV, fire, markerProblem, parseCrashConfig, reportCrashConfig, type CrashConfig } from '../../scripts/real/m5.10-crash/crash-config.ts';
import { withCrashPoints } from '../../scripts/real/m5.10-crash/crash-port.ts';
import { DIST, releaseAppDirs, sentinelHits } from '../../scripts/real/m5.10-crash/build-crash-app.ts';

// M5.10 B″ (docs/59 §23): the TEST-ONLY Workflow Host crash points — configuration (fail-closed),
// the ExecutionPort decorator, and the isolation invariants (nothing of it reaches src/, the
// production build or a packaged app).

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-bridge-crash-config-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const armedEnv = (dir: string, point = 'BEFORE_EXECUTION_HOST_FORK', name = 'm510-crash-t.marker') => ({ [CRASH_ENV]: point, [MARKER_ENV]: path.join(dir, name) });

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

test('crash config: absent or empty → disabled and silent (the production-equivalent default)', () => {
  assert.deepEqual(parseCrashConfig({}), { armed: false, reason: 'NOT_SET' });
  assert.deepEqual(parseCrashConfig({ [CRASH_ENV]: '' }), { armed: false, reason: 'NOT_SET' });
  assert.deepEqual(parseCrashConfig({ [MARKER_ENV]: 'C:\\x\\m510-crash-a.marker' }), { armed: false, reason: 'NOT_SET' }, 'a marker alone arms nothing');
});

test('crash config: exactly the two documented points, with a valid marker, arm the hook', () =>
  withDir(async (dir) => {
    for (const point of CRASH_POINTS) assert.deepEqual(parseCrashConfig(armedEnv(dir, point)), { armed: true, point, marker: path.join(dir, 'm510-crash-t.marker') });
  }));

test('crash config: an unknown or malformed point → disabled (INVALID_POINT), never armed, never a throw', () =>
  withDir(async (dir) => {
    for (const bad of ['before_execution_host_fork', 'BEFORE_EXECUTION_HOST_FORK ', 'BEFORE_EXECUTION_HOST_FORK;calc.exe', 'require("child_process")', '__proto__', 'constructor', 'AFTER_CLAUDE_STARTED', '1']) {
      const cfg = parseCrashConfig(armedEnv(dir, bad));
      assert.equal(cfg.armed, false, bad);
      assert.equal(!cfg.armed && cfg.reason, 'INVALID_POINT', bad);
    }
  }));

test('crash config: an invalid marker → disabled (INVALID_MARKER): missing, relative, UNC, wrong name, traversal, missing directory, NUL', () =>
  withDir(async (dir) => {
    const cases: [string, string | undefined][] = [
      ['missing', undefined],
      ['relative', 'm510-crash-a.marker'],
      ['relative dir', path.join('sandbox', 'm510-crash-a.marker')],
      ['UNC', '\\\\server\\share\\m510-crash-a.marker'],
      ['wrong extension', path.join(dir, 'm510-crash-a.txt')],
      ['wrong prefix', path.join(dir, 'crash-a.marker')],
      ['upper case', path.join(dir, 'm510-crash-A.marker')],
      ['traversal name', path.join(dir, '..', '..', 'm510-crash-a.marker', 'x')],
      ['missing directory', path.join(dir, 'nope', 'm510-crash-a.marker')],
      ['NUL', `${path.join(dir, 'm510-crash-a.marker')}\0`],
    ];
    for (const [what, marker] of cases) {
      const cfg = parseCrashConfig({ [CRASH_ENV]: 'BEFORE_EXECUTION_HOST_FORK', [MARKER_ENV]: marker });
      assert.equal(cfg.armed, false, what);
      assert.equal(!cfg.armed && cfg.reason, 'INVALID_MARKER', what);
      assert.notEqual(markerProblem(marker), null, what);
    }
  }));

test('fire: fires only for the configured point, and exactly once per marker (exclusive create) — across callers', () =>
  withDir(async (dir) => {
    const cfg = parseCrashConfig(armedEnv(dir, 'ON_RUN_STARTED_BEFORE_LINK'));
    assert.equal(fire(cfg, 'BEFORE_EXECUTION_HOST_FORK', 11), false, 'another point never fires');
    assert.equal(existsSync(path.join(dir, 'm510-crash-t.marker')), false);
    assert.equal(fire(cfg, 'ON_RUN_STARTED_BEFORE_LINK', 11), true, 'first time: fires');
    const second = parseCrashConfig(armedEnv(dir, 'ON_RUN_STARTED_BEFORE_LINK')); // e.g. the next Workflow Host
    assert.equal(fire(second, 'ON_RUN_STARTED_BEFORE_LINK', 12), false, 'the marker exists: never again');
    const record = JSON.parse(await readFile(path.join(dir, 'm510-crash-t.marker'), 'utf8')) as { pid: number; point: string };
    assert.deepEqual([record.pid, record.point], [11, 'ON_RUN_STARTED_BEFORE_LINK'], 'the marker names the process that fired');
    assert.equal(fire({ armed: false, reason: 'NOT_SET' }, 'ON_RUN_STARTED_BEFORE_LINK'), false, 'disabled never fires');
  }));

test('reportCrashConfig: one explicit status line per process (armed / spent / invalid); NOT_SET is silent', () =>
  withDir(async (dir) => {
    const marker = path.join(dir, 'm510-crash-t.marker');
    reportCrashConfig({ armed: false, reason: 'NOT_SET' }, 1);
    assert.equal(existsSync(`${marker}.status.jsonl`), false);
    reportCrashConfig(parseCrashConfig(armedEnv(dir)), 1);
    fire(parseCrashConfig(armedEnv(dir)), 'BEFORE_EXECUTION_HOST_FORK', 1);
    reportCrashConfig(parseCrashConfig(armedEnv(dir)), 2);
    reportCrashConfig(parseCrashConfig(armedEnv(dir, 'NOPE')), 3);
    const lines = (await readFile(`${marker}.status.jsonl`, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(
      lines.map((l) => [l.pid, l.armed, l.spent ?? null, l.reason ?? null]),
      [
        [1, true, false, null],
        [2, true, true, null],
        [3, false, null, 'INVALID_POINT'],
      ],
    );
  }));

// ---------------------------------------------------------------------------
// the ExecutionPort decorator
// ---------------------------------------------------------------------------

class Died extends Error {}
const dieByThrow = (): never => {
  throw new Died('the Workflow Host would exit(137) here');
};

const RESULT = { summary: { kind: 'HOST_FAILED', executionId: null } } as unknown as ExecutionPortResult;

/** A recording port: start() emits events and reports a spawned host, like the real one. */
function recordingPort() {
  const calls: string[] = [];
  const port: ExecutionPort = {
    async start(_request, onEvent, onHostSpawned) {
      calls.push('start');
      onHostSpawned?.(4242);
      onEvent?.({ event: 'PREFLIGHT_NOTE', runId: 'r', iteration: 0 } as unknown as BridgeEvent);
      onEvent?.({ event: 'RUN_STARTED', runId: '2026-10-01_001', iteration: 0 } as unknown as BridgeEvent);
      onEvent?.({ event: 'CLAUDE_STARTED', runId: '2026-10-01_001', iteration: 1 } as unknown as BridgeEvent);
      return RESULT;
    },
    resume: async () => (calls.push('resume'), RESULT),
    pause: async () => (calls.push('pause'), { kind: 'NOT_RUNNING' }) as never,
    stop: async () => (calls.push('stop'), { kind: 'NOT_RUNNING' }) as never,
    status: async () => (calls.push('status'), {}) as never,
    checkRecovery: async () => (calls.push('checkRecovery'), {}) as never,
    artifacts: async () => (calls.push('artifacts'), null),
    findExecutions: async () => (calls.push('findExecutions'), []),
  };
  return { port, calls };
}

const REQUEST = { attemptId: 'wf_2026-10-01_001/build/1', task: 't', maxIterations: 1 };

test('decorator disabled (any invalid or absent configuration) → the production port object itself, unwrapped', () => {
  const { port } = recordingPort();
  const configs: CrashConfig[] = [
    { armed: false, reason: 'NOT_SET' },
    { armed: false, reason: 'INVALID_POINT', detail: 'x', marker: 'C:\\x\\m510-crash-a.marker' },
    { armed: false, reason: 'INVALID_MARKER', detail: 'x', marker: null },
  ];
  for (const cfg of configs) assert.equal(withCrashPoints(port, cfg, dieByThrow), port);
});

test('J1 decorator: exits BEFORE delegating start() — the real port (and its spawnHost/fork) is never reached; one-shot', () =>
  withDir(async (dir) => {
    const { port, calls } = recordingPort();
    const wrapped = withCrashPoints(port, parseCrashConfig(armedEnv(dir, 'BEFORE_EXECUTION_HOST_FORK')), dieByThrow);
    assert.throws(() => wrapped.start(REQUEST), Died);
    assert.deepEqual(calls, [], 'nothing delegated: no Execution Host could have been forked');
    const again = withCrashPoints(port, parseCrashConfig(armedEnv(dir, 'BEFORE_EXECUTION_HOST_FORK')), dieByThrow); // the next Workflow Host
    await again.start(REQUEST);
    assert.deepEqual(calls, ['start'], 'the marker exists: the relaunch is delegated unchanged');
  }));

test('J2 decorator: the first RUN_STARTED exits BEFORE the engine sees it; earlier events pass; the next host is unaffected', () =>
  withDir(async (dir) => {
    const { port, calls } = recordingPort();
    const seen: string[] = [];
    const spawned: number[] = [];
    const wrapped = withCrashPoints(port, parseCrashConfig(armedEnv(dir, 'ON_RUN_STARTED_BEFORE_LINK')), dieByThrow);
    await assert.rejects(
      (async () => wrapped.start(REQUEST, (e) => seen.push(e.event), (pid) => spawned.push(pid)))(),
      Died,
    );
    assert.deepEqual(calls, ['start'], 'the real start ran: the Execution Host exists');
    assert.deepEqual(spawned, [4242], 'the host spawn was reported to the engine unchanged');
    assert.deepEqual(seen, ['PREFLIGHT_NOTE'], 'RUN_STARTED never reached the engine (no EXECUTION_LINKED)');
    const again = withCrashPoints(port, parseCrashConfig(armedEnv(dir, 'ON_RUN_STARTED_BEFORE_LINK')), dieByThrow);
    const seen2: string[] = [];
    await again.start(REQUEST, (e) => seen2.push(e.event));
    assert.deepEqual(seen2, ['PREFLIGHT_NOTE', 'RUN_STARTED', 'CLAUDE_STARTED'], 'marker spent: every event delegated');
  }));

test('decorator armed: every other ExecutionPort method is delegated unchanged', () =>
  withDir(async (dir) => {
    const { port, calls } = recordingPort();
    const wrapped = withCrashPoints(port, parseCrashConfig(armedEnv(dir, 'ON_RUN_STARTED_BEFORE_LINK')), dieByThrow);
    await wrapped.resume({ executionId: 'x' });
    await wrapped.pause();
    await wrapped.stop();
    await wrapped.status();
    await wrapped.checkRecovery();
    await wrapped.artifacts('x');
    await wrapped.findExecutions({ startedAfter: '' });
    assert.deepEqual(calls, ['resume', 'pause', 'stop', 'status', 'checkRecovery', 'artifacts', 'findExecutions']);
    assert.equal(existsSync(path.join(dir, 'm510-crash-t.marker')), false, 'no crash point on these paths');
  }));

// ---------------------------------------------------------------------------
// isolation invariants
// ---------------------------------------------------------------------------

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('architecture: no src/ file imports scripts/** and no src/ file knows the test crash configuration', async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(path.join(ROOT, 'src'))) {
    const text = await readFile(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const m of text.matchAll(/(?:import|export)[^'"`]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith('.') && path.resolve(path.dirname(file), spec).startsWith(path.join(ROOT, 'scripts'))) offenders.push(`${rel} imports ${spec}`);
    }
    if (text.includes(CRASH_ENV) || text.includes(MARKER_ENV) || text.includes('m5.10-crash')) offenders.push(`${rel} names the test crash configuration`);
  }
  assert.deepEqual(offenders, []);
});

test('build isolation: the production build config bundles the production workflow-host entry, never the crash entry', async () => {
  const build = await readFile(path.join(ROOT, 'scripts', 'desktop', 'build.ts'), 'utf8');
  assert.match(build, /'src', 'hosts', 'workflow-host-entry\.ts'/);
  assert.equal(build.includes('m5.10-crash'), false);
  assert.equal(build.includes('workflow-host-crash-entry'), false);
  const pkg = await readFile(path.join(ROOT, 'scripts', 'desktop', 'package-win.ts'), 'utf8');
  assert.equal(pkg.includes('m5.10-crash'), false, 'the packager ships only package.json + dist-desktop/');
});

test('build isolation: the crash sentinel is absent from the production dist-desktop/ and every packaged release app (when present)', async (t) => {
  if (!existsSync(DIST)) {
    t.skip('dist-desktop/ is not built in this checkout');
    return;
  }
  const dist = await sentinelHits(DIST);
  assert.deepEqual(dist.hits, [], 'dist-desktop/');
  t.diagnostic(`dist-desktop/: ${dist.scanned} files scanned, 0 contain ${CRASH_ENV}`);
  for (const dir of await releaseAppDirs()) {
    const r = await sentinelHits(dir);
    assert.deepEqual(r.hits, [], path.relative(ROOT, dir));
    t.diagnostic(`${path.relative(ROOT, dir)}: ${r.scanned} files scanned, 0 hits`);
  }
});
