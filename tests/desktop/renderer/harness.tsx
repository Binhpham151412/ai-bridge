import { EventEmitter } from 'node:events';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BridgeEvent } from '../../../src/core/observability/events.ts';
import { createBridgeApi, type AiBridgeApi, type IpcRendererLike } from '../../../src/desktop/preload/bridge-api.ts';
import type { BridgeSnapshot } from '../../../src/desktop/shared/ipc-contract.ts';

/** An in-memory stand-in for Electron's ipcRenderer + Main: the real preload API
 * (createBridgeApi) on top of it, so renderer tests exercise the same boundary. */
export class FakeMain extends EventEmitter implements IpcRendererLike {
  readonly invoked: { channel: string; args: unknown[] }[] = [];
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  readonly api: AiBridgeApi;
  snapshot: BridgeSnapshot;

  constructor(snapshot: BridgeSnapshot) {
    super();
    this.snapshot = snapshot;
    this.api = createBridgeApi(this);
    this.handlers.set('bridge:getSnapshot', () => ({ ok: true, data: this.snapshot }));
    this.handlers.set('bridge:getRecentEvents', () => ({ ok: true, data: [] }));
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ channel, args });
    const handler = this.handlers.get(channel);
    return handler ? handler(...args) : { ok: true };
  }

  pushSnapshot(next: BridgeSnapshot): void {
    this.snapshot = next;
    act(() => {
      this.emit('bridge:snapshot', {}, next);
    });
  }

  pushEvent(event: BridgeEvent): void {
    this.pushEvents([event]);
  }

  /** A burst of events delivered within one React batch. */
  pushEvents(events: BridgeEvent[]): void {
    act(() => {
      for (const e of events) this.emit('bridge:event', {}, e);
    });
  }
}

type StatusOverrides = Partial<NonNullable<BridgeSnapshot['status']>> | null;

export function makeSnapshot(over: Omit<Partial<BridgeSnapshot>, 'status'> & { status?: StatusOverrides } = {}): BridgeSnapshot {
  const { status, ...rest } = over;
  return {
    project: { path: 'D:\\work\\demo', name: 'demo' },
    recovery: { kind: 'NONE' },
    controls: { canStart: true, canPause: false, canResume: false, stopMode: null },
    pendingAction: null,
    pauseRequested: false,
    runAttached: false,
    lastError: null,
    lastOutcome: null,
    ...rest,
    status:
      status === null
        ? null
        : {
            runId: '2026-09-26_001',
            status: 'NOT_STARTED',
            iteration: 0,
            currentPhase: null,
            claude: { pid: null, sessionId: null },
            codex: { pid: null, threadId: null },
            startedAt: null,
            updatedAt: null,
            lastReportPath: null,
            maxIterations: null,
            activity: { claude: 'IDLE', codex: 'IDLE' },
            ...status,
          },
  };
}

export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

export async function render(ui: ReactNode): Promise<{ container: HTMLElement; root: Root; rerender: (ui: ReactNode) => Promise<void>; unmount: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(ui));
  await flush();
  return {
    container,
    root,
    rerender: async (next) => {
      await act(async () => root.render(next));
      await flush();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('element not found');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

export const q = (root: ParentNode, testId: string) => root.querySelector(`[data-testid="${testId}"]`);
export const qa = (root: ParentNode, testId: string) => [...root.querySelectorAll(`[data-testid="${testId}"]`)];

export function event(over: Partial<BridgeEvent> = {}): BridgeEvent {
  return { timestamp: '2026-09-26T01:02:03.000Z', runId: '2026-09-26_001', iteration: 1, phase: 'CLAUDE_EXECUTING', event: 'CLAUDE_STARTED', detail: 'Claude started (iteration 001)', ...over };
}
