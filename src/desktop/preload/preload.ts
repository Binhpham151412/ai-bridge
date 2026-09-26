import { contextBridge, ipcRenderer } from 'electron';
import { createBridgeApi } from './bridge-api.ts';

// Runs in the sandboxed preload context (contextIsolation on, nodeIntegration off,
// sandbox on). The only thing that crosses into the page is `window.aiBridge`.
contextBridge.exposeInMainWorld('aiBridge', createBridgeApi(ipcRenderer));
