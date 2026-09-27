import { app, BrowserWindow, dialog, ipcMain, Menu, session } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BridgeEngine, MAX_LOG_FILE_BYTES } from '../../core/bridge-engine.ts';
import { INVOKE_CHANNELS, type BridgeSnapshot } from '../shared/ipc-contract.ts';
import type { BridgeEvent } from '../../core/observability/events.ts';
import { loadAppSettings, saveAppSettings, type AppSettings } from './app-settings.ts';
import { forkRunHost } from './fork-run-host.ts';
import { createIpcRouter, createTrustedSenderCheck, type ChannelHandlers } from './ipc-router.ts';
import { validateProjectPath } from './project-path.ts';
import { RunController } from './run-controller.ts';

// Bundled to dist-desktop/main.mjs. Sibling bundles: preload.cjs, run-host.mjs, renderer/.
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(DIST_DIR, 'preload.cjs');
const RUN_HOST = path.join(DIST_DIR, 'run-host.mjs');
const RENDERER_INDEX = path.join(DIST_DIR, 'renderer', 'index.html');

app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;
let settingsFile = '';
let appSettings: AppSettings = { defaultProjectPath: null };

const controller = new RunController({
  createEngine: (projectPath) => new BridgeEngine(projectPath),
  forkRunHost: () =>
    forkRunHost({
      scriptPath: RUN_HOST,
      execPath: process.execPath,
      // Inherits PATH/APPDATA etc. so the host finds the user's own signed-in
      // claude/codex CLIs; ELECTRON_RUN_AS_NODE makes the Electron binary act as Node
      // (and is removed again inside the host before Claude/Codex are spawned).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }),
});

function send(channel: 'bridge:event', payload: BridgeEvent): void;
function send(channel: 'bridge:snapshot', payload: BridgeSnapshot): void;
function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
controller.onSnapshot((snapshot) => send('bridge:snapshot', snapshot));
controller.onEvent((event) => send('bridge:event', event));

async function openProject(candidate: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const validation = await validateProjectPath(candidate);
  if (!validation.ok) return validation;
  const result = await controller.setProject(validation.project);
  return result.ok ? { ok: true } : { ok: false, reason: result.error.message };
}

const handlers: ChannelHandlers = {
  'bridge:getSnapshot': async () => ({ ok: true, data: await controller.getSnapshot() }),
  'bridge:start': (request) => controller.start(request),
  'bridge:pause': () => controller.pause(),
  'bridge:resume': () => controller.resume(),
  'bridge:stop': () => controller.stop(),
  'bridge:discard': () => controller.discard(),
  'bridge:doctor': () => controller.doctor(),
  'bridge:getRecentEvents': (request) => controller.recentEvents(request.limit),
  'bridge:listSessions': () => controller.listSessions(),
  'bridge:getSessionArtifacts': (request) => controller.getSessionArtifacts(request.runId),
  'bridge:getExecutionOutput': (request) => controller.getExecutionOutput(request),
  'bridge:getJournal': (request) => controller.getJournal(request.runId),
  'bridge:getJournalEntry': (request) => controller.getJournalEntry(request),
  'bridge:selectProject': async () => {
    if (!mainWindow) return { ok: false, error: { code: 'NO_WINDOW', title: 'Không có cửa sổ', message: 'Cửa sổ chính chưa sẵn sàng.' } };
    const picked = await dialog.showOpenDialog(mainWindow, { title: 'Chọn thư mục project', properties: ['openDirectory'] });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: true, message: 'Đã hủy chọn project.' };
    const opened = await openProject(picked.filePaths[0]);
    return opened.ok ? { ok: true } : { ok: false, error: { code: 'INVALID_PROJECT', title: 'Project không hợp lệ', message: opened.reason } };
  },
  'bridge:getSettings': async () => ({
    ok: true,
    data: { app: { defaultProjectPath: appSettings.defaultProjectPath }, project: await controller.getConfig(), logs: { maxFileBytes: MAX_LOG_FILE_BYTES } },
  }),
  'bridge:saveProjectConfig': (request) => controller.saveConfig(request.config),
  'bridge:setDefaultProject': async (request) => {
    const project = controller.getProject();
    if (!request.clear && !project) return { ok: false, error: { code: 'NO_PROJECT', title: 'Chưa chọn project', message: 'Mở một project trước khi đặt làm mặc định.' } };
    appSettings = { defaultProjectPath: request.clear || !project ? null : project.path };
    await saveAppSettings(settingsFile, appSettings);
    return { ok: true, message: request.clear ? 'Đã bỏ project mặc định.' : 'Đã đặt project mặc định.' };
  },
};

function registerIpc(): void {
  const route = createIpcRouter({ handlers, isTrustedSender: createTrustedSenderCheck(pathToFileURL(RENDERER_INDEX).href) });
  // One handler per allowlisted channel and nothing else — an unlisted channel has no
  // handler in Main at all, and the preload API cannot name one anyway.
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (event, payload: unknown) => route(channel, payload, event.senderFrame?.url));
  }
}

function hardenSession(): void {
  // No camera/mic/notifications/geolocation/etc. — the UI needs none of them.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'AI Bridge',
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (quitting || !controller.ownsActiveRun()) return;
    event.preventDefault();
    confirmStopAndQuit();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(RENDERER_INDEX);
}

let quitting = false;

/** Quitting with a live run: the user either cancels, or the run is STOPPED through
 * Core first (never left orphaned by the app, never killed by the app itself). */
function confirmStopAndQuit(): void {
  const options = {
    type: 'warning' as const,
    buttons: ['Hủy', 'STOP run và thoát'],
    defaultId: 0,
    cancelId: 0,
    title: 'AI Bridge',
    message: 'Một run đang chạy.',
    detail: 'Thoát ứng dụng sẽ STOP run qua Core (dừng process tree Claude/Codex). Muốn giữ lại tiến độ, hãy PAUSE trước rồi thoát.',
  };
  const choice = mainWindow ? dialog.showMessageBoxSync(mainWindow, options) : dialog.showMessageBoxSync(options);
  if (choice !== 1) return;
  quitting = true;
  void controller.stop().finally(() => {
    controller.dispose();
    app.quit();
  });
}

app.on('before-quit', (event) => {
  if (quitting || !controller.ownsActiveRun()) return;
  event.preventDefault();
  confirmStopAndQuit();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  // Closing the window while a run is active goes through before-quit's STOP prompt.
  app.quit();
});

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  hardenSession();
  registerIpc();
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  appSettings = await loadAppSettings(settingsFile);
  // Recovery after a crash/restart starts here: opening the project makes the
  // controller ask Core for status() and checkRecovery(); the renderer then shows
  // RECOVERABLE / RECOVERY BLOCKED. Nothing is ever resumed automatically.
  if (appSettings.defaultProjectPath) await openProject(appSettings.defaultProjectPath);
  createWindow();
});
