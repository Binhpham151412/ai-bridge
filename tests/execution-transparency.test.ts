import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeEngine, type BridgeEngineDeps, type Preflight } from '../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../src/core/config/config.ts';
import { sha256Text } from '../src/core/integrity/integrity.ts';
import type { BridgeEvent } from '../src/core/observability/events.ts';
import type { ExecutionRecord } from '../src/core/execution/execution-record.ts';
import { MAX_OUTPUT_TAIL_BYTES } from '../src/core/session-history/session-history.ts';
import { runProcess } from '../src/automation/process-runner.ts';

// M4.1 — session & execution transparency, end to end through BridgeEngine with the
// deterministic fake CLIs: what was sent, to which CLI session, whether the CLI started,
// how it ended, and what it printed — each with its honest evidence level.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex/fake-codex.mjs', import.meta.url));
const ECHO_STDIN = fileURLToPath(new URL('./fixtures/process/echo-stdin.mjs', import.meta.url));

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
    codexEnv: { FAKE_CODEX_MODE: 'sequence' },
    ...overrides,
  });
}

async function withProject<T>(fn: (projectPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-bridge-m41-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function sessionDirOf(projectPath: string): Promise<string> {
  const sessions = path.join(projectPath, '.ai-bridge', 'sessions');
  const [runId] = await readdir(sessions);
  return path.join(sessions, runId);
}

const readRecord = async (dir: string, name: string): Promise<ExecutionRecord> => JSON.parse(await readFile(path.join(dir, name), 'utf8'));

const SECRET = 'sk-ant-THISISAFAKESECRETVALUE1234567890';

// ---------------------------------------------------------------------------

test('the exact prompt is persisted and its SHA-256/bytes match what was written to the CLI stdin', () =>
  withProject(async (projectPath) => {
    const task = 'Tạo src/sum.js — "exact bytes" ✓\nline 2';
    await makeEngine(projectPath).start({ task });
    const dir = await sessionDirOf(projectPath);
    const promptFile = await readFile(path.join(dir, '001-claude-prompt.md'), 'utf8');
    const rec = await readRecord(dir, '001-claude-execution.json');

    assert.equal(promptFile, task);
    assert.equal(rec.input.file, '001-claude-prompt.md');
    assert.equal(rec.input.sha256, sha256Text(task));
    assert.equal(rec.input.bytes, Buffer.byteLength(task, 'utf8'));
    assert.equal(rec.input.delivery, 'STDIN_FLUSHED_AND_CLOSED');
    assert.ok(rec.input.deliveredAt);

    // The fake CLI echoes what it read from stdin (debug_stdin) — proof, in this
    // deterministic setting, that the bytes it received are exactly the persisted bytes.
    const stdout = await readFile(path.join(dir, '001-claude-stdout.jsonl'), 'utf8');
    const echoed = stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; text?: string })
      .find((e) => e.type === 'debug_stdin')?.text;
    assert.equal(sha256Text(echoed ?? ''), rec.input.sha256);
  }));

test('a Claude execution record captures bridge session, iteration, pid, times, exit code, status and output files', () =>
  withProject(async (projectPath) => {
    await makeEngine(projectPath).start({ task: 'Create src/sum.js' });
    const dir = await sessionDirOf(projectPath);
    const rec = await readRecord(dir, '001-claude-execution.json');
    assert.equal(rec.schema, 1);
    assert.equal(rec.agent, 'claude');
    assert.equal(rec.iteration, 1);
    assert.equal(rec.bridgeSessionId, path.basename(dir));
    assert.equal(rec.status, 'COMPLETED');
    assert.equal(rec.errorCode, null);
    assert.equal(rec.process.exitCode, 0);
    assert.equal(typeof rec.process.pid, 'number');
    assert.ok(rec.process.startedAt && rec.process.endedAt && rec.process.endedAt >= rec.process.startedAt);
    assert.ok((rec.process.durationMs ?? -1) >= 0);
    assert.equal(rec.output.kind, 'CLI_OUTPUT');
    assert.equal(rec.output.stdoutFile, '001-claude-stdout.jsonl');
    assert.equal(rec.output.stderrFile, '001-claude-stderr.log');
    assert.match(await readFile(path.join(dir, '001-claude-stdout.jsonl'), 'utf8'), /"type":"result"/);
    // Command metadata documents how the CLI was called — never payloads or credentials.
    assert.ok(rec.command.args.includes('-p'));
    assert.ok(rec.command.args.some((a) => /bytes omitted/.test(a)), 'the long report contract is summarized, not copied');
  }));

