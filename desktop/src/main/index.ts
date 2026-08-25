// Desktop main process: window shell + IPC surface. The renderer never
// touches the network or credentials — every capability crosses this typed
// IPC boundary (contextIsolation on, nodeIntegration off).
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { ConsoleClient } from '../../../shared/api-client';
import { loadConfig, type DesktopConfig } from './config';
import { CredentialManager, SIGN_IN_REQUIRED } from './credentials';

let cfg: DesktopConfig;
let creds: CredentialManager;
let client: ConsoleClient;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0a0d10',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links open in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  return win;
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => {
    // Renderer-safe view: no secrets.
    const { devToken: _devToken, ...safe } = cfg;
    return { ...safe, devMode: Boolean(_devToken) };
  });

  ipcMain.handle('console:list-engagements', async () => {
    try {
      return { ok: true as const, engagements: await client.listEngagements() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false as const,
        signInRequired: msg === SIGN_IN_REQUIRED,
        error: msg === SIGN_IN_REQUIRED ? 'Not signed in to Databricks.' : msg,
      };
    }
  });

  ipcMain.handle('auth:status', () => creds.status());

  ipcMain.handle('auth:login', async () => {
    try {
      return { ok: true as const, ...(await creds.login()) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('auth:sign-out', () => creds.signOut());

  ipcMain.on('window:control', (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
  });
}

void app.whenReady().then(() => {
  cfg = loadConfig();
  creds = new CredentialManager(cfg);
  client = new ConsoleClient({
    baseUrl: cfg.consoleUrl,
    getToken: (o) => creds.getToken(o),
  });
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
