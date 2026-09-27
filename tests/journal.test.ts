import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine, type BridgeEngineDeps, type Preflight } from '../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../src/core/config/config.ts';

// M4.2 — Development Journal + custom review rounds. Uses the same deterministic fake
// CLIs as M4.1 (tests/execution-transparency.test.ts), plus the `done-at` fake-codex mode
// and the fake-claude usage/report-extra hooks added for this milestone.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));

const passingDoctor = (): ((p: string) => Promise<Preflight>) => async () => ({
  report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
  claudeExe: process.execPath,
  codexExe: process.execPath,
  config: DEFAULT_CONFIG,
  configErrors: [],
  gitWarning: null,
});

function makeEngine(projectPath: string, overrides: Partial<BridgeEngineDeps> = {}): BridgeEngine {
  return new BridgeEngine(projectPath, {
    runDoctor: passingDoctor(),
    claudeCommandArgsPrefix: [FAKE_CLAUDE],
    codexCommandArgsPrefix: [FAKE_CODEX],
    claudeEnv: { FAKE_CLAUDE_MODE: 'ok' },
    codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '1' },
    ...overrides,
  });
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-m42-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sessionDirOf(projectPath: string): Promise<{ runId: string; dir: string }> {
  const sessions = path.join(projectPath, '.ai-bridge', 'sessions');
  const [runId] = await readdir(sessions);
  return { runId, dir: path.join(sessions, runId) };
}

// ---------------------------------------------------------------------------
// maxIterations validation, persistence, resume
// ---------------------------------------------------------------------------

for (const n of [1, 2, 3, 5]) {
  test(`start() accepts maxIterations=${n} and DONE at round 1 stops immediately regardless of the cap`, () =>
    withProject(async (projectPath) => {
      const outcome = await makeEngine(projectPath).start({ task: 'do it', maxIterations: n });
      assert.equal(outcome.kind, 'COMPLETED');
      if (outcome.kind !== 'COMPLETED') return;
      assert.equal(outcome.finalStatus, 'DONE');
      assert.equal(outcome.iterations, 1);
    }));
}

test('start() rejects a custom maxIterations outside 1..100 with INVALID_OPTIONS, and never starts a run', () =>
  withProject(async (projectPath) => {
    for (const bad of [0, -1, 101, 1.5, NaN]) {
      const outcome = await makeEngine(projectPath).start({ task: 'do it', maxIterations: bad });
      assert.equal(outcome.kind, 'INVALID_OPTIONS');
    }
    // Never acquired the lock / created a session.
    const sessions = await readdir(path.join(projectPath, '.ai-bridge', 'sessions')).catch(() => []);
    assert.deepEqual(sessions, []);
  }));

test('CONTINUE at the final iteration stops with STOPPED_MAX_ITERATIONS and iteration N+1 never starts', () =>
  withProject(async (projectPath) => {
    const outcome = await makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' } }).start({ task: 'do it', maxIterations: 2 });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') return;
    assert.equal(outcome.finalStatus, 'STOPPED_MAX_ITERATIONS');
    assert.equal(outcome.iterations, 2);
    const { dir } = await sessionDirOf(projectPath);
    await assert.rejects(readFile(path.join(dir, '003-claude-prompt.md')));
  }));

test('DONE at round 2 (of a higher cap) stops early with exactly 2 iterations', () =>
  withProject(async (projectPath) => {
    const outcome = await makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '2' } }).start({ task: 'do it', maxIterations: 5 });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') return;
    assert.equal(outcome.finalStatus, 'DONE');
    assert.equal(outcome.iterations, 2);
  }));