test('Claude session id: iteration 1 is requested AND confirmed by the CLI; iteration 2 resumes it with continuity VERIFIED', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const events: BridgeEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const outcome = await engine.start({ task: 'Create src/sum.js' });
    assert.equal(outcome.kind, 'COMPLETED');
    const dir = await sessionDirOf(projectPath);
    const first = await readRecord(dir, '001-claude-execution.json');
    const second = await readRecord(dir, '002-claude-execution.json');

    assert.equal(first.mode, 'NEW');
    assert.equal(first.cliSessionId.evidence, 'CONFIRMED_BY_CLI');
    assert.equal(first.cliSessionId.reported, first.cliSessionId.requested);
    assert.equal(first.continuity.verdict, 'NOT_APPLICABLE');

    assert.equal(second.mode, 'RESUME');
    assert.equal(second.cliSessionId.requested, first.cliSessionId.reported);
    assert.equal(second.continuity.verdict, 'VERIFIED');
    if (outcome.kind === 'COMPLETED') assert.equal(outcome.claudeSessionId, first.cliSessionId.reported);

    const resumed = events.find((e) => e.event === 'CLAUDE_SESSION_RESUMED');
    assert.ok(resumed);
    assert.equal(resumed.continuity, 'VERIFIED');
    assert.equal(resumed.claudeSessionId, first.cliSessionId.reported);
  }));

test('when the CLI reports no session id, nothing is invented: REQUESTED_NOT_CONFIRMED, and continuity UNKNOWN on resume', () =>
  withProject(async (projectPath) => {
    // Iteration 1 normally, then iteration 2 resumes with a CLI that reports no id.
    await makeEngine(projectPath).start({ task: 'Create src/sum.js' });
    const stateFile = path.join(projectPath, '.ai-bridge', 'state', 'current-session.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    await writeFile(stateFile, JSON.stringify({ ...state, status: 'RESPONSE_PARSED', iteration: 1 }), 'utf8');

    const outcome = await makeEngine(projectPath, { claudeEnv: { FAKE_CLAUDE_MODE: 'no-session-id' } }).resume();
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind === 'COMPLETED') assert.equal(outcome.errorCode, 'CLAUDE_RUN_FAILED:SESSION_MISMATCH');
    const rec = await readRecord(await sessionDirOf(projectPath), '002-claude-execution.json');
    assert.equal(rec.cliSessionId.reported, null);
    assert.equal(rec.cliSessionId.evidence, 'REQUESTED_NOT_CONFIRMED');
    assert.equal(rec.continuity.verdict, 'UNKNOWN');
  }));

test('Codex thread id: confirmed by the CLI + VERIFIED on resume', () =>
  withProject(async (projectPath) => {
    await makeEngine(projectPath).start({ task: 'Create src/sum.js' });
    const dir = await sessionDirOf(projectPath);
    const c1 = await readRecord(dir, '001-codex-execution.json');
    const c2 = await readRecord(dir, '002-codex-execution.json');
    assert.equal(c1.cliSessionId.requested, null);
    assert.equal(c1.cliSessionId.evidence, 'CONFIRMED_BY_CLI');
    assert.equal(c2.mode, 'RESUME');
    assert.equal(c2.continuity.verdict, 'VERIFIED');
  }));

test('Codex thread id is UNKNOWN (not invented) when the CLI reports none', () =>
  withProject(async (projectPath) => {
    await makeEngine(projectPath, { codexEnv: { FAKE_CODEX_MODE: 'no-thread-id' } }).start({ task: 'Create src/sum.js' });
    const rec = await readRecord(await sessionDirOf(projectPath), '001-codex-execution.json');
    assert.equal(rec.cliSessionId.reported, null);
    assert.equal(rec.cliSessionId.requested, null);
    assert.equal(rec.cliSessionId.evidence, 'UNKNOWN');
    assert.equal(rec.status, 'FAILED');
  }));

