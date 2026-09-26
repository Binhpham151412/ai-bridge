import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CodexResponseParser } from '../src/reports/codex-response-parser.ts';

const parser = new CodexResponseParser();
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

const wrap = (status: string, prompt: string) =>
  `<AI_BRIDGE_RESPONSE>\n<STATUS>${status}</STATUS>\n<PROMPT>\n${prompt}\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n`;

test('extracts status and prompt from a well-formed response', () => {
  const r = parser.parse(wrap('CONTINUE', 'Add input validation to sum().'));
  assert.deepEqual(codes(r), []);
  assert.equal(r.valid, true);
  assert.equal(r.status, 'CONTINUE');
  assert.equal(r.prompt, 'Add input validation to sum().');
});

for (const status of ['CONTINUE', 'DONE', 'NEED_HUMAN'] as const) {
  test(`accepts status ${status}`, () => {
    const r = parser.parse(wrap(status, 'Next instruction.'));
    assert.equal(r.valid, true, codes(r).join());
    assert.equal(r.status, status);
  });
}

test('rejects a status outside the allowed set', () => {
  const r = parser.parse(wrap('PROCEED', 'Next instruction.'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('INVALID_STATUS'), codes(r).join());
  assert.equal(r.status, null);
});

test('rejects a response with no AI_BRIDGE_RESPONSE block', () => {
  const r = parser.parse('Looks good to me. Claude should now add validation.');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('NO_RESPONSE_BLOCK'), codes(r).join());
});

test('rejects a second AI_BRIDGE_RESPONSE block', () => {
  const r = parser.parse(wrap('CONTINUE', 'First.') + wrap('DONE', 'Second.'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MULTIPLE_RESPONSE_BLOCKS'), codes(r).join());
  assert.equal(r.prompt, null);
});

test('rejects a response block that is never closed', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nDo it.\n</PROMPT>\n');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MALFORMED_RESPONSE_BLOCK'), codes(r).join());
});

test('rejects a closing tag that appears before its opening tag', () => {
  const r = parser.parse('</AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nDo it.\n</PROMPT>\n<AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MALFORMED_RESPONSE_BLOCK'), codes(r).join());
});

test('rejects a missing STATUS tag', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE>\n<PROMPT>\nDo it.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MISSING_STATUS'), codes(r).join());
});

test('rejects a missing PROMPT tag', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n</AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MISSING_PROMPT'), codes(r).join());
});

test('rejects a second STATUS tag', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<STATUS>DONE</STATUS>\n<PROMPT>\nDo it.\n</PROMPT>\n</AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MULTIPLE_STATUS'), codes(r).join());
});

test('rejects a second PROMPT tag', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nA\n</PROMPT>\n<PROMPT>\nB\n</PROMPT>\n</AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MULTIPLE_PROMPT'), codes(r).join());
});

test('rejects an unclosed PROMPT tag', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nDo it.\n</AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MALFORMED_PROMPT'), codes(r).join());
});

test('rejects a PROMPT close tag before its open tag', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n</PROMPT>\nDo it.\n<PROMPT>\n</AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('MALFORMED_PROMPT'), codes(r).join());
});

test('rejects an empty prompt', () => {
  for (const body of ['', '\n', '\n   \n\t\n']) {
    const r = parser.parse(`<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>${body}</PROMPT>\n</AI_BRIDGE_RESPONSE>`);
    assert.equal(r.valid, false);
    assert.ok(codes(r).includes('EMPTY_PROMPT'), `${JSON.stringify(body)}: ${codes(r).join()}`);
  }
});

test('rejects tags that appear outside the response block', () => {
  const r = parser.parse(`<STATUS>DONE</STATUS>\n${wrap('CONTINUE', 'Do it.')}`);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('TAG_OUTSIDE_BLOCK'), codes(r).join());
});

test('keeps the prompt byte-for-byte: code block, indentation, blank lines, Vietnamese text', () => {
  const prompt = [
    'Sửa `src/sum.js` như sau:',
    '',
    '```js',
    'export function sum(a, b) {',
    '  if (typeof a !== "number") {',
    '    throw new TypeError("a must be a number");',
    '  }',
    '  return a + b;',
    '}',
    '```',
    '',
    '   Giữ nguyên thụt lề 3 dấu cách ở dòng này.',
    '\tDòng này bắt đầu bằng tab.',
  ].join('\n');
  const r = parser.parse(wrap('CONTINUE', prompt));
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.prompt, prompt);
});

test('strips exactly one newline at each prompt boundary and nothing else', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE><STATUS>CONTINUE</STATUS><PROMPT>\n\nDo it.\n\n</PROMPT></AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.prompt, '\nDo it.\n');
});

test('keeps a prompt that has no surrounding newlines intact', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE><STATUS>DONE</STATUS><PROMPT>Do it.</PROMPT></AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.prompt, 'Do it.');
});

test('strips one CRLF pair at each boundary', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE>\r\n<STATUS>CONTINUE</STATUS>\r\n<PROMPT>\r\nDo it.\r\n</PROMPT>\r\n</AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.prompt, 'Do it.');
});

test('does not strip spaces or tabs at the prompt boundary', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE><STATUS>CONTINUE</STATUS><PROMPT>  Do it.\t</PROMPT></AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.prompt, '  Do it.\t');
});

test('accepts a response block wrapped in a markdown code fence', () => {
  const r = parser.parse(`Here is my review.\n\n\`\`\`xml\n${wrap('CONTINUE', 'Do it.')}\`\`\`\n`);
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.prompt, 'Do it.');
});

test('tolerates surrounding whitespace inside the STATUS tag', () => {
  const r = parser.parse('<AI_BRIDGE_RESPONSE><STATUS>  CONTINUE \n</STATUS><PROMPT>Do it.</PROMPT></AI_BRIDGE_RESPONSE>');
  assert.equal(r.valid, true, codes(r).join());
  assert.equal(r.status, 'CONTINUE');
});

test('rejects a lowercase status', () => {
  const r = parser.parse(wrap('continue', 'Do it.'));
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('INVALID_STATUS'), codes(r).join());
});

test('rejects empty input', () => {
  const r = parser.parse('');
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes('NO_RESPONSE_BLOCK'), codes(r).join());
});

test('reports the raw text and its sha256 for the audit trail', () => {
  const raw = wrap('CONTINUE', 'Do it.');
  const r = parser.parse(raw);
  assert.equal(r.raw, raw);
  assert.equal(r.sha256, createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'));
});
