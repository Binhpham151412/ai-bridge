import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ANTIGRAVITY_PERMISSION_CAPABILITY,
  AntigravityCliAdapter,
  MAX_ARGV_PROMPT_CHARS,
  agyLogErrors,
  antigravityPermissionArgs,
  argvCostOf,
  parseAgyLog,
} from '../src/adapters/antigravity/antigravity-cli-adapter.ts';

// docs/65 — fake agy only (it mirrors the behaviour observed on the real CLI).

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-agy/fake-agy.mjs', import.meta.url));
const NEW_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

const adapter = () => new AntigravityCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLI] });
const base = { cwd: process.cwd(), prompt: 'Do the thing', timeoutMs: 5000 };
const env = (m: string, extra: Record<string, string> = {}) => ({ ...process.env, FAKE_AGY_MODE: m, ...extra });
const tmpAgyLogs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('ai-bridge-agy-'));

test('a NEW conversation: the id comes from agy\'s log, the prompt is an argument, stdin carries nothing', async () => {
  const r = await adapter().run({ ...base, sessionId: null, resume: false });
  assert.equal(r.ok, true);
  assert.equal(r.errorCode, null);
  assert.equal(r.sessionId, NEW_ID);
  assert.equal(r.reportedSessionId, NEW_ID);
  assert.equal(r.inputChannel, 'argv');
  assert.equal(r.finalMessage, 'done');
  assert.equal(r.args[r.args.indexOf('-p') + 1], 'Do the thing');
  assert.ok(!r.args.includes('--conversation'));
  assert.equal(r.promptDelivered, true, 'the process started with the prompt in its command line');
  assert.equal(r.promptBytes, Buffer.byteLength('Do the thing', 'utf8'));
});

test('the report contract is put in front of the prompt (agy has no system-prompt flag), prompt text untouched', async () => {
  const prompt = 'Sửa lỗi:\n\n   giữ nguyên "dấu nháy" và \\ ngược';
  const r = await adapter().run({ ...base, prompt, sessionId: null, resume: false, appendSystemPrompt: 'THE-CONTRACT', env: env('ok', { FAKE_AGY_ECHO: '1' }) });
  assert.equal(r.ok, true);
  const echoed = JSON.parse(/^PROMPT:(.*)$/m.exec(r.stdout)![1]) as string;
  assert.equal(echoed, `THE-CONTRACT\n\n---\n\n${prompt}`, 'newlines, Vietnamese, quotes and backslashes arrive byte for byte');
  assert.equal(r.promptBytes, Buffer.byteLength(echoed, 'utf8'));
});

test('a RESUME passes --conversation and is accepted only when the log shows that very id and no new conversation', async () => {
  const r = await adapter().run({ ...base, sessionId: NEW_ID, resume: true });
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, NEW_ID);
  assert.equal(r.args[r.args.indexOf('--conversation') + 1], NEW_ID);
});

test('an unknown conversation id silently starts a NEW one under exit 0 — that is SESSION_MISMATCH, with the new id reported', async () => {
  const r = await adapter().run({ ...base, sessionId: 'bbbbbbbb-0000-4000-8000-0000000000ff', resume: true, env: env('unknown-conversation') });
  assert.equal(r.exitCode, 0);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'SESSION_MISMATCH');
  assert.equal(r.reportedSessionId, NEW_ID);
  assert.match(r.stderr, /not found/);
});

