import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest } from '../../src/desktop/shared/ipc-contract.ts';
import { describeRunErrorCode, describeRunOutcome, formatDiagnostics } from '../../src/desktop/shared/messages.ts';
import { redactSecrets } from '../../src/core/security/redact.ts';
import type { ExecutionDiagnostics } from '../../src/core/execution/execution-record.ts';

// M4.1 desktop side: the new IPC channel's validation, and the "View details" text built
// from Core's execution diagnostics.

const diag = (over: Partial<ExecutionDiagnostics> = {}): ExecutionDiagnostics => ({
  agent: 'claude',
  iteration: 1,
  bridgeSessionId: '2026-09-26_002',
  cliSessionId: '846af024-e8ed-4f81-80dc-cc6276728abc',
  cliSessionIdEvidence: 'CONFIRMED_BY_CLI',
  requestedSessionId: '846af024-e8ed-4f81-80dc-cc6276728abc',
  continuity: 'NOT_APPLICABLE',
  status: 'FAILED',
  errorCode: 'NON_ZERO_EXIT',
  exitCode: 1,
  durationMs: 212805,
  inputSha256: 'a'.repeat(64),
  inputBytes: 321,
  inputDelivery: 'STDIN_FLUSHED_AND_CLOSED',
  finalMessage: null,
  stderrTail: 'Error: something went wrong',
  stdoutTail: '',
  executionFile: '001-claude-execution.json',
  ...over,
});

test('bridge:getExecutionOutput accepts only {runId, iteration 1–999, agent claude|codex, stream stdout|stderr}', () => {
  assert.deepEqual(validateRequest('bridge:getExecutionOutput', { runId: '2026-09-26_001', iteration: 2, agent: 'claude', stream: 'stderr' }), {
    ok: true,
    value: { runId: '2026-09-26_001', iteration: 2, agent: 'claude', stream: 'stderr' },
  });
  for (const bad of [
    undefined,
    { runId: '../x', iteration: 1, agent: 'claude', stream: 'stdout' },
    { runId: '2026-09-26_001', iteration: 0, agent: 'claude', stream: 'stdout' },
    { runId: '2026-09-26_001', iteration: 1000, agent: 'claude', stream: 'stdout' },
    { runId: '2026-09-26_001', iteration: '1', agent: 'claude', stream: 'stdout' },
    { runId: '2026-09-26_001', iteration: 1, agent: 'bash', stream: 'stdout' },
    { runId: '2026-09-26_001', iteration: 1, agent: 'claude', stream: 'transcript' },
    { runId: '2026-09-26_001', iteration: 1, agent: 'claude', stream: 'stdout', path: 'C:\\x' },
  ]) {
    assert.equal(validateRequest('bridge:getExecutionOutput', bad).ok, false, JSON.stringify(bad));
  }
});

test('CLAUDE_RUN_FAILED:NON_ZERO_EXIT keeps the concise code but the message and details carry the real facts', () => {
  const e = describeRunErrorCode('CLAUDE_RUN_FAILED:NON_ZERO_EXIT', 'Error: something went wrong', diag());
  assert.equal(e.code, 'CLAUDE_RUN_FAILED:NON_ZERO_EXIT');
  assert.equal(e.message, 'Claude CLI kết thúc với exit code 1.');
  const d = e.details ?? '';
  for (const expected of [
    'CLAUDE_RUN_FAILED:NON_ZERO_EXIT',
    'Bridge session: 2026-09-26_002',
    'Iteration: 001',
    'Claude CLI session: 846af024-e8ed-4f81-80dc-cc6276728abc (confirmed by the CLI)',
    'Exit code: 1',
    'Duration: 212805ms',
    `Prompt SHA-256: ${'a'.repeat(64)}`,
    'Stdin delivery: STDIN_FLUSHED_AND_CLOSED',
    'stderr (tail):',
    'Error: something went wrong',
  ]) {
    assert.ok(d.includes(expected), `missing "${expected}" in:\n${d}`);
  }
});

