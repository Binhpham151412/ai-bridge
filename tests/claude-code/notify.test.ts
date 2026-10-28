import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyCommand } from '../../src/claude-code/notify.ts';

const TITLE = 'AI Bridge';
const BODY = 'vòng 2/10 · ✅ Codex đã duyệt · 5/5 phần xong\n<b> & "quotes"';

test('Windows: a hidden PowerShell shows a toast, the text escaped for the toast XML', () => {
  const c = notifyCommand('win32', TITLE, BODY);
  assert.equal(c?.command, 'powershell.exe');
  const i = c!.args.indexOf('-EncodedCommand');
  assert.ok(i > -1);
  const script = Buffer.from(c!.args[i + 1]!, 'base64').toString('utf16le');
  assert.match(script, /ToastNotificationManager/);
  assert.ok(script.includes('vòng 2/10 · ✅ Codex đã duyệt · 5/5 phần xong'));
  assert.ok(script.includes('&lt;b&gt; &amp; &quot;quotes&quot;'));
  assert.doesNotMatch(script, /<b>/);
});

test('macOS: osascript gets the title and text as arguments, never inside the script', () => {
  const c = notifyCommand('darwin', TITLE, BODY);
  assert.equal(c?.command, 'osascript');
  assert.deepEqual(c!.args.slice(-2), [TITLE, BODY]);
  assert.ok(!c!.args.slice(0, -2).some((a) => a.includes('Codex')));
});

test('Linux: notify-send; elsewhere nothing', () => {
  assert.deepEqual(notifyCommand('linux', TITLE, BODY), { command: 'notify-send', args: ['--app-name=AI Bridge', TITLE, BODY] });
  assert.equal(notifyCommand('aix', TITLE, BODY), null);
});