test('permission policy becomes a flag; --print-timeout follows the step timeout (agy defaults to 5 minutes)', async () => {
  const bypass = await adapter().run({ ...base, sessionId: null, resume: false, permissionPolicy: 'bypass', timeoutMs: 1_800_000 });
  assert.ok(bypass.args.includes('--dangerously-skip-permissions'));
  assert.equal(bypass.args[bypass.args.indexOf('--print-timeout') + 1], '1800s');
  const ask = await adapter().run({ ...base, sessionId: null, resume: false, permissionPolicy: 'ask' });
  assert.ok(!ask.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(antigravityPermissionArgs('bypass'), ['--dangerously-skip-permissions']);
  assert.deepEqual(antigravityPermissionArgs('ask'), []);
  assert.throws(() => antigravityPermissionArgs('yolo' as never), /Unsupported Antigravity permission policy/);
  assert.deepEqual(ANTIGRAVITY_PERMISSION_CAPABILITY.modes.map((m) => m.policy), ['ask', 'bypass']);
});

test('no model flag exists: a model option is never sent, and the model comes from agy\'s log', async () => {
  const r = await adapter().run({ ...base, sessionId: null, resume: false, model: 'whatever' });
  assert.ok(!r.args.includes('--model') && !r.args.includes('whatever'));
  assert.equal(r.reportedModel, 'Fake Model 1 (Thinking)');
  assert.equal(adapter().findReportedModel(), null);
});

test('failures are distinct error codes: non-zero exit (with the log\'s error lines), error text on stdout, no log, timeout', async () => {
  const exit = await adapter().run({ ...base, sessionId: null, resume: false, env: env('error-exit') });
  assert.equal(exit.errorCode, 'NON_ZERO_EXIT');
  assert.match(exit.stderr, /error: not logged in/);
  assert.match(exit.stderr, /--- agy log \(errors\) ---\nE1013 .*Failed to get OAuth token/, 'the reason that only the log carries is kept');
  const out = await adapter().run({ ...base, sessionId: null, resume: false, env: env('stdout-error') });
  assert.equal(out.errorCode, 'CLI_REPORTED_ERROR');
  assert.equal(out.finalMessage, 'error: model quota exceeded');
  assert.equal((await adapter().run({ ...base, sessionId: null, resume: false, env: env('no-log') })).errorCode, 'NO_SESSION_ID');
  const slow = await adapter().run({ ...base, sessionId: null, resume: false, timeoutMs: 400, env: env('hang') });
  assert.equal(slow.errorCode, 'TIMEOUT');
});

test('a prompt that cannot fit on a command line is refused before anything is spawned', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-agy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'argv.jsonl');
  const r = await adapter().run({ ...base, prompt: 'x'.repeat(MAX_ARGV_PROMPT_CHARS + 1), sessionId: null, resume: false, env: env('ok', { FAKE_AGY_LOG: log }) });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'INPUT_TOO_LARGE');
  assert.equal(r.pid, null);
  assert.equal(r.promptDelivered, false);
  assert.match(r.stderr, /Nothing was started/);
  assert.equal(existsSync(log), false, 'the CLI was never started');
  // quotes and backslashes are escaped on the command line, so they count twice
  assert.equal(argvCostOf('a"b\\c'), 7);
  const quoted = await adapter().run({ ...base, prompt: '"'.repeat(MAX_ARGV_PROMPT_CHARS / 2 + 1), sessionId: null, resume: false });
  assert.equal(quoted.errorCode, 'INPUT_TOO_LARGE');
  const fits = await adapter().run({ ...base, prompt: 'y'.repeat(20_000), sessionId: null, resume: false });
  assert.equal(fits.ok, true, 'a 20 000-character task (the app\'s maximum) plus a contract fits');
});

test('a resume without a conversation id is refused', async () => {
  await assert.rejects(() => adapter().run({ ...base, sessionId: null, resume: true }), /cannot resume without a conversation id/);
});

test('agy\'s own log file is never left behind', async () => {
  const before = tmpAgyLogs().length;
  await adapter().run({ ...base, sessionId: null, resume: false });
  await adapter().run({ ...base, sessionId: null, resume: false, env: env('error-exit') });
  assert.equal(tmpAgyLogs().length, before);
});

test('log parsing: created vs started ids, the last model label, only error-level lines', () => {
  const log = readFileSync(fileURLToPath(new URL('./fixtures/fake-agy/sample-agy.log', import.meta.url)), 'utf8');
  assert.deepEqual(parseAgyLog(log), { created: '317b65d8-cb2d-4d98-8496-8726e4ddc9f4', started: null, model: 'Claude Sonnet 4.6 (Thinking)' });
  assert.deepEqual(parseAgyLog('Print mode: starting (promptLength=92, model="", conversationID="b413f242-8961-4c05-baec-4fbd27b7591b")'), {
    created: null,
    started: 'b413f242-8961-4c05-baec-4fbd27b7591b',
    model: null,
  });
  assert.deepEqual(parseAgyLog('Print mode: starting (promptLength=2, model="", conversationID="")'), { created: null, started: null, model: null });
  assert.equal(agyLogErrors(log), 'E1013 21:41:15.967522 23324 log.go:398] Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.');
  assert.equal(agyLogErrors('I only info\nW a warning'), '');
});