test('non-zero exit: FAILED record with exit code + stderr file, CLAUDE_FAILED event, and diagnostics in the outcome', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath, { claudeEnv: { FAKE_CLAUDE_MODE: 'error-exit' } });
    const events: BridgeEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const outcome = await engine.start({ task: 'Create src/sum.js' });
    assert.equal(outcome.kind, 'COMPLETED');
    if (outcome.kind !== 'COMPLETED') return;
    assert.equal(outcome.errorCode, 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT');

    const dir = await sessionDirOf(projectPath);
    const rec = await readRecord(dir, '001-claude-execution.json');
    assert.equal(rec.status, 'FAILED');
    assert.equal(rec.process.exitCode, 1);
    assert.equal(rec.errorCode, 'NON_ZERO_EXIT');
    assert.match(await readFile(path.join(dir, '001-claude-stderr.log'), 'utf8'), /simulated crash/);

    const d = outcome.diagnostics;
    assert.ok(d);
    assert.equal(d.agent, 'claude');
    assert.equal(d.exitCode, 1);
    assert.equal(d.iteration, 1);
    assert.equal(d.bridgeSessionId, path.basename(dir));
    assert.equal(d.inputSha256, sha256Text('Create src/sum.js'));
    assert.match(d.stderrTail, /simulated crash/);

    const names = events.map((e) => e.event);
    for (const e of ['PROMPT_PERSISTED', 'CLAUDE_PROCESS_STARTED', 'CLAUDE_EXITED', 'CLAUDE_FAILED', 'ERROR']) assert.ok(names.includes(e as BridgeEvent['event']), e);
    const failed = events.find((e) => e.event === 'CLAUDE_FAILED');
    assert.equal(failed?.exitCode, 1);
  }));

test('the lifecycle is observable in order: prompt persisted → step started → process started → prompt written to stdin → exited', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    const events: BridgeEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start({ task: 'Create src/sum.js' });
    const it1 = events.filter((e) => e.iteration === 1).map((e) => e.event);
    const order = ['PROMPT_PERSISTED', 'CLAUDE_STARTED', 'CLAUDE_PROCESS_STARTED', 'PROMPT_SENT', 'CLAUDE_EXITED', 'CODEX_PROCESS_STARTED', 'CODEX_EXITED'];
    const idx = order.map((e) => it1.indexOf(e as BridgeEvent['event']));
    assert.ok(
      idx.every((i) => i >= 0),
      JSON.stringify(it1),
    );
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, `out of order: ${JSON.stringify(it1)}`);
    const started = events.find((e) => e.event === 'CLAUDE_PROCESS_STARTED');
    assert.equal(typeof started?.pid, 'number');
    assert.equal(typeof started?.claudeSessionId, 'string');
  }));

test('secrets printed by a CLI are redacted in the persisted stderr, in diagnostics and in events', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath, {
      claudeEnv: { FAKE_CLAUDE_MODE: 'error-exit', FAKE_CLAUDE_EXTRA_STDERR: `ANTHROPIC_API_KEY=${SECRET} "accessToken": "abc123secret" Authorization: Bearer ${SECRET}` },
    });
    const events: BridgeEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const outcome = await engine.start({ task: 'Create src/sum.js' });
    const dir = await sessionDirOf(projectPath);
    const stderr = await readFile(path.join(dir, '001-claude-stderr.log'), 'utf8');
    assert.ok(!stderr.includes(SECRET) && !stderr.includes('abc123secret'), stderr);
    assert.match(stderr, /\[REDACTED\]/);
    const text = JSON.stringify({ outcome, events });
    assert.ok(!text.includes(SECRET) && !text.includes('abc123secret'));
    const out = await engine.getExecutionOutput(path.basename(dir), 1, 'claude', 'stderr');
    assert.ok(out && !out.text.includes(SECRET));
  }));

test('session history maps every iteration: prompt → Claude execution → report → Codex execution/verdict → next prompt', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    const [summary] = await engine.listSessions();
    const art = await engine.getSessionArtifacts(summary.runId);
    assert.ok(art);
    const [i1, i2] = art.iterations;

    assert.ok(summary.claudeSessionId && summary.codexThreadId);
    assert.equal(summary.claudeSessionId, i1.claudeExecution?.record.cliSessionId.reported);
    assert.equal(summary.codexThreadId, i2.codexExecution?.record.cliSessionId.reported);

    assert.equal(i1.claudeExecution?.effectiveStatus, 'COMPLETED');
    assert.equal(i1.claudeExecution?.record.input.sha256, i1.claudePrompt?.sha256);
    assert.equal(i1.codexVerdict, 'CONTINUE');
    assert.equal(i2.codexVerdict, 'DONE');
    // Chain: Codex's PROMPT from iteration 1 is exactly what iteration 2 sent to Claude.
    assert.equal(i2.claudeExecution?.record.input.sha256, i1.extractedPrompt?.sha256);
    assert.equal(i1.codexExecution?.record.input.sha256, i1.codexInput?.sha256);
  }));

