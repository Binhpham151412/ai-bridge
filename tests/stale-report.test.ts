import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine, type BridgeEngineDeps, type Preflight } from '../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../src/core/config/config.ts';
import { sha256Text } from '../src/core/integrity/integrity.ts';
import { reportSessionIdOf } from '../src/reports/report-validator.ts';
import { isolateStaleReport } from '../src/reports/stale-report.ts';
import { describeRunOutcome } from '../src/desktop/shared/messages.ts';
import type { ExecutionRecord } from '../src/core/execution/execution-record.ts';

// Regression for real run 2026-10-02_001: Claude exited 0 without writing a report, the shared
// reports/001-report.md still held the PREVIOUS session's report, and it was validated as this
// run's → SESSION_MISMATCH → REPORT_INVALID; the journal also showed it as this run's report.
// Fake CLIs only — no provider, no quota.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

const doctor = (): ((p: string) => Promise<Preflight>) => async () => ({
  report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
  claudeExe: process.execPath,
  codexExe: process.execPath,
  config: DEFAULT_CONFIG,
  configErrors: [],
  gitWarning: null,
});

function engine(projectPath: string, claudeMode = 'ok', codexEnv: Record<string, string> = { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' }, o: Partial<BridgeEngineDeps> = {}): BridgeEngine {
  return new BridgeEngine(projectPath, {
    runDoctor: doctor(),
    claudeCommandArgsPrefix: [FAKE_CLAUDE],
    codexCommandArgsPrefix: [FAKE_CODEX],
    claudeEnv: { FAKE_CLAUDE_MODE: claudeMode },
    codexEnv,
    ...o,
  });
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-stale-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const reports = (projectPath: string) => path.join(projectPath, '.ai-bridge', 'reports');
const sessions = async (projectPath: string) => (await readdir(path.join(projectPath, '.ai-bridge', 'sessions'))).sort();
const exists = (p: string) => stat(p).then(() => true, () => false);

/** Session A writes reports/001-report.md (DONE); session B's Claude answers in chat. */
async function incident(projectPath: string) {
  const a = await engine(projectPath).start({ task: 'first task', maxIterations: 1 });
  assert.equal(a.kind === 'COMPLETED' && a.finalStatus, 'DONE');
  const shared = path.join(reports(projectPath), '001-report.md');
  const staleText = await readFile(shared, 'utf8');
  const b = await engine(projectPath, 'answer-in-chat').start({ task: 'continue', maxIterations: 3 });
  const [runA, runB] = await sessions(projectPath);
  return { a, b, runA, runB, shared, staleText };
}

test('the previous session\'s report is moved aside before Claude runs — never validated as this run\'s report', () =>
  withProject(async (projectPath) => {
    const { b, runA, runB, shared, staleText } = await incident(projectPath);
    assert.equal(b.kind, 'COMPLETED');
    if (b.kind !== 'COMPLETED') return;
    assert.equal(b.finalStatus, 'ERROR');
    assert.equal(b.errorCode, 'REPORT_INVALID', 'run outcome code unchanged (workflow mapping REPORT_MISSING_OR_INVALID)');
    assert.match(b.errorMessage ?? '', /^REPORT_MISSING: /, 'the truthful cause: this Claude call wrote no report');
    assert.doesNotMatch(b.errorMessage ?? '', /SESSION_MISMATCH/);
    assert.match(b.errorMessage ?? '', new RegExp(`moved to reports/superseded/${runA}-001-report\\.md before Claude ran`));

    // Moved, not deleted — bytes unchanged.
    assert.equal(await exists(shared), false);
    const moved = path.join(reports(projectPath), 'superseded', `${runA}-001-report.md`);
    assert.equal(await readFile(moved, 'utf8'), staleText);

    // Audited on this run's Claude execution record.
    const rec = JSON.parse(await readFile(path.join(projectPath, '.ai-bridge', 'sessions', runB, '001-claude-execution.json'), 'utf8')) as ExecutionRecord;
    assert.deepEqual(rec.staleReport, { from: '001-report.md', movedTo: `superseded/${runA}-001-report.md`, sessionId: runA, sha256: sha256Text(staleText), bytes: Buffer.byteLength(staleText) });
    assert.equal(rec.status, 'COMPLETED');

    // The UI explains it as "Claude exited normally but wrote no report".
    assert.match(describeRunOutcome(b)?.message ?? '', /không ghi file report/);
  }));

test('journal: the failed run shows NO report of its own; the earlier session still shows (and verifies) its report from superseded/', () =>
  withProject(async (projectPath) => {
    const { runA, runB } = await incident(projectPath);
    const e = engine(projectPath);
    const artB = await e.getSessionArtifacts(runB);
    assert.equal(artB?.iterations[0].report.availability, 'MISSING');
    const journalB = await e.getJournal(runB);
    assert.ok(journalB && !journalB.rounds[0].available.includes('CLAUDE_REPORT'), 'no Claude report journal entry for a report that was never written');
    assert.equal(await exists(path.join(projectPath, '.ai-bridge', 'sessions', runB, '001-claude-report.md')), false);

    const artA = await e.getSessionArtifacts(runA);
    const repA = artA?.iterations[0].report;
    assert.equal(repA?.availability, 'AVAILABLE');
    if (repA?.availability === 'AVAILABLE') {
      assert.equal(repA.verification, 'VERIFIED');
      assert.equal(reportSessionIdOf(repA.text), runA);
    }
  }));

test('journal (pre-fix data, e.g. the real bdsdanang session): a shared report from ANOTHER session is never attributed to this one', () =>
  withProject(async (projectPath) => {
    const { runA, runB } = await incident(projectPath);
    // Recreate the pre-fix layout: the old session's file sits at the shared path again.
    await copyFile(path.join(reports(projectPath), 'superseded', `${runA}-001-report.md`), path.join(reports(projectPath), '001-report.md'));
    const e = engine(projectPath);
    const repB = (await e.getSessionArtifacts(runB))?.iterations[0].report;
    assert.ok(repB && repB.availability === 'MISSING', JSON.stringify(repB));
    assert.match(repB.note, new RegExp(`belongs to session ${runA}`));
    const repA = (await e.getSessionArtifacts(runA))?.iterations[0].report;
    assert.equal(repA?.availability === 'AVAILABLE' && repA.verification, 'VERIFIED', 'the owning session is unaffected');
  }));

test('a normal next run still works: the old report is moved aside and the new one is written, validated and journaled', () =>
  withProject(async (projectPath) => {
    await engine(projectPath).start({ task: 'first', maxIterations: 1 });
    const second = await engine(projectPath).start({ task: 'second', maxIterations: 1 });
    assert.equal(second.kind === 'COMPLETED' && second.finalStatus, 'DONE');
    const [runA, runB] = await sessions(projectPath);
    assert.equal(reportSessionIdOf(await readFile(path.join(reports(projectPath), '001-report.md'), 'utf8')), runB);
    assert.equal(await exists(path.join(reports(projectPath), 'superseded', `${runA}-001-report.md`)), true);
    const e = engine(projectPath);
    for (const runId of [runA, runB]) {
      const rep = (await e.getSessionArtifacts(runId))?.iterations[0].report;
      assert.equal(rep?.availability === 'AVAILABLE' && rep.verification, 'VERIFIED', runId);
    }
  }));

test('recovery that re-sends an existing report to Codex (Claude skipped) never moves that report', () =>
  withProject(async (projectPath) => {
    const never = { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' };
    await engine(projectPath, 'ok', never).start({ task: 'do it', maxIterations: 2 });
    const report2 = path.join(reports(projectPath), '002-report.md');
    const before = await readFile(report2, 'utf8');
    const stateFile = path.join(projectPath, '.ai-bridge', 'state', 'current-session.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    await writeFile(stateFile, JSON.stringify({ ...state, status: 'REPORT_VALIDATED', iteration: 2 }), 'utf8');
    const resumed = await engine(projectPath, 'ok', { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '2' }).resume();
    assert.equal(resumed.kind === 'COMPLETED' && resumed.finalStatus, 'DONE');
    assert.equal(await readFile(report2, 'utf8'), before, 're-sent report untouched');
    const superseded = await readdir(path.join(reports(projectPath), 'superseded')).catch(() => [] as string[]);
    assert.ok(!superseded.some((f) => f.endsWith('002-report.md')), JSON.stringify(superseded));
  }));

test('isolateStaleReport: nothing to move → null; name collisions never overwrite; reportSessionIdOf reads only the header', () =>
  withProject(async (dir) => {
    const rdir = path.join(dir, 'reports');
    await mkdir(rdir, { recursive: true });
    const p = path.join(rdir, '001-report.md');
    assert.equal(await isolateStaleReport(p, rdir), null);
    const body = (sid: string) => `# AI Bridge Report\n\nSESSION_ID: ${sid}\nITERATION: 1\n\n## TASK\nSESSION_ID: not-this-one\n`;
    await writeFile(p, body('2026-10-01_001'));
    assert.equal((await isolateStaleReport(p, rdir))?.movedTo, 'superseded/2026-10-01_001-001-report.md');
    await writeFile(p, body('2026-10-01_001'));
    assert.equal((await isolateStaleReport(p, rdir))?.movedTo, 'superseded/2026-10-01_001-001-report.2.md');
    await writeFile(p, 'no header at all');
    const m = await isolateStaleReport(p, rdir);
    assert.deepEqual([m?.sessionId, m?.movedTo], [null, 'superseded/unknown-session-001-report.md']);
    assert.equal(reportSessionIdOf(body('X')), 'X');
    assert.equal(reportSessionIdOf('# AI Bridge Report\n## TASK\nSESSION_ID: late\n'), null);
  }));

test('journal rebuild removes a pre-fix entry that embeds ANOTHER session\'s report — but keeps one holding this session\'s own report', () =>
  withProject(async (projectPath) => {
    const { runA, runB, staleText } = await incident(projectPath);
    const entry = path.join(projectPath, '.ai-bridge', 'sessions', runB, '001-claude-report.md');
    const derived = (embedded: string) => `# Claude Execution Report\n\n## Session\n\n- AI Bridge Session: ${runB}\n\n## Report (verbatim)\n\n${embedded}\n`;
    const e = engine(projectPath);

    // What the real bdsdanang session has on disk: run B's entry wrapping run A's report.
    await writeFile(entry, derived(staleText), 'utf8');
    assert.match(staleText, new RegExp(`SESSION_ID: ${runA}`));
    const journal = await e.getJournal(runB);
    assert.equal(await exists(entry), false, 'misattributed derived entry removed');
    assert.ok(journal && !journal.rounds[0].available.includes('CLAUDE_REPORT'));

    // An entry whose embedded report IS this session's (possibly the only copy left) is kept.
    const own = staleText.replace(`SESSION_ID: ${runA}`, `SESSION_ID: ${runB}`);
    await writeFile(entry, derived(own), 'utf8');
    await e.getJournal(runB);
    assert.equal(await readFile(entry, 'utf8'), derived(own));
  }));
