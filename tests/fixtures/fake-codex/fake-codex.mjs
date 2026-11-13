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
//   done-at             - M4.2: reads "ITERATION:" from the reviewer input; responds DONE
//                       once it is >= FAKE_CODEX_DONE_AT (default 1), else CONTINUE with
//                       "Round <n+1> instruction." (FAKE_CODEX_DONE_AT=never → always CONTINUE).
//                       FAKE_CODEX_NARRATIVE=1 adds a Markdown review outside the block.
//
// FAKE_CODEX_RESPONSE - the agent_message text to emit (defaults to a canned
// <AI_BRIDGE_RESPONSE> block so adapter-level tests don't need to build one).
//
// Round 6 (the judge's read-only isolation) - what the installed codex 0.167 answers without a model:
//   `exec --help`          the flag list (FAKE_CODEX_OMIT_FLAG=<flag> drops one; FAKE_CODEX_NO_READ_ONLY=1 drops the
//                          read-only sandbox value),
//   `features list`        a feature table (FAKE_CODEX_FEATURES=fail exits 1, garbage = another format,
//                          no-<name> leaves one feature out),
//   `debug prompt-input`   the tool namespaces the model would see: FAKE_CODEX_TOOLS (default
//                          functions,clock,collaboration) plus one `mcp__<name>` per [mcp_servers.<name>] of
//                          $CODEX_HOME/config.toml (FAKE_CODEX_PROMPT_INPUT=fail|garbage),
//   `exec` without --ignore-user-config  loads (= starts) every MCP server of $CODEX_HOME/config.toml and calls
//                          the one a prompt names with CALL_TOOL:<name>, like codex does with the user's config.
// FAKE_CODEX_LOG=<file> gets one JSON line per call: {argv, home}.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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

if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: args, home: process.env.CODEX_HOME ?? null }) + '\n');
}

/** The [mcp_servers.<name>] tables of $CODEX_HOME/config.toml: { name, command, args }. */
function userMcpServers() {
  let text = '';
  try {
    text = readFileSync(`${process.env.CODEX_HOME}/config.toml`, 'utf8');
  } catch {
    return [];
  }
  const servers = [];
  for (const block of text.split(/^\[mcp_servers\./m).slice(1)) {
    const name = block.slice(0, block.indexOf(']'));
    const command = /^command\s*=\s*(".*")\s*$/m.exec(block);
    const argList = /^args\s*=\s*\[(.*)\]\s*$/m.exec(block);
    servers.push({ name, command: command ? JSON.parse(command[1]) : null, args: argList ? JSON.parse(`[${argList[1]}]`) : [] });
  }
  return servers;
}

if (args[0] === 'exec' && args.includes('--help')) {
  const omit = process.env.FAKE_CODEX_OMIT_FLAG;
  const lines = [
    ['-c', '--config <key=value>', '--config'],
    [null, '--disable <FEATURE>', '--disable'],
    ['-s', process.env.FAKE_CODEX_NO_READ_ONLY ? '--sandbox <SANDBOX_MODE>\n          [possible values: workspace-write, danger-full-access]' : '--sandbox <SANDBOX_MODE>\n          [possible values: read-only, workspace-write, danger-full-access]', '--sandbox'],
    [null, '--skip-git-repo-check', '--skip-git-repo-check'],
    [null, '--ephemeral', '--ephemeral'],
    [null, '--ignore-user-config', '--ignore-user-config'],
    [null, '--ignore-rules', '--ignore-rules'],
    [null, '--json', '--json'],
    ['-o', '--output-last-message <FILE>', '--output-last-message'],
  ].filter(([, , flag]) => flag !== omit);
  process.stdout.write('Run Codex non-interactively\n\nUsage: codex exec [OPTIONS] [PROMPT]\n\nOptions:\n');
  for (const [short, long] of lines) process.stdout.write(`  ${short ? `${short}, ` : '    '}${long}\n`);
  process.exit(0);
}
if (args[0] === 'features' && args[1] === 'list') {
  if (process.env.FAKE_CODEX_FEATURES === 'fail') {
    process.stderr.write('fake-codex: features list failed\n');
    process.exit(1);
  }
  const how = process.env.FAKE_CODEX_FEATURES ?? '';
  if (how === 'garbage') {
    process.stdout.write('apps (stable): enabled\nplugins (stable): enabled\n'); // a table in another format
    process.exit(0);
  }
  const names = ['apps', 'plugins', 'remote_plugin', 'skill_mcp_dependency_install', 'hooks', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'skill_search', 'tool_suggest', 'fast_mode', 'goals'];
  for (const name of names.filter((n) => how !== `no-${n}`)) {
    process.stdout.write(`${name.padEnd(40)} stable             true\n`);
  }
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'prompt-input') {
  const how = process.env.FAKE_CODEX_PROMPT_INPUT;
  if (how === 'fail') process.exit(1);
  if (how === 'garbage') {
    process.stdout.write('not json\n');
    process.exit(0);
  }
  const names = (process.env.FAKE_CODEX_TOOLS ?? 'functions,clock,collaboration').split(',').filter(Boolean);
  for (const server of userMcpServers()) names.push(`mcp__${server.name}`);
  const tools = names.map((name) => ({ type: 'namespace', name, description: '', tools: [{ type: 'function', name: 'x' }] }));
  process.stdout.write(JSON.stringify([{ type: 'additional_tools', id: 'tools', role: 'developer', tools }, { type: 'message', role: 'user', content: [] }]) + '\n');
  process.exit(0);
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
  if (args[0] === 'exec' && !args.includes('--ignore-user-config')) {
    for (const server of userMcpServers()) {
      if (server.command === null) continue;
      spawnSync(server.command, server.args, { stdio: 'ignore' }); // codex starts the configured servers...
      if (stdin.includes(`CALL_TOOL:${server.name}`)) spawnSync(server.command, [...server.args, '--call'], { stdio: 'ignore' }); // ...and the model may call them
    }
  }
  let responseText = process.env.FAKE_CODEX_RESPONSE ?? '<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nDo the next thing.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
  if (mode === 'sequence') {
    responseText = isResume
      ? '<AI_BRIDGE_RESPONSE>\n<STATUS>DONE</STATUS>\n<PROMPT>\nNo further action needed.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n'
      : '<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nSửa `src/sum.js` để throw TypeError khi tham số không phải number.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
  }

  if (mode === 'done-at') {
    const m = /ITERATION:\s*(\d+)/.exec(stdin);
    const n = m ? Number(m[1]) : 0;
    const doneAt = process.env.FAKE_CODEX_DONE_AT === 'never' ? Infinity : Number(process.env.FAKE_CODEX_DONE_AT ?? '1');
    const done = n >= doneAt;
    const narrative = process.env.FAKE_CODEX_NARRATIVE === '1'
      ? `## Summary
Round ${n} reviewed (fake).

## Problems Found
none (fake)

## Development Phase
Phase ${n} (fake)

`
      : '';
    responseText = `${narrative}<AI_BRIDGE_RESPONSE>
<STATUS>${done ? 'DONE' : 'CONTINUE'}</STATUS>
<PROMPT>
${done ? 'No further action needed.' : `Round ${n + 1} instruction.`}
</PROMPT>
</AI_BRIDGE_RESPONSE>
`;
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
