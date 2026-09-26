import type { AiBridgeApi } from '../preload/bridge-api.ts';

declare global {
  interface Window {
    /** Exposed by the preload script via contextBridge — the renderer's only way out. */
    readonly aiBridge: AiBridgeApi;
  }
}

export {};