test('an unconfirmed or unknown session id is labelled as such — never presented as confirmed', () => {
  assert.match(formatDiagnostics(diag({ cliSessionIdEvidence: 'REQUESTED_NOT_CONFIRMED' })), /NOT confirmed by the CLI/);
  assert.match(formatDiagnostics(diag({ cliSessionId: null, cliSessionIdEvidence: 'UNKNOWN' })), /Claude CLI session: UNKNOWN \(UNKNOWN/);
});

test('a resume the CLI answered with a different session id is shown as MISMATCH — never as "confirmed" (real CLI behaviour)', () => {
  const text = formatDiagnostics(diag({ requestedSessionId: '00000000-0000-4000-8000-000000000000', cliSessionId: 'fbb86439-0faa-46ca-ab65-5bada57a6a61', continuity: 'MISMATCH' }));
  assert.match(text, /resume of 00000000-0000-4000-8000-000000000000 requested — the CLI reported fbb86439-0faa-46ca-ab65-5bada57a6a61 instead \(continuity MISMATCH/);
  assert.doesNotMatch(text, /confirmed by the CLI/);
  assert.match(formatDiagnostics(diag({ continuity: 'VERIFIED' })), /resume continuity VERIFIED/);
});

test('REPORT_INVALID after a clean Claude exit explains it and shows Claude\'s final message (the "answered in chat" case)', () => {
  const e = describeRunErrorCode(
    'REPORT_INVALID',
    'REPORT_MISSING: Report file not found or unreadable: D:\\p\\.ai-bridge\\reports\\001-report.md',
    diag({ status: 'COMPLETED', errorCode: null, exitCode: 0, stderrTail: '', finalMessage: 'Đây là báo cáo toàn diện… Bạn muốn bắt đầu từ phần nào?' }),
  );
  assert.equal(e.title, 'Report không hợp lệ');
  assert.match(e.message, /exit code 0\) nhưng không ghi file report/);
  assert.match(e.details ?? '', /Claude final message \(tail\):\nĐây là báo cáo toàn diện/);
});

test('describeRunOutcome passes Core diagnostics through; outcomes without diagnostics still work', () => {
  const base = {
    kind: 'COMPLETED' as const,
    finalStatus: 'ERROR' as const,
    iterations: 1,
    sessionDir: 'x',
    claudeSessionId: null,
    codexThreadId: null,
    doctorReport: { checks: [], overall: 'PASS' as const },
  };
  const withDiag = describeRunOutcome({ ...base, errorCode: 'CODEX_RUN_FAILED:TIMEOUT', errorMessage: null, diagnostics: diag({ agent: 'codex', status: 'TIMEOUT', errorCode: 'TIMEOUT', exitCode: null }) });
  assert.equal(withDiag?.title, 'Process timeout');
  assert.match(withDiag?.details ?? '', /Codex CLI thread: /);
  const without = describeRunOutcome({ ...base, errorCode: 'REPORT_INVALID', errorMessage: 'BAD_HEADER', diagnostics: null });
  assert.equal(without?.details, 'REPORT_INVALID\nBAD_HEADER');
});

test('extended redaction: JSON credential keys, cookies and authorization headers — while ordinary CLI output stays intact', () => {
  const out = redactSecrets(
    '{"accessToken":"tok-123","refresh_token": "r-456","api_key":"k-789","password":"hunter2"}\nCookie: session=abc; other=def\nAuthorization: Basic dXNlcjpwYXNz\nSet-Cookie: sid=xyz',
  );
  for (const secret of ['tok-123', 'r-456', 'k-789', 'hunter2', 'session=abc', 'dXNlcjpwYXNz', 'sid=xyz']) assert.ok(!out.includes(secret), secret);
  const normal = '{"type":"result","session_id":"846af024-e8ed-4f81-80dc-cc6276728abc","usage":{"input_tokens":12,"output_tokens":34}}';
  assert.equal(redactSecrets(normal), normal);
});
