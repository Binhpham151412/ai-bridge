import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportContract, buildReviewerInput } from '../src/prompts/templates.ts';

test('report contract names the exact report file, session id, and iteration', () => {
  const text = buildReportContract({ reportPath: 'D:\\proj\\.ai-bridge\\reports\\001-report.md', sessionId: '2026-09-25_001', iteration: 1 });
  assert.match(text, /REPORT_FILE: D:\\proj\\\.ai-bridge\\reports\\001-report\.md/);
  assert.match(text, /SESSION_ID: 2026-09-25_001/);
  assert.match(text, /ITERATION: 1/);
  assert.match(text, /REPORT_STATUS: COMPLETE/);
});

test('report contract lists all five required sections in order', () => {
  const text = buildReportContract({ reportPath: 'x', sessionId: 's', iteration: 1 });
  const order = ['## TASK', '## CHANGES', '## TESTS', '## ISSUES', '## NEXT_RECOMMENDATION'];
  const positions = order.map((h) => text.indexOf(h));
  assert.ok(positions.every((p) => p !== -1), 'missing a required section heading');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'sections are out of order');
});

test('reviewer input embeds the exact report text between BEGIN/END markers, unmodified', () => {
  const reportText = '# AI Bridge Report\n\nSESSION_ID: s\nITERATION: 1\nREPORT_STATUS: COMPLETE\nNEXT_ACTION: CONTINUE\n\n## TASK\nTiếng Việt có dấu.\n';
  const text = buildReviewerInput({ projectName: 'Demo', sessionId: 's', iteration: 1, reportText });
  const begin = text.indexOf('--- BEGIN REPORT ---');
  const end = text.indexOf('--- END REPORT ---');
  assert.ok(begin !== -1 && end !== -1 && begin < end);
  const embedded = text.slice(begin + '--- BEGIN REPORT ---'.length, end).trim();
  assert.equal(embedded, reportText.trim());
});

test('reviewer input names the project, session, and iteration', () => {
  const text = buildReviewerInput({ projectName: 'Demo Project', sessionId: '2026-09-25_001', iteration: 3, reportText: 'x' });
  assert.match(text, /PROJECT:\s*\n?Demo Project/);
  assert.match(text, /SESSION:\s*\n?2026-09-25_001/);
  assert.match(text, /ITERATION:\s*\n?3/);
});

test('reviewer input states the exact AI_BRIDGE_RESPONSE structure and allowed statuses', () => {
  const text = buildReviewerInput({ projectName: 'Demo', sessionId: 's', iteration: 1, reportText: 'x' });
  assert.match(text, /<AI_BRIDGE_RESPONSE>/);
  assert.match(text, /<STATUS>/);
  assert.match(text, /<PROMPT>/);
  assert.match(text, /CONTINUE/);
  assert.match(text, /DONE/);
  assert.match(text, /NEED_HUMAN/);
});
