import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ClaudeCodeCliAdapter } from '../src/adapters/claude/claude-code-cli-adapter.ts';

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-claude/fake-claude.mjs', import.meta.url));

function makeAdapter() {
  return new ClaudeCodeCliAdapter({ executable: process.execPath, commandArgsPrefix: [FAKE_CLI] });
}

test('starts a fresh session and reports back the requested session id', async () => {
  const sessionId = randomUUID();
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'Do the thing', sessionId, resume: false, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.sessionId, sessionId);
  assert.equal(r.errorCode, null);
});

test('resumes an existing session and reports back the same session id', async () => {
  const sessionId = randomUUID();
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'Continue', sessionId, resume: true, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, sessionId);
});

test('passes --session-id for a fresh run and --resume for a resumed run', async () => {
  const adapter = makeAdapter();
  const fresh = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000, env: { FAKE_CLAUDE_MODE: 'ok' } });
  const resumed = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: true, timeoutMs: 5000, env: { FAKE_CLAUDE_MODE: 'ok' } });
  assert.equal(fresh.ok, true);
  assert.equal(resumed.ok, true);
});

test('sends the prompt to the CLI verbatim over stdin', async () => {
  const adapter = makeAdapter();
  const prompt = 'Sửa lỗi ở `src/sum.js`:\n\n```js\nexport const x = 1;\n```\n\n   giữ nguyên thụt lề này';
  const r = await adapter.run({ cwd: process.cwd(), prompt, sessionId: randomUUID(), resume: false, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.receivedPrompt, prompt);
});

test('sends appendSystemPrompt as a separate --append-system-prompt flag, not mixed into stdin', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({
    cwd: process.cwd(),
    prompt: 'Just the prompt.',
    sessionId: randomUUID(),
    resume: false,
    timeoutMs: 5000,
    appendSystemPrompt: 'Write your report to .ai-bridge/reports/001-report.md',
  });
  assert.equal(r.ok, true);
  assert.equal(r.receivedPrompt, 'Just the prompt.');
  assert.equal(r.receivedSystemPrompt, 'Write your report to .ai-bridge/reports/001-report.md');
});

test('reports no system prompt received when appendSystemPrompt is omitted', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.receivedSystemPrompt, null);
});

test('sends permissionMode as a --permission-mode flag', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000, permissionMode: 'acceptEdits' });
  assert.equal(r.ok, true);
  assert.equal(r.receivedPermissionMode, 'acceptEdits');
});

test('reports no permission mode received when permissionMode is omitted', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.receivedPermissionMode, null);
});

test('sends allowedTools and disallowedTools as separate flags', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({
    cwd: process.cwd(),
    prompt: 'x',
    sessionId: randomUUID(),
    resume: false,
    timeoutMs: 5000,
    allowedTools: ['Read', 'Edit', 'Bash(git status)'],
    disallowedTools: ['Bash(git push:*)'],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.receivedAllowedTools, ['Read', 'Edit', 'Bash(git status)']);
  assert.deepEqual(r.receivedDisallowedTools, ['Bash(git push:*)']);
});

test('omits allowedTools/disallowedTools flags entirely when neither is given', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.receivedAllowedTools, null);
  assert.equal(r.receivedDisallowedTools, null);
});

test('forwards onSpawn with the real spawned pid', async () => {
  const adapter = makeAdapter();
  let pid: number | undefined;
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000, onSpawn: (p) => { pid = p; } });
  assert.equal(r.ok, true);
  assert.ok(typeof pid === 'number' && pid > 0);
});

test('reports a non-zero exit code as NON_ZERO_EXIT and ok: false', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000, env: { FAKE_CLAUDE_MODE: 'error-exit' } });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(r.errorCode, 'NON_ZERO_EXIT');
  assert.match(r.stderr, /simulated crash/);
});

test('reports malformed stream-json output as BAD_JSON', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000, env: { FAKE_CLAUDE_MODE: 'bad-json' } });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'BAD_JSON');
});

test('reports a missing session id in the CLI output as SESSION_MISMATCH', async () => {
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000, env: { FAKE_CLAUDE_MODE: 'no-session-id' } });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'SESSION_MISMATCH');
  assert.equal(r.sessionId, null);
});

test('reports a CLI-reported session id that differs from the one requested as SESSION_MISMATCH', async () => {
  const sessionId = randomUUID();
  const adapter = makeAdapter();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId, resume: true, timeoutMs: 5000, env: { FAKE_CLAUDE_MODE: 'wrong-session-id' } });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'SESSION_MISMATCH');
});

test('kills a hanging CLI at timeoutMs and reports TIMEOUT', async () => {
  const adapter = makeAdapter();
  const start = Date.now();
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 300, env: { FAKE_CLAUDE_MODE: 'hang' } });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.errorCode, 'TIMEOUT');
  assert.ok(Date.now() - start < 5000);
});

test('reports SPAWN_FAILED when the executable does not exist', async () => {
  const adapter = new ClaudeCodeCliAdapter({ executable: 'this-binary-does-not-exist-ai-bridge' });
  const r = await adapter.run({ cwd: process.cwd(), prompt: 'x', sessionId: randomUUID(), resume: false, timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'SPAWN_FAILED');
});
