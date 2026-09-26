import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BridgeEvent } from '../../../core/observability/events.ts';
import type { AiBridgeApi } from '../../preload/bridge-api.ts';
import type { ActionResponse, BridgeSnapshot, UiError } from '../../shared/ipc-contract.ts';
import { mergeEvents } from '../lib/events-store.ts';

export interface Notice {
  kind: 'info' | 'error';
  text: string;
  error?: UiError;
}

interface BridgeContextValue {
  api: AiBridgeApi;
  /** Latest snapshot pushed by Main — the renderer never derives Core state itself. */
  snapshot: BridgeSnapshot | null;
  events: BridgeEvent[];
  notice: Notice | null;
  dismissNotice: () => void;
  /** Runs one IPC action, surfacing its message/error as a notice. */
  runAction: (action: () => Promise<ActionResponse>) => Promise<ActionResponse>;
}

const BridgeContext = createContext<BridgeContextValue | null>(null);

const INITIAL_HISTORY = 300;

/**
 * Owns the renderer's single subscription to Main's push channels (M4 §20): subscribes
 * on mount, unsubscribes on unmount — so StrictMode's mount/unmount/mount, or any
 * remount, never leaves a second listener behind or delivers an event twice.
 */
export function BridgeProvider({ api, children }: { api: AiBridgeApi; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let active = true;
    const offSnapshot = api.onSnapshot((next) => {
      if (active) setSnapshot(next);
    });
    const offEvent = api.onEvent((event) => {
      if (active) setEvents((prev) => mergeEvents(prev, [event]));
    });
    void api.getSnapshot().then((res) => {
      if (active && res.ok) setSnapshot(res.data);
    });
    return () => {
      active = false;
      offSnapshot();
      offEvent();
    };
  }, [api]);

  // History for whichever project is open (re-read when the project changes).
  const projectPath = snapshot?.project?.path ?? null;
  useEffect(() => {
    let active = true;
    setEvents([]);
    if (projectPath === null) return;
    void api.getRecentEvents({ limit: INITIAL_HISTORY }).then((res) => {
      if (active && res.ok) setEvents((prev) => mergeEvents(res.data, prev));
    });
    return () => {
      active = false;
    };
  }, [api, projectPath]);

  const runAction = useCallback(async (action: () => Promise<ActionResponse>) => {
    const res = await action();
    if (res.ok) setNotice(res.message ? { kind: 'info', text: res.message } : null);
    else setNotice({ kind: 'error', text: res.error.title, error: res.error });
    return res;
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo(() => ({ api, snapshot, events, notice, dismissNotice, runAction }), [api, snapshot, events, notice, dismissNotice, runAction]);
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridge(): BridgeContextValue {
  const value = useContext(BridgeContext);
  if (!value) throw new Error('useBridge must be used inside <BridgeProvider>');
  return value;
}