test('a record left RUNNING by a run that is no longer running is shown as INTERRUPTED, never as running', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    const dir = await sessionDirOf(projectPath);
    const rec = await readRecord(dir, '002-claude-execution.json');
    await writeFile(path.join(dir, '002-claude-execution.json'), JSON.stringify({ ...rec, status: 'RUNNING' }), 'utf8');
    const art = await engine.getSessionArtifacts(path.basename(dir));
    assert.equal(art?.iterations[1].claudeExecution?.effectiveStatus, 'INTERRUPTED');
  }));

test('getExecutionOutput returns only a bounded tail, by fixed name; invalid requests return null', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    const dir = await sessionDirOf(projectPath);
    const runId = path.basename(dir);
    await writeFile(path.join(dir, '001-claude-stdout.jsonl'), `${'x'.repeat(MAX_OUTPUT_TAIL_BYTES + 5000)}THE-END`, 'utf8');
    const out = await engine.getExecutionOutput(runId, 1, 'claude', 'stdout');
    assert.ok(out);
    assert.equal(out.truncated, true);
    assert.ok(Buffer.byteLength(out.text) <= MAX_OUTPUT_TAIL_BYTES);
    assert.ok(out.text.endsWith('THE-END'));
    const bad: [string, number, string, string][] = [
      ['../x', 1, 'claude', 'stdout'],
      [runId, 0, 'claude', 'stdout'],
      [runId, 1.5, 'claude', 'stdout'],
      [runId, 1, 'bash', 'stdout'],
      [runId, 1, 'claude', 'transcript'],
      [runId, 7, 'claude', 'stdout'],
    ];
    for (const [r, i, a, s] of bad) {
      assert.equal(await engine.getExecutionOutput(r, i, a as 'claude', s as 'stdout'), null, `${r} ${i} ${a} ${s}`);
    }
  }));

test('runProcess reports stdin delivery evidence and never throws on a child that ignores stdin', async () => {
  let flushed = -1;
  const ok = await runProcess({ command: process.execPath, args: [ECHO_STDIN], input: 'héllo', timeoutMs: 10_000, onInputFlushed: (b) => (flushed = b) });
  assert.equal(ok.inputDelivered, true);
  assert.equal(ok.inputError, null);
  assert.equal(ok.inputBytes, Buffer.byteLength('héllo', 'utf8'));
  assert.equal(flushed, ok.inputBytes);
  assert.equal(typeof ok.pid, 'number');
  assert.ok(ok.startedAt <= ok.endedAt);

  // A child that exits without reading 8 MB of stdin may produce EPIPE — it must resolve
  // (not crash the host), and must never claim delivery while also reporting an error.
  const r = await runProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'], input: 'x'.repeat(8 * 1024 * 1024), timeoutMs: 10_000 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.inputDelivered && r.inputError !== null, false);
});

test('session summary keeps the Claude session actually worked in — a failed call reporting a different id does not replace it (regression, real CLI behaviour)', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    const dir = await sessionDirOf(projectPath);
    const good = await readRecord(dir, '001-claude-execution.json');
    const second = await readRecord(dir, '002-claude-execution.json');
    // As observed for real: `claude --resume <unknown id>` exits 1 but reports a new id.
    await writeFile(
      path.join(dir, '002-claude-execution.json'),
      JSON.stringify({ ...second, status: 'FAILED', cliSessionId: { requested: '00000000-0000-4000-8000-000000000000', reported: 'fbb86439-0faa-46ca-ab65-5bada57a6a61', evidence: 'CONFIRMED_BY_CLI' } }),
      'utf8',
    );
    const [summary] = await engine.listSessions();
    assert.equal(summary.claudeSessionId, good.cliSessionId.reported);
  }));

test('pre-M4.1 sessions (no execution records) still load; execution fields are simply null', () =>
  withProject(async (projectPath) => {
    const engine = makeEngine(projectPath);
    await engine.start({ task: 'Create src/sum.js' });
    const dir = await sessionDirOf(projectPath);
    for (const f of await readdir(dir)) if (/execution\.json$/.test(f)) await rm(path.join(dir, f));
    const art = await engine.getSessionArtifacts(path.basename(dir));
    assert.equal(art?.iterations[0].claudeExecution, null);
    assert.equal(art?.iterations[0].codexExecution, null);
    assert.equal(art?.iterations[0].claudePrompt?.text, 'Create src/sum.js');
  }));
