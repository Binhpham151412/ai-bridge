import { execFile } from 'node:child_process';

/**
 * docs/66 — an OS notification when the loop ends, so the user need not watch it. Raised from the
 * Stop hook itself (a mod's `$.ui.notify` reaches no OS notification in the desktop app): a toast
 * on Windows, `osascript` on macOS, `notify-send` on Linux. The hook waits for it (at most
 * NOTIFY_TIMEOUT_MS) rather than detaching it: nothing here outlives its parent
 * (tests/desktop/process-lifetime.test.ts). A failure is silent.
 */

const NOTIFY_TIMEOUT_MS = 10_000;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** A PowerShell single-quoted string. */
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Windows PowerShell's own app id: a toast needs a registered one to show. */
const WINDOWS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

export function notifyCommand(platform: NodeJS.Platform, title: string, body: string): { command: string; args: string[] } | null {
  if (platform === 'win32') {
    const toast = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$doc.LoadXml(${ps(toast)})`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${ps(WINDOWS_APP_ID)}).Show([Windows.UI.Notifications.ToastNotification]::new($doc))`,
    ].join('\n');
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  if (platform === 'darwin') {
    return { command: 'osascript', args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body] };
  }
  if (platform === 'linux') return { command: 'notify-send', args: ['--app-name=AI Bridge', title, body] };
  return null;
}

/** Shows the notification; resolves once the notifier is done, failed or timed out. */
export function osNotify(title: string, body: string): Promise<void> {
  const c = notifyCommand(process.platform, title, body);
  if (c === null) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      execFile(c.command, c.args, { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true }, () => resolve()).stdin?.end();
    } catch {
      resolve(); // no notifier on this machine
    }
  });
}
