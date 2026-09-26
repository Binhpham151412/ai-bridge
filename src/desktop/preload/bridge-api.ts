import type { BridgeEvent } from '../../core/observability/events.ts';
import type {
  BridgeSnapshot,
  InvokeChannel,
  PushChannel,
  PushContract,
  RequestOf,
  ResponseOf,
  SaveProjectConfigRequest,
  SessionArtifactsRequest,
  SetDefaultProjectRequest,
  StartRunRequest,
  RecentEventsRequest,
} from '../shared/ipc-contract.ts';

/** The minimal slice of Electron's `ipcRenderer` this API needs — lets the API be
 * unit-tested with a plain EventEmitter-backed fake. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

/**
 * Exactly what the renderer gets as `window.aiBridge` (M4 §4): one fixed function per
 * allowlisted channel, plus two push subscriptions. No generic invoke/send/on, no
 * `ipcRenderer`, no Node objects — and push listeners receive only the payload, never
 * Electron's IPC event object (which would expose `sender`).
 */
export interface AiBridgeApi {
  getSnapshot(): Promise<ResponseOf<'bridge:getSnapshot'>>;
  start(request: StartRunRequest): Promise<ResponseOf<'bridge:start'>>;
  pause(): Promise<ResponseOf<'bridge:pause'>>;
  resume(): Promise<ResponseOf<'bridge:resume'>>;
  stop(): Promise<ResponseOf<'bridge:stop'>>;
  discard(): Promise<ResponseOf<'bridge:discard'>>;
  doctor(): Promise<ResponseOf<'bridge:doctor'>>;
  getRecentEvents(request: RecentEventsRequest): Promise<ResponseOf<'bridge:getRecentEvents'>>;
  listSessions(): Promise<ResponseOf<'bridge:listSessions'>>;
  getSessionArtifacts(request: SessionArtifactsRequest): Promise<ResponseOf<'bridge:getSessionArtifacts'>>;
  selectProject(): Promise<ResponseOf<'bridge:selectProject'>>;
  getSettings(): Promise<ResponseOf<'bridge:getSettings'>>;
  saveProjectConfig(request: SaveProjectConfigRequest): Promise<ResponseOf<'bridge:saveProjectConfig'>>;
  setDefaultProject(request: SetDefaultProjectRequest): Promise<ResponseOf<'bridge:setDefaultProject'>>;
  /** Returns an unsubscribe function; each call registers exactly one listener. */
  onEvent(listener: (event: BridgeEvent) => void): () => void;
  onSnapshot(listener: (snapshot: BridgeSnapshot) => void): () => void;
}

export function createBridgeApi(ipc: IpcRendererLike): AiBridgeApi {
  function call<C extends InvokeChannel>(channel: C, ...request: RequestOf<C> extends void ? [] : [RequestOf<C>]): Promise<ResponseOf<C>> {
    // The response shape is guaranteed by Main's router for this exact channel; the
    // cast only restores the type information IPC serialization erases.
    return ipc.invoke(channel, ...request) as Promise<ResponseOf<C>>;
  }

  function subscribe<P extends PushChannel>(channel: P, listener: (payload: PushContract[P]) => void): () => void {
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload as PushContract[P]);
    ipc.on(channel, wrapped);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipc.removeListener(channel, wrapped);
    };
  }

  return Object.freeze({
    getSnapshot: () => call('bridge:getSnapshot'),
    start: (request: StartRunRequest) => call('bridge:start', request),
    pause: () => call('bridge:pause'),
    resume: () => call('bridge:resume'),
    stop: () => call('bridge:stop'),
    discard: () => call('bridge:discard'),
    doctor: () => call('bridge:doctor'),
    getRecentEvents: (request: RecentEventsRequest) => call('bridge:getRecentEvents', request),
    listSessions: () => call('bridge:listSessions'),
    getSessionArtifacts: (request: SessionArtifactsRequest) => call('bridge:getSessionArtifacts', request),
    selectProject: () => call('bridge:selectProject'),
    getSettings: () => call('bridge:getSettings'),
    saveProjectConfig: (request: SaveProjectConfigRequest) => call('bridge:saveProjectConfig', request),
    setDefaultProject: (request: SetDefaultProjectRequest) => call('bridge:setDefaultProject', request),
    onEvent: (listener: (event: BridgeEvent) => void) => subscribe('bridge:event', listener),
    onSnapshot: (listener: (snapshot: BridgeSnapshot) => void) => subscribe('bridge:snapshot', listener),
  });
}
