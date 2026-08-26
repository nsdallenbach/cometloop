// Desktop main process: window shell + IPC surface. The renderer never
// touches the network or credentials — every capability crosses this typed
// IPC boundary (contextIsolation on, nodeIntegration off).
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { ConsoleClient } from '../../../shared/api-client';
import { loadConfig, type DesktopConfig } from './config';
import { CredentialManager, SIGN_IN_REQUIRED } from './credentials';
import { RunnerHost, type RunnerEvent } from './runner';

let cfg: DesktopConfig;
let creds: CredentialManager;
let client: ConsoleClient;
let runner: RunnerHost;

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
      // The Tickets tab embeds the deployed web console in a <webview>
      // (partition 'persist:console') — full UI parity without a port.
      webviewTag: true,
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

  ipcMain.handle('queue:list', async () => {
    try {
      return { ok: true as const, work: await client.listAgentWork(cfg.agentName) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, signInRequired: msg === SIGN_IN_REQUIRED, error: msg === SIGN_IN_REQUIRED ? 'Not signed in to Databricks.' : msg };
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

  // Board overview (DAT-231): the dev's tickets and what's free to pick up,
  // across every engagement they can see, matched by roster email → name.
  ipcMain.handle('board:overview', async () => {
    try {
      const me = await client.me();
      const engagements = await client.listEngagements();
      let myName = '';
      const mine: (import('../../../shared/api-client').BoardTicket & { engagementId: string })[] = [];
      const available: typeof mine = [];
      for (const eng of engagements) {
        const b = await client.engagementBoard(eng.id);
        const self = b.team.find((m) => m.email?.toLowerCase() === me.email.toLowerCase());
        if (self && !myName) myName = self.name;
        const active = new Set(b.activeTaskKeys);
        for (const t of b.tickets) {
          if (['done', 'dismissed', 'intake'].includes(t.status)) continue;
          if (self && t.assignee === self.name) mine.push({ ...t, engagementId: eng.id });
          else if (t.status === 'backlog' && (!t.assignee || t.assignee === '—') && !active.has(t.key)) {
            available.push({ ...t, engagementId: eng.id });
          }
        }
      }
      return { ok: true as const, myName, email: me.email, mine, available };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { ok: false as const, signInRequired: m === SIGN_IN_REQUIRED, error: m === SIGN_IN_REQUIRED ? 'Not signed in to Databricks.' : m };
    }
  });

  ipcMain.handle('board:pickup', async (_e, ticketKey: unknown) => {
    if (typeof ticketKey !== 'string' || !ticketKey) return { ok: false as const, error: 'ticket key required' };
    try {
      const me = await client.me();
      await client.queueTicket(ticketKey, { assignee: me.email });
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('runner:state', () => runner.snapshot());
  ipcMain.handle('runner:start', () => {
    runner.start();
    return runner.snapshot();
  });
  ipcMain.handle('runner:stop', () => {
    runner.stop();
    return runner.snapshot();
  });
  ipcMain.handle('runner:kill', () => {
    runner.killRun();
    return runner.snapshot();
  });
  ipcMain.handle('runner:run-ticket', (_e, ticketKey: unknown) =>
    typeof ticketKey === 'string' && ticketKey ? runner.runTicket(ticketKey) : { ok: false, error: 'ticket key required' },
  );

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
  runner = new RunnerHost(cfg, client, (ev: RunnerEvent) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('runner:event', ev);
  });

  // Embedded console auth: every request the Tickets webview makes to the
  // console gets the dev's workspace bearer token injected here, so the
  // web app renders fully signed-in with the same native OAuth session —
  // no second login, no cookies to manage. Sign-in pending → no header,
  // and the webview shows the proxy's response instead of hanging.
  const consoleSession = session.fromPartition('persist:console');
  consoleSession.webRequest.onBeforeSendHeaders({ urls: [`${cfg.consoleUrl}/*`] }, (details, callback) => {
    void creds
      .getToken()
      .then((token) => {
        callback({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } });
      })
      .catch(() => callback({ requestHeaders: details.requestHeaders }));
  });

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Any surface (main window or the console webview) that tries to open a new
// window sends https links to the OS browser instead.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
