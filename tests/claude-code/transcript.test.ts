import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalReply } from '../../src/claude-code/transcript.ts';

const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { id, role: 'assistant', content }, ...extra });

test('joins the text blocks of the last assistant message, which the transcript splits across records', () => {
  const records = [
    user('fix it'),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    toolResult(),
    assistant('m2', [{ type: 'thinking', thinking: 'hmm' }]),
    assistant('m2', [{ type: 'text', text: 'Part one.' }]),
    assistant('m2', [{ type: 'text', text: 'Part two.' }]),
    { type: 'system', subtype: 'stop_hook_summary' },
    { type: 'cost-state', totalCostUSD: 0 },
  ];
  assert.equal(finalReply(records), 'Part one.\nPart two.');
});

test('is null while the reply is not flushed yet (the last message is still a tool result)', () => {
  const records = [user('fix it'), assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]), toolResult()];
  assert.equal(finalReply(records), null);
});

test('is null when the last assistant message has no text (only a tool call)', () => {
  const records = [user('fix it'), assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }])];
  assert.equal(finalReply(records), null);
});

test('ignores subagent (sidechain) records', () => {
  const records = [user('fix it'), assistant('m1', [{ type: 'text', text: 'Main reply.' }]), assistant('s1', [{ type: 'text', text: 'Subagent reply.' }], { isSidechain: true })];
  assert.equal(finalReply(records), 'Main reply.');
});