test('resume() preserves the maxIterations the run was started with', () =>
  withProject(async (projectPath) => {
    await makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' } }).start({ task: 'do it', maxIterations: 2 });
    const stateFile = path.join(projectPath, '.ai-bridge', 'state', 'current-session.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.maxIterations, 2);
    // Force back to a resumable checkpoint at iteration 1 (as if the process had crashed
    // right after persisting iteration 1's extracted prompt but before iteration 2's
    // Claude call) and resume — the cap must still be 2, so iteration 2 must run but
    // iteration 3 must never start.
    await writeFile(stateFile, JSON.stringify({ ...state, status: 'RESPONSE_PARSED', iteration: 1 }), 'utf8');
    const outcome = await makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' } }).resume();
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') return;
    assert.equal(outcome.finalStatus, 'STOPPED_MAX_ITERATIONS');
    const { dir } = await sessionDirOf(projectPath);
    await assert.doesNotReject(readFile(path.join(dir, '002-claude-prompt.md')));
    await assert.rejects(readFile(path.join(dir, '003-claude-prompt.md')));
  }));

// ---------------------------------------------------------------------------
// Journal contents per round
// ---------------------------------------------------------------------------

test('journal: each round gets a Claude report, ChatGPT review, exact prompt and next prompt file', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '2', FAKE_CODEX_NARRATIVE: '1' } });
    await engine.start({ task: 'do it', maxIterations: 5 });
    const { runId, dir } = await sessionDirOf(projectPath);

    for (const n of ['001', '002']) {
      assert.ok((await readFile(path.join(dir, `${n}-claude-report.md`), 'utf8')).includes('# Claude Execution Report'));
      assert.ok((await readFile(path.join(dir, `${n}-review.md`), 'utf8')).includes('# ChatGPT Review'));
      await assert.doesNotReject(readFile(path.join(dir, `${n}-claude-prompt.md`), 'utf8'));
    }
    // Round 1 CONTINUE → has a next prompt; round 2 DONE → no next prompt was sent.
    assert.ok((await readFile(path.join(dir, '001-review.md'), 'utf8')).includes('Round 2 instruction'));

    const jr1 = await engine.getJournalEntry(runId, 'CLAUDE_REPORT', 1);
    assert.ok(jr1?.text.includes('Report (verbatim)'));
    const rev1 = await engine.getJournalEntry(runId, 'CHATGPT_REVIEW', 1);
    assert.ok(rev1?.text.includes('## Decision') && rev1.text.includes('CONTINUE'));
    assert.ok(rev1?.text.includes('Round 1 reviewed (fake)'), 'the narrative review is included verbatim');
  }));

test('journal: session.md index lists rounds, artifacts links, and session ids with evidence', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'do it', maxIterations: 3 });
    const { runId } = await sessionDirOf(projectPath);
    const idx = await engine.getJournal(runId);
    assert.ok(idx);
    assert.equal(idx?.rounds.length, 1);
    assert.equal(idx?.rounds[0].verdict, 'DONE');
    assert.equal(idx?.maxIterations, 3);
    assert.ok(idx?.hasSessionIndex);
    assert.ok(idx?.hasFinalReport);

    const session = await engine.getJournalEntry(runId, 'SESSION_INDEX', null);
    assert.ok(session?.text.includes('| Round | Claude | Exit | Report | ChatGPT (Codex) | Decision |'));
    assert.ok(session?.text.includes('CONFIRMED_BY_CLI') || session?.text.includes('confirmed by the CLI'));
  }));

test('journal: final-report.md is written once the run reaches a final status, with the required sections', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' } });
    await engine.start({ task: 'do it', maxIterations: 2 });
    const { runId, dir } = await sessionDirOf(projectPath);
    const final = await readFile(path.join(dir, 'final-report.md'), 'utf8');
    for (const heading of [
      '# Development Session Report',
      '## Task',
      '## Session',
      '# Executive Summary',
      '# Development Timeline',
      '# Major Development Phases',
      '# Files Changed',
      '# Tests',
      '# Important Decisions',
      '# Problems Encountered',
      '# Remaining Work',
      '# Known Risks',
      '# Architecture Summary',
      '# Interaction Timeline',
      '# Final Result',
    ]) {
      assert.ok(final.includes(heading), `missing section: ${heading}`);
    }
    assert.match(final, /STOPPED_MAX_ITERATIONS/);
    const entry = await engine.getJournalEntry(runId, 'FINAL_REPORT', null);
    assert.equal(entry?.text, final);
  }));

test('journal: no fabrication — a DONE run at iteration 1 has no invented "problems resolved" text', () =>
  withProject(async (projectPath) => {
    await makeEngine(projectPath).start({ task: 'do it', maxIterations: 3 });
    const { dir } = await sessionDirOf(projectPath);
    const final = await readFile(path.join(dir, 'final-report.md'), 'utf8');
    assert.match(final, /UNKNOWN — AI Bridge does not infer which problems were resolved/);
  }));

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

