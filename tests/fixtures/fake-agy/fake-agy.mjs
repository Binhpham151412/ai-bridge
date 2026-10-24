#!/usr/bin/env node
// Fake `agy` (Antigravity CLI) for tests. Mirrors what was observed on the real CLI (1.3.4):
//  - `-p <prompt>`: the prompt is an ARGUMENT; stdin is ignored. stdout is only the answer text.
//  - the conversation id and model exist only in the log file named by --log-file:
//      "Created conversation <uuid>" for a new conversation,
//      `Print mode: starting (… conversationID="<uuid>")` for a real resume.
//  - an unknown --conversation prints a warning on stderr, is ignored, and a NEW conversation is created (exit 0).
//  - failures are `error: …` on stderr with exit code 1.
//
// FAKE_AGY_MODE: ok | unknown-conversation | error-exit | no-log | answer-in-chat | stdout-error | hang
// FAKE_AGY_LOG: if set, the argv of every call is appended to this file as a JSON line.
import { appendFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_AGY_MODE || 'ok';
const args = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ argv: args }) + '\n');

const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const prompt = value('-p');
const logFile = value('--log-file');
const conversation = value('--conversation');
const NEW_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

if (mode === 'hang') {
  setInterval(() => {}, 1_000_000);
} else if (prompt === undefined || prompt === '') {
  process.stderr.write('error: Error: empty prompt. Usage: agy --print "your prompt here"\n');
  process.exit(1);
} else if (mode === 'error-exit') {
  if (logFile) writeFileSync(logFile, 'E1013 21:41:15.967522 1 server.go:609] Failed to get OAuth token: You are not logged into Antigravity.\n');
  process.stderr.write('error: not logged in\n');
  process.exit(1);
} else {
  const knownResume = conversation !== undefined && conversation.startsWith('aaaaaaaa-');
  const lines = ['I1013 21:41:16.000000 1 printmode.go:1] some unrelated line', 'W1013 21:41:16.100000 1 x.go:1] Cache failed: not logged in (a warning, not an error)'];
  lines.push('I1013 21:41:17.743273 1 model_config_manager.go:157] Propagating selected model override to backend: label="Fake Model 1 (Thinking)"');
  let id;
  if (conversation !== undefined && !knownResume) {
    process.stderr.write(`warning: conversation "${conversation}" not found\n`);
    lines.push(`W1013 21:41:50.128258 1 projectresolve.go:63] Conversation ${conversation} not found, ignoring --conversation flag`);
    lines.push('I1013 21:41:50.128258 1 printmode.go:202] Print mode: starting (promptLength=2, model="", conversationID="")');
    id = NEW_ID;
    lines.push(`I1013 21:41:52.378237 1 server.go:1219] Created conversation ${id}`);
  } else if (knownResume) {
    id = conversation;
    lines.push(`I1013 21:42:43.491222 1 printmode.go:202] Print mode: starting (promptLength=${prompt.length}, model="", conversationID="${id}")`);
  } else {
    id = NEW_ID;
    lines.push(`I1013 21:41:16.010174 1 printmode.go:71] Print mode: starting (promptLength=${prompt.length}, model="", conversationID="")`);
    lines.push(`I1013 21:41:18.538905 1 server.go:755] Created conversation ${id}`);
  }
  if (mode === 'ok' || mode === 'unknown-conversation' || mode === 'answer-in-chat' || mode === 'stdout-error') {
    const reportFile = /^REPORT_FILE:\s*(.+)$/m.exec(prompt)?.[1]?.trim();
    const reportSession = /^SESSION_ID:\s*(.+)$/m.exec(prompt)?.[1]?.trim();
    const iteration = /^ITERATION:\s*(\d+)$/m.exec(prompt)?.[1]?.trim() ?? '1';
    if (reportFile && mode !== 'answer-in-chat' && mode !== 'stdout-error') {
      writeFileSync(
        reportFile,
        `# AI Bridge Report\n\nSESSION_ID: ${reportSession}\nITERATION: ${iteration}\nREPORT_STATUS: COMPLETE\nNEXT_ACTION: CONTINUE\n\n## TASK\n(fake agy) task executed\n\n## CHANGES\n- none (fake)\n\n## TESTS\nnone\n\n## ISSUES\nnone\n\n## NEXT_RECOMMENDATION\nnone\n`,
        'utf8',
      );
    }
  }
  if (mode !== 'no-log' && logFile) writeFileSync(logFile, lines.join('\n') + '\n');
  // Proof for tests of what actually arrived: the prompt and the flags (not part of real agy output).
  const answer = mode === 'answer-in-chat' ? 'Could you clarify what step 7 was?' : mode === 'stdout-error' ? 'error: model quota exceeded' : 'done';
  process.stdout.write(`${answer}\n`);
  if (process.env.FAKE_AGY_ECHO === '1') process.stdout.write(`ARGS:${JSON.stringify(args.filter((a) => a !== prompt))}\nPROMPT:${JSON.stringify(prompt)}\n`);
  process.exit(0);
}
