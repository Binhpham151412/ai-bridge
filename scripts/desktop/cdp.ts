// Minimal Chrome DevTools Protocol driver for the real Electron app (no extra
// dependency: Node's built-in WebSocket + fetch against 127.0.0.1 only). Used by the
// smoke test and the real integration tests to drive the actual renderer — clicking
// the same buttons a user clicks — without any test backdoor inside the app itself.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DEV_ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

export interface LaunchOptions {
  userDataDir: string;
  defaultProjectPath: string | null;
  port: number;
  env?: Record<string, string>;
  /** Packaged exe to launch instead of the dev Electron + repo root. */
  exe?: string;
}

export async function launchApp(o: LaunchOptions): Promise<ChildProcess> {
  await mkdir(o.userDataDir, { recursive: true });
  await writeFile(path.join(o.userDataDir, 'settings.json'), JSON.stringify({ defaultProjectPath: o.defaultProjectPath }), 'utf8');
  const args = [`--remote-debugging-port=${o.port}`, `--user-data-dir=${o.userDataDir}`];
  const env = { ...process.env, ...o.env };
  return o.exe ? spawn(o.exe, args, { env, stdio: 'ignore' }) : spawn(DEV_ELECTRON, [ROOT, ...args], { env, stdio: 'ignore' });
}

export class CdpPage {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (msg) => {
      const data = JSON.parse(String(msg.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (data.id !== undefined) {
        const p = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) p?.reject(new Error(data.error.message));
        else p?.resolve(data.result);
      } else if (data.method) {
        for (const l of this.listeners.get(data.method) ?? []) l(data.params ?? {});
      }
    });
  }

  static async connect(port: number, timeoutMs = 30_000): Promise<CdpPage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
        const page = targets.find((t) => t.type === 'page' && t.url.endsWith('/renderer/index.html'));
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve(), { once: true });
            ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
          });
          const cdp = new CdpPage(ws);
          await cdp.send('Page.enable');
          await cdp.send('Runtime.enable');
          return cdp;
        }
      } catch {
        // app not up yet
      }
      if (Date.now() > deadline) throw new Error(`no renderer page on port ${port}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  /** Evaluates in the page (renderer main world) and returns the JSON value. */
  async eval<T>(expression: string): Promise<T> {
    const res = (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as {
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (res.exceptionDetails) throw new Error(`page eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value as T;
  }

  /** Accept every window.confirm (STOP/DISCARD confirmations) like a user clicking OK. */
  autoAcceptDialogs(): void {
    this.on('Page.javascriptDialogOpening', () => {
      void this.send('Page.handleJavaScriptDialog', { accept: true });
    });
  }

  async screenshot(file: string): Promise<void> {
    const res = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(res.data, 'base64'));
  }

  close(): void {
    this.ws.close();
  }
}

/** Real user interactions, dispatched in the page. */
export const ui = {
  click: (testId: string) =>
    `(() => { const el = document.querySelector('[data-testid="${testId}"]'); if (!el) throw new Error('missing ${testId}'); if (el.disabled) throw new Error('${testId} is disabled'); el.click(); return true; })()`,
  /** Sets a React-controlled textarea/input value the way typing does. */
  type: (testId: string, value: string) =>
    `(() => { const el = document.querySelector('[data-testid="${testId}"]'); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  disabled: (testId: string) => `document.querySelector('[data-testid="${testId}"]')?.disabled ?? null`,
  text: (testId: string) => `document.querySelector('[data-testid="${testId}"]')?.textContent ?? null`,
};

export async function waitFor<T>(what: string, poll: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, intervalMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await poll();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Test-harness cleanup of the Electron process the test itself launched (never used
 * on a run: runs are stopped through the app's own STOP → Core). */
export async function closeApp(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    k.on('close', () => resolve());
  });
}
