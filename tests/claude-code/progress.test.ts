import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewProgress } from '../../src/claude-code/progress.ts';
import { buildChatReportContract, buildChatReviewerInput } from '../../src/prompts/templates.ts';

const BLOCK = '<AI_BRIDGE_RESPONSE>\n<STATUS>CONTINUE</STATUS>\n<PROMPT>\nTest it on the desktop.\n- [ ] not a part\n</PROMPT>\n</AI_BRIDGE_RESPONSE>\n';
const REVIEW = [
  '## Việc',
  'Thêm ô nhập task và nút Copy vào pane AI Bridge.',
  '',
  '## Tiến độ',
  '- [x] Ô nhập task, Enter chạy /bridge',
  '* [X]   Nút Copy  ',
  '- [ ] Thử thật trên desktop',
  '',
  '## Kết luận',
  'Chưa duyệt: còn thiếu thử tay trên desktop.',
  '',
  '## Vấn đề',
  'Không có.',
  '',
  BLOCK,
].join('\n');

test("reads the task, the checklist and the conclusion from Codex's review", () => {
  assert.deepEqual(parseReviewProgress(REVIEW), {
    title: 'Thêm ô nhập task và nút Copy vào pane AI Bridge.',
    items: [
      { text: 'Ô nhập task, Enter chạy /bridge', done: true },
      { text: 'Nút Copy', done: true },
      { text: 'Thử thật trên desktop', done: false },
    ],
    verdict: 'Chưa duyệt: còn thiếu thử tay trên desktop.',
  });
});

test('a review without those sections has no progress, and a checklist inside the response block is not one', () => {
  assert.equal(parseReviewProgress(`## Summary\nLooks fine.\n\n${BLOCK}`), null);
  assert.equal(parseReviewProgress(BLOCK), null);
});

test('the chat reviewer gets the original task and the round limit, and is asked for Việc / Tiến độ / Kết luận', () => {
  const input = buildChatReviewerInput({ projectName: 'Demo', sessionId: 's', iteration: 1, reportText: 'REPORT BODY', task: 'fix the login bug', maxRounds: 3, checklist: null });
  assert.match(input, /ORIGINAL TASK[\s\S]*fix the login bug/);
  assert.match(input, /ITERATION:\n1\n/);
  assert.match(input, /ROUND LIMIT:\n3\n/);
  assert.ok(input.includes('REPORT BODY'));
  for (const heading of ['## Việc', '## Tiến độ', '## Kết luận']) assert.ok(input.includes(heading), heading);
  assert.match(input, /Vietnamese/);
  assert.match(input, /Make the list from the ORIGINAL TASK/);
  assert.ok(input.indexOf('## Tiến độ') < input.indexOf('<AI_BRIDGE_RESPONSE>'), 'the review comes before the block');
});

test('from round 2 the reviewer is handed its previous checklist to keep', () => {
  const input = buildChatReviewerInput({
    projectName: 'Demo',
    sessionId: 's',
    iteration: 2,
    reportText: 'x',
    task: 'fix the login bug',
    maxRounds: 3,
    checklist: [
      { text: 'Compare hashes', done: true },
      { text: 'Test expired tokens', done: false },
    ],
  });
  assert.match(input, /YOUR CHECKLIST FROM THE PREVIOUS ROUND[\s\S]*- \[x\] Compare hashes\n- \[ \] Test expired tokens/);
  assert.match(input, /Keep the parts of that checklist/);
});

test('the report contract asks Claude for a summary for the user first, then the report for the reviewer', () => {
  const contract = buildChatReportContract();
  const summary = contract.indexOf('**Tóm tắt cho bạn**');
  assert.ok(summary > -1);
  assert.ok(summary < contract.indexOf('## TASK'));
  for (const line of ['Việc:', 'Tiến độ:', 'Vòng này đã làm:', 'Cần bạn:']) assert.ok(contract.includes(line), line);
  assert.match(contract, /NEXT_ACTION: CONTINUE, DONE, or NEED_HUMAN/);
  assert.doesNotMatch(contract, /Codex's checklist/);
});

test("given Codex's checklist, the contract tells Claude to tick those parts", () => {
  const contract = buildChatReportContract([
    { text: 'Compare hashes', done: true },
    { text: 'Test expired tokens', done: false },
  ]);
  assert.match(contract, /Codex's checklist[\s\S]*- \[x\] Compare hashes\n\s*- \[ \] Test expired tokens/);
});
