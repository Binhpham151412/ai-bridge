import './dom-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Markdown } from '../../../src/desktop/renderer/lib/Markdown.tsx';
import { describeEvent, mergeEvents } from '../../../src/desktop/renderer/lib/events-store.ts';
import { event, render } from './harness.tsx';

test('reports render as Markdown (headings, lists, tables, code) without ever injecting HTML', async () => {
  const source = [
    '# AI Bridge Report',
    '<script>window.__pwned = true</script>',
    '<img src=x onerror="window.__pwned = true">',
    '## CHANGES',
    '- created `src/sum.js`',
    '- **bold** and *italic*',
    '',
    '| file | status |',
    '|---|---|',
    '| a.js | ok |',
    '',
    '```js',
    'console.log("<b>not bold</b>")',
    '```',
  ].join('\n');
  const view = await render(<Markdown source={source} />);
  try {
    const c = view.container;
    assert.equal(c.querySelectorAll('script, img, iframe, object').length, 0);
    assert.match(c.textContent!, /<script>window.__pwned = true<\/script>/, 'shown as text');
    assert.equal((globalThis as unknown as { __pwned?: boolean }).__pwned, undefined);
    assert.ok(c.querySelector('h2'));
    assert.equal(c.querySelectorAll('li').length, 2);
    assert.ok(c.querySelector('li code'));
    assert.ok(c.querySelector('strong') && c.querySelector('em'));
    assert.equal(c.querySelectorAll('table td').length, 2);
    assert.equal(c.querySelector('pre code')!.textContent, 'console.log("<b>not bold</b>")');
    assert.equal(c.querySelectorAll('b').length, 0);
  } finally {
    await view.unmount();
  }
});

test('underscores/asterisks inside identifiers stay literal (regression: SESSION_ID rendered as italics)', async () => {
  const view = await render(<Markdown source={'SESSION_ID: 2026-09-26_001\nITERATION: 2\nuse snake_case_name and a*b*c, but _this_ and *that* are emphasis'} />);
  try {
    const p = view.container.querySelector('p')!;
    assert.match(p.textContent!, /SESSION_ID: 2026-09-26_001/);
    assert.match(p.textContent!, /snake_case_name and a\*b\*c/);
    assert.deepEqual([...p.querySelectorAll('em')].map((e) => e.textContent), ['this', 'that']);
  } finally {
    await view.unmount();
  }
});

test('mergeEvents de-duplicates, orders by time and bounds the list', () => {
  const a = event({ timestamp: '2026-09-26T01:00:02.000Z' });
  const b = event({ timestamp: '2026-09-26T01:00:01.000Z', event: 'RUN_STARTED', detail: undefined });
  assert.deepEqual(mergeEvents([a], [b, a]), [b, a]);
  const many = Array.from({ length: 10 }, (_, i) => event({ timestamp: `2026-09-26T01:00:${String(i).padStart(2, '0')}.000Z` }));
  assert.equal(mergeEvents([], many, 4).length, 4);
  assert.equal(mergeEvents([], many, 4)[3].timestamp, many[9].timestamp);
});

test('describeEvent labels events and separates normal / warning / error', () => {
  assert.deepEqual(describeEvent(event({ event: 'RUN_STARTED' })), { label: 'Session started', level: 'normal' });
  assert.deepEqual(describeEvent(event({ event: 'CODEX_EXITED', detail: 'codex exited 0 (8000ms) — ok' })), { label: 'Codex response received', level: 'normal' });
  assert.equal(describeEvent(event({ event: 'CLAUDE_EXITED', detail: 'claude exited 1 (100ms) — error' })).level, 'error');
  assert.equal(describeEvent(event({ event: 'PAUSE_REQUESTED' })).level, 'warning');
  assert.equal(describeEvent(event({ event: 'RECOVERY_STARTED' })).level, 'warning');
  assert.equal(describeEvent(event({ event: 'TIMEOUT' })).level, 'error');
  assert.deepEqual(describeEvent(event({ event: 'RUN_COMPLETED', phase: 'ERROR' })), { label: 'Run ended (ERROR)', level: 'error' });
  assert.deepEqual(describeEvent(event({ event: 'RUN_COMPLETED', phase: 'DONE' })), { label: 'Run completed', level: 'normal' });
});
