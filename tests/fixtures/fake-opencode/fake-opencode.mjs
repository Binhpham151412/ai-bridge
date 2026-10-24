#!/usr/bin/env node
// Fake `opencode` CLI for tests. Mimics just enough of `opencode run --format json` to
// exercise OpenCodeCliAdapter without spending real quota.
//
// Facts mirrored from the real opencode 1.14.30: the message is read from piped stdin; a NEW
// session gets an id the CLI creates (`ses_…`); every event carries `sessionID`; a failed run
// still exits 0 and reports the failure only as a `{"type":"error",…}` event.
//
// Behaviour is selected by FAKE_OPENCODE_MODE:
//   ok               - writes the report named by the contract in stdin, emits step_start / text /
//                      step_finish events, exits 0.
//   error-event      - emits an `error` event (APIError) and exits 0, no report.
//   error-exit       - exits 1 after an event.
//   no-json          - prints plain text only, exits 0.
//   no-session-id    - emits events without `sessionID`.
//   wrong-session-id - emits a sessionID different from the one passed to --session.
//   answer-in-chat   - like ok but writes NO report.
//   hang             - never exits.
// FAKE_OPENCODE_LOG: if set, the argv of every call is appended to this file as a JSON line.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_OPENCODE_MODE || 'ok';
const args = process.argv.slice(2);
if (process.env.FAKE_OPENCODE_LOG) appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify({ argv: args }) + '\n');

function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const resumeId = flagValue('--session');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const readStdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

if (mode === 'hang') {
  setInterval(() => {}, 1_000_000);
} else {
  const input = readStdin();
  const sessionID = mode === 'no-session-id' ? undefined : mode === 'wrong-session-id' ? 'ses_someoneelse' : (resumeId ?? 'ses_fake0001');
  const at = Date.now();
  if (mode === 'no-json') {
    process.stdout.write('opencode: a plain-text notice\n');
  } else if (mode === 'error-event') {
    emit({ type: 'error', timestamp: at, sessionID, error: { name: 'APIError', data: { message: 'Not Found', statusCode: 404, isRetryable: false } } });
  } else if (mode === 'error-exit') {
    emit({ type: 'step_start', timestamp: at, sessionID, part: { type: 'step-start' } });
    process.stderr.write('fake-opencode: simulated crash\n');
    process.exit(1);
  } else {
    const reportFile = /^REPORT_FILE:\s*(.+)$/m.exec(input)?.[1]?.trim();
    const reportSession = /^SESSION_ID:\s*(.+)$/m.exec(input)?.[1]?.trim();
    const iteration = /^ITERATION:\s*(\d+)$/m.exec(input)?.[1]?.trim() ?? '1';
    if (reportFile && mode !== 'answer-in-chat') {
      writeFileSync(
        reportFile,
        `# AI Bridge Report\n\nSESSION_ID: ${reportSession}\nITERATION: ${iteration}\nREPORT_STATUS: COMPLETE\nNEXT_ACTION: CONTINUE\n\n## TASK\n(fake opencode) task executed\n\n## CHANGES\n- none (fake)\n\n## TESTS\nnone\n\n## ISSUES\nnone\n\n## NEXT_RECOMMENDATION\nnone\n`,
        'utf8',
      );
    }
    emit({ type: 'step_start', timestamp: at, sessionID, part: { type: 'step-start' } });
    // Proof for tests of what actually arrived on stdin and in argv.
    emit({ type: 'debug_stdin', sessionID, text: input });
    emit({ type: 'debug_args', sessionID, args });
    emit({ type: 'text', timestamp: at, sessionID, part: { type: 'text', text: mode === 'answer-in-chat' ? 'Could you clarify what step 7 was?' : 'done' } });
    emit({ type: 'step_finish', timestamp: at, sessionID, part: { type: 'step-finish', reason: 'stop' } });
  }
  process.exit(0);
}
