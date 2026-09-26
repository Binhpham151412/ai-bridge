#!/usr/bin/env node
// Fake `claude` CLI for tests. Mimics just enough of `claude -p --output-format
// stream-json` to exercise ClaudeCodeCliAdapter without spending real quota.
//
// Behaviour is selected by the FAKE_CLAUDE_MODE env var:
//   ok               - normal run: reads stdin, emits stream-json init/result
//                       events echoing back the --session-id/--resume flag,
//                       writes a report file (see below), exits 0.
//   error-exit        - exits 1 without emitting a result event.
//   bad-json           - emits one line of invalid JSON, then exits 0.
//   no-session-id      - emits init/result events with no session_id at all.
//   wrong-session-id   - emits init/result events with a session_id that does
//                       not match the one requested via --session-id/--resume.
//   bad-report          - like "ok", but the written report omits REPORT_STATUS.
//   hang                - never exits (used to test the caller's timeout).
//
// Flags read (mirrors the real `claude -p` CLI):
//   --session-id <uuid>            start a fresh session with this id
//   --resume <uuid>                resume this session id
//   --append-system-prompt <text>  read as REPORT_FILE:/SESSION_ID:/ITERATION:
//                                  lines, simulating Claude following the report
//                                  contract it was told to write to.
//
// Env vars read:
//   FAKE_CLAUDE_REPORT_PATH - overrides REPORT_FILE parsed from --append-system-prompt
//                             (lets adapter-level tests skip building a contract)

import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const resumeId = flagValue('--resume');
const freshId = flagValue('--session-id');
const requestedSessionId = resumeId ?? freshId ?? null;
const resumed = resumeId !== undefined;
const appendSystemPrompt = flagValue('--append-system-prompt');
const permissionMode = flagValue('--permission-mode');
function flagValues(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
}
const allowedTools = flagValues('--allowedTools');
const disallowedTools = flagValues('--disallowedTools');

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sessionIdToReport() {
  if (mode === 'no-session-id') return undefined;
  if (mode === 'wrong-session-id') return '99999999-9999-9999-9999-999999999999';
  return requestedSessionId ?? undefined;
}

/** Reads REPORT_FILE:/SESSION_ID:/ITERATION: out of the report contract text, the
 * way a real Claude session would follow written instructions. */
function readContract() {
  let reportFile = process.env.FAKE_CLAUDE_REPORT_PATH;
  let sessionId = requestedSessionId;
  let iteration = '1';
  if (appendSystemPrompt) {
    reportFile = reportFile ?? /^REPORT_FILE:\s*(.+)$/m.exec(appendSystemPrompt)?.[1]?.trim();
    sessionId = /^SESSION_ID:\s*(.+)$/m.exec(appendSystemPrompt)?.[1]?.trim() ?? sessionId;
    iteration = /^ITERATION:\s*(\d+)$/m.exec(appendSystemPrompt)?.[1]?.trim() ?? iteration;
  }
  return { reportFile, sessionId, iteration };
}

// FAKE_CLAUDE_DELAY_MS: simulate a slow Claude run (blocks before doing anything) so a
// test can land a pause/stop request while Claude is genuinely mid-execution.
const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);

if (mode === 'hang') {
  setInterval(() => {}, 1_000_000);
} else if (mode === 'error-exit') {
  readStdin();
  emit({ type: 'system', subtype: 'init', session_id: sessionIdToReport(), resumed });
  process.stderr.write('fake-claude: simulated crash\n');
  process.exit(1);
} else if (mode === 'bad-json') {
  readStdin();
  process.stdout.write('{not valid json\n');
  process.exit(0);
} else {
  const prompt = readStdin();
  const { reportFile, sessionId, iteration } = readContract();
  if (reportFile) {
    const statusLine = mode === 'bad-report' ? '' : 'REPORT_STATUS: COMPLETE\n';
    writeFileSync(
      reportFile,
      `# AI Bridge Report\n\nSESSION_ID: ${sessionId}\nITERATION: ${iteration}\n${statusLine}NEXT_ACTION: CONTINUE\n\n## TASK\n(fake) task executed\n\n## CHANGES\n- none (fake)\n\n## TESTS\nnone\n\n## ISSUES\nnone\n\n## NEXT_RECOMMENDATION\nnone\n`,
      'utf8',
    );
  }
  emit({ type: 'system', subtype: 'init', session_id: sessionIdToReport(), resumed });
  emit({ type: 'debug_stdin', text: prompt });
  if (appendSystemPrompt !== undefined) emit({ type: 'debug_system_prompt', text: appendSystemPrompt });
  if (permissionMode !== undefined) emit({ type: 'debug_permission_mode', text: permissionMode });
  if (allowedTools !== undefined) emit({ type: 'debug_allowed_tools', tools: allowedTools });
  if (disallowedTools !== undefined) emit({ type: 'debug_disallowed_tools', tools: disallowedTools });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionIdToReport(), num_turns: 1 });
  process.exit(0);
}
