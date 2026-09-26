#!/usr/bin/env node
// Fake `codex` CLI for tests. Mimics `codex exec --json ... -o <file> -` (and
// `codex exec resume <thread> --json ... -o <file> -`) closely enough to exercise
// CodexCliAdapter without spending real quota.
//
// Behaviour is selected by FAKE_CODEX_MODE:
//   ok                - reads stdin, writes the agent_message text to -o file,
//                       emits thread.started/turn.started/item.completed/turn.completed.
//   error-exit         - exits 1 without a turn.completed event.
//   bad-json            - emits one invalid JSON line, exits 0.
//   no-thread-id        - never emits thread.started (simulates a CLI that can't
//                       confirm which thread this run belongs to).
//   wrong-thread-id     - on `resume`, emits a thread.started with a different id
//                       than the one requested.
//   no-output-file      - emits valid events and exits 0 but never writes -o
//                       (simulates the CLI silently dropping the flag).
//   sequence             - a fresh run responds CONTINUE with a fixed next
//                       instruction; a resumed run responds DONE.
//   hang                - never exits.
//
// FAKE_CODEX_RESPONSE - the agent_message text to emit (defaults to a canned
// <AI_BRIDGE_RESPONSE> block so adapter-level tests don't need to build one).

import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CODEX_MODE || 'ok';
const args = process.argv.slice(2);

// Real invocation is `codex exec resume <id> ...`, so argv[0] is "exec", argv[1] is "resume".
const isResume = args[0] === 'exec' && args[1] === 'resume';
const requestedThreadId = isResume ? args[2] : undefined;
const newThreadId = '11111111-1111-1111-1111-111111111111';

function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const outputPath = flagValue('-o') ?? flagValue('--output-last-message');

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

function threadIdToReport() {
  if (mode === 'no-thread-id') return undefined;
  if (mode === 'wrong-thread-id') return '22222222-2222-2222-2222-222222222222';
  return requestedThreadId ?? newThreadId;
}

if (mode === 'hang') {
  setInterval(() => {}, 1_000_000);
} else if (mode === 'error-exit') {
  readStdin();
  if (mode !== 'no-thread-id') emit({ type: 'thread.started', thread_id: threadIdToReport() });
  process.stderr.write('fake-codex: simulated crash\n');
  process.exit(1);
} else if (mode === 'bad-json') {
  readStdin();
  process.stdout.write('{not valid json\n');
  process.exit(0);
} else {
  const stdin = readStdin();
  let responseText = process.env.FAKE_CODEX_RESPONSE ?? '<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nDo the next thing.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
  if (mode === 'sequence') {
    responseText = isResume
      ? '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nNo further action needed.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n'
      : '<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nSửa `src/sum.js` để throw TypeError khi tham số không phải number.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
  }

  const tid = threadIdToReport();
  if (tid !== undefined) emit({ type: 'thread.started', thread_id: tid });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: responseText } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });

  if (outputPath && mode !== 'no-output-file') writeFileSync(outputPath, responseText, 'utf8');
  process.stderr.write('received:' + Buffer.byteLength(stdin, 'utf8') + '\n');
  process.exit(0);
}
