import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OPENCODE_PERMISSION_CAPABILITY,
  OpenCodeCliAdapter,
  buildOpenCodeInput,
  findOpenCodeError,
  findOpenCodeFinalMessage,
  findReportedOpenCodeSessionId,
  opencodePermissionArgs,
} from '../src/adapters/opencode/opencode-cli-adapter.ts';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-opencode/fake-opencode.mjs', import.meta.url));

const adapter = () => new OpenCodeCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLI] });
const base = { cwd: process.cwd(), prompt: 'Do the thing', timeoutMs: 5000 };
const mode = (m: string) => ({ ...process.env, FAKE_OPENCODE_MODE: m });

test('a NEW session: no id is sent, the CLI creates one and it is reported back', async () => {
  const r = await adapter().run({ ...base, sessionId: null, resume: false });
  assert.equal(r.ok, true);
  assert.equal(r.errorCode, null);
  assert.equal(r.sessionId, 'ses_fake0001');
  assert.equal(r.reportedSessionId, 'ses_fake0001');
  assert.ok(!r.args.includes('--session'), 'a fresh run must not pass --session');
  assert.deepEqual(r.args.slice(-3), ['run', '--format', 'json']);
});

test('a RESUME passes --session <id> and the same id must come back', async () => {
  const r = await adapter().run({ ...base, sessionId: 'ses_abc', resume: true });
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, 'ses_abc');
  assert.equal(r.args[r.args.indexOf('--session') + 1], 'ses_abc');
});

test('a resume that the CLI answers from a different session is SESSION_MISMATCH', async () => {
  const r = await adapter().run({ ...base, sessionId: 'ses_abc', resume: true, env: mode('wrong-session-id') });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'SESSION_MISMATCH');
  assert.equal(r.reportedSessionId, 'ses_someoneelse');
});

test('the prompt goes over stdin, with the report contract in front of it (no separate system-prompt flag exists)', async () => {
  const prompt = 'Sửa lỗi:\n\n   giữ nguyên thụt lề';
  const r = await adapter().run({ ...base, prompt, sessionId: null, resume: false, appendSystemPrompt: 'THE-REPORT-CONTRACT' });
  assert.equal(r.ok, true);
  const stdin = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'debug_stdin').text as string;
  assert.equal(stdin, buildOpenCodeInput(prompt, 'THE-REPORT-CONTRACT'));
  assert.ok(stdin.startsWith('THE-REPORT-CONTRACT'));
  assert.ok(stdin.endsWith('giữ nguyên thụt lề'));
  assert.equal(r.promptDelivered, true);
  assert.equal(r.promptBytes, Buffer.byteLength(stdin, 'utf8'));
  assert.equal(buildOpenCodeInput('only the prompt', undefined), 'only the prompt');
});

test('permission policy and model become flags; nothing is sent when they are omitted', async () => {
  const withFlags = await adapter().run({ ...base, sessionId: null, resume: false, permissionPolicy: 'bypass', model: 'anthropic/claude-opus-5-5' });
  assert.ok(withFlags.args.includes('--dangerously-skip-permissions'));
  assert.equal(withFlags.args[withFlags.args.indexOf('--model') + 1], 'anthropic/claude-opus-5-5');
  const ask = await adapter().run({ ...base, sessionId: null, resume: false, permissionPolicy: 'ask' });
  assert.ok(!ask.args.includes('--dangerously-skip-permissions'));
  assert.ok(!ask.args.includes('--model'));
  assert.deepEqual(opencodePermissionArgs('bypass'), ['--dangerously-skip-permissions']);
  assert.deepEqual(opencodePermissionArgs('ask'), []);
  assert.throws(() => opencodePermissionArgs('yolo' as never), /Unsupported OpenCode permission policy/);
  assert.deepEqual(OPENCODE_PERMISSION_CAPABILITY.modes.map((m) => m.policy), ['ask', 'bypass']);
});

test('exit code 0 with an error event is CLI_REPORTED_ERROR (the real CLI does this), with the message kept', async () => {
  const r = await adapter().run({ ...base, sessionId: null, resume: false, env: mode('error-event') });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 0);
  assert.equal(r.errorCode, 'CLI_REPORTED_ERROR');
  assert.equal(r.finalMessage, 'APIError: Not Found');
});

test('failures are distinct error codes: non-zero exit, no JSON at all, no session id, timeout', async () => {
  assert.equal((await adapter().run({ ...base, sessionId: null, resume: false, env: mode('error-exit') })).errorCode, 'NON_ZERO_EXIT');
  assert.equal((await adapter().run({ ...base, sessionId: null, resume: false, env: mode('no-json') })).errorCode, 'BAD_JSON');
  assert.equal((await adapter().run({ ...base, sessionId: null, resume: false, env: mode('no-session-id') })).errorCode, 'NO_SESSION_ID');
  const slow = await adapter().run({ ...base, sessionId: null, resume: false, timeoutMs: 300, env: mode('hang') });
  assert.equal(slow.errorCode, 'TIMEOUT');
  assert.equal(slow.timedOut, true);
});

test('a resume without a session id is refused before anything is spawned', async () => {
  await assert.rejects(() => adapter().run({ ...base, sessionId: null, resume: true }), /cannot resume without a session id/);
});

test('the stream parsers are tolerant: plain lines are skipped, nothing is invented', () => {
  const out = [
    'plain notice',
    '{"type":"step_start","sessionID":"ses_1"}',
    '{broken',
    '{"type":"text","sessionID":"ses_1","part":{"text":"a"}}',
    '{"type":"step_start","sessionID":"ses_1"}',
    '{"type":"text","sessionID":"ses_1","part":{"text":"final "}}',
    '{"type":"text","sessionID":"ses_1","part":{"text":"words"}}',
  ].join('\n');
  assert.equal(findReportedOpenCodeSessionId(out), 'ses_1');
  assert.equal(findOpenCodeFinalMessage(out), 'final words');
  assert.equal(findOpenCodeError(out), null);
  assert.equal(findReportedOpenCodeSessionId('nothing here'), null);
  // The id is passed back as `--session <id>`: anything that could read as a flag or a path is not an id.
  for (const bad of ['--model', '-s', 'a b', '', '../x', 'x'.repeat(200)]) {
    assert.equal(findReportedOpenCodeSessionId(JSON.stringify({ type: 'step_start', sessionID: bad })), null, JSON.stringify(bad));
  }
  assert.equal(findReportedOpenCodeSessionId(JSON.stringify({ type: 'step_start', sessionID: 'ses_ed6123c9affeBPwJXCl2nvnugt' })), 'ses_ed6123c9affeBPwJXCl2nvnugt');
  assert.equal(findOpenCodeFinalMessage('nothing here'), null);
  assert.equal(findOpenCodeError('{"type":"error","error":{"name":"X"}}'), 'X');
  assert.equal(new OpenCodeCliAdapter({ executable: 'x' }).findReportedModel(), null);
});

test('the argv never contains the prompt (it travels on stdin)', async () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'fake-oc-')), 'argv.jsonl');
  await adapter().run({ ...base, prompt: 'SECRET-PROMPT-TEXT', sessionId: null, resume: false, env: { ...process.env, FAKE_OPENCODE_LOG: log } });
  assert.doesNotMatch(readFileSync(log, 'utf8'), /SECRET-PROMPT-TEXT/);
});