test('journal: real Claude/Codex token usage is shown verbatim when reported', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath, { claudeEnv: { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_USAGE: '1' } });
    await engine.start({ task: 'do it', maxIterations: 1 });
    const { runId } = await sessionDirOf(projectPath);
    const report = await engine.getJournalEntry(runId, 'CLAUDE_REPORT', 1);
    assert.ok(report?.text.includes('input 10'));
    assert.ok(report?.text.includes('output 40'));
    assert.ok(report?.text.includes('cache creation 20'));
    assert.ok(report?.text.includes('total 100'), 'total = input + cache_creation + cache_read + output, reported by the CLI');

    const review = await engine.getJournalEntry(runId, 'CHATGPT_REVIEW', 1);
    assert.ok(review?.text.includes('input 1'), 'fake-codex always reports usage: input 1, output 1');
    assert.ok(review?.text.includes('total 2'));
  }));

test('journal: missing token usage is rendered as UNKNOWN, never estimated', () =>
  withProject(async (projectPath) => {
    // Default fake-claude does not set FAKE_CLAUDE_USAGE, so no usage object is emitted.
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'do it', maxIterations: 1 });
    const { runId } = await sessionDirOf(projectPath);
    const report = await engine.getJournalEntry(runId, 'CLAUDE_REPORT', 1);
    assert.ok(report?.text.includes('UNKNOWN'));
  }));

// ---------------------------------------------------------------------------
// Pause / resume / crash recovery preserve the journal without duplicates
// ---------------------------------------------------------------------------

test('journal: resume after a forced checkpoint does not duplicate or fake rounds', () =>
  withProject(async (projectPath) => {
    const engine1 = makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: 'never' } });
    await engine1.start({ task: 'do it', maxIterations: 3 });
    const { runId, dir } = await sessionDirOf(projectPath);
    // Simulate a crash right after round 2's report was validated but before Codex ran.
    const stateFile = path.join(projectPath, '.ai-bridge', 'state', 'current-session.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    await writeFile(stateFile, JSON.stringify({ ...state, status: 'REPORT_VALIDATED', iteration: 2 }), 'utf8');

    const engine2 = makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'done-at', FAKE_CODEX_DONE_AT: '3' } });
    const outcome = await engine2.resume();
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') return;
    assert.equal(outcome.finalStatus, 'DONE');
    // outcome.iterations counts only this resumed segment (rounds 2-3); the journal
    // must reflect the whole session (rounds 1-3), with nothing duplicated or invented.
    assert.equal(outcome.iterations, 2);

    const idx = await engine2.getJournal(runId);
    assert.equal(idx?.rounds.length, 3);
    assert.deepEqual(idx?.rounds.map((r) => r.iteration), [1, 2, 3]);
    // No round has more than one report/review file (no duplicate suffixes on disk).
    const files = await readdir(dir);
    for (const n of ['001', '002', '003']) {
      assert.equal(files.filter((f) => f === `${n}-claude-report.md`).length, 1);
      assert.equal(files.filter((f) => f === `${n}-review.md`).length, 1);
    }
  }));

// ---------------------------------------------------------------------------
// Markdown safety
// ---------------------------------------------------------------------------

test('journal: malformed Markdown/HTML in a report cannot break section extraction and is preserved verbatim, unexecuted', () =>
  withProject(async (projectPath) => {
    const malicious = '\n<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n';
    const engine = makeEngine(projectPath, { claudeEnv: { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_REPORT_EXTRA: malicious } });
    await engine.start({ task: 'do it', maxIterations: 1 });
    const { runId } = await sessionDirOf(projectPath);
    const report = await engine.getJournalEntry(runId, 'CLAUDE_REPORT', 1);
    // Preserved verbatim as text (this is a data assertion, not proof of a renderer —
    // the renderer-side no-HTML-execution guarantee is covered in the desktop test).
    assert.ok(report?.text.includes('<script>alert(1)</script>'));
  }));

// ---------------------------------------------------------------------------
// Invalid input handling
// ---------------------------------------------------------------------------

test('getJournal/getJournalEntry return null for an invalid or unknown run id / kind', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'do it', maxIterations: 1 });
    assert.equal(await engine.getJournal('../../etc'), null);
    assert.equal(await engine.getJournal('2099-01-01_999'), null);
    const { runId } = await sessionDirOf(projectPath);
    assert.equal(await engine.getJournalEntry(runId, 'NOT_A_KIND', 1), null);
    assert.equal(await engine.getJournalEntry(runId, 'CLAUDE_REPORT', 999), null);
  }));
