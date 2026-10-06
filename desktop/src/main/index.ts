// Desktop main process: window shell + IPC surface. The renderer never
// touches the network or credentials — every capability crosses this typed
// IPC boundary (contextIsolation on, nodeIntegration off).
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConsoleClient } from '../../../shared/api-client';
import { AgentPool, type AgentKind, AGENT_KINDS } from './agents';
import { CHANNEL, activeEnvironment, loadConfig, saveEnvironmentChoice, type DesktopConfig } from './config';
import { CredentialManager, SIGN_IN_REQUIRED } from './credentials';
import { DeployManager, type DeploysEvent } from './deploys';
import { IdentityBroker, IDENTITY_PROVIDERS, type IdentityProvider, type ProviderStatus } from './identity';
import type { RunnerEvent } from './runner';
import { TerminalHost, taskWorkdir, type TerminalEvent } from './terminal';
import { initAutoUpdate } from './updater';

// The staging build must not share config.json, the encrypted refresh token
// or the pid file with the production install on the same machine. Electron
// derives userData from the package name (electron-builder's productName
// does not reach app.getName() in the asar), so pin it per channel before
// anything reads a path.
if (CHANNEL === 'staging') {
  app.setName('Cometloop Staging');
  app.setPath('userData', path.join(app.getPath('appData'), 'cometloop-desktop-staging'));
}

let cfg: DesktopConfig;
let creds: CredentialManager;
let client: ConsoleClient;
let pool: AgentPool;
let terminals: TerminalHost;
let deploys: DeployManager;
let identity: IdentityBroker;

/**
 * Single-instance-by-replacement (DAT-245): a NEW build/launch wins — it
 * kills the previous app instance instead of deferring to it (the opposite
 * of Electron's requestSingleInstanceLock default). Best-effort and guarded:
 * the stored pid is only killed if it still looks like an Electron process.
 * A run in flight in the old instance dies with it — orphan recovery
 * (DAT-234) flags the claim for one-click release.
 */
function replacePreviousInstance(): void {
  const pidFile = path.join(app.getPath('userData'), 'app.pid');
  try {
    if (existsSync(pidFile)) {
      const old = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(old) && old > 0 && old !== process.pid) {
        if (process.platform === 'win32') {
          const info = execFileSync('tasklist', ['/FI', `PID eq ${old}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            windowsHide: true,
          });
          if (/electron|delivery.?console/i.test(info)) {
            execFileSync('taskkill', ['/pid', String(old), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          }
        } else {
          process.kill(old, 'SIGTERM');
        }
      }
    }
  } catch {
    // stale pid, already-gone process, or permission hiccup — never block launch
  }
  try {
    mkdirSync(path.dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(process.pid));
  } catch {
    // pid file is best-effort
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0a0d10',
    // Packaged builds take the icon from electron-builder (resources/icon.png);
    // this covers the dev window and Linux, where BrowserWindow sets it.
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The Projects entry embeds the deployed web console in a <webview>
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
    return { ...safe, devMode: Boolean(_devToken), activeEnvironment: activeEnvironment(cfg) };
  });

  // Environment picker: persist the choice and relaunch — every
  // long-lived object (credentials, console client, pool, webview session)
  // was built from the previous URL. `null` clears the choice so the picker
  // shows again.
  ipcMain.handle('env:select', (_e, id: unknown) => {
    if (id !== null && typeof id !== 'string') return { ok: false as const, error: 'bad environment id' };
    if (id !== null && !cfg.environments.some((env) => env.id === id)) return { ok: false as const, error: `unknown environment: ${id}` };
    saveEnvironmentChoice(id);
    // The portable exe runs from a temp folder that its launcher deletes on
    // exit, so a plain relaunch of process.execPath has nothing to start —
    // the app just closes. electron-builder exposes the original file; start
    // that again (it re-unpacks, a few seconds). Installed builds relaunch
    // in place.
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    app.relaunch(portable ? { execPath: portable, args: [] } : undefined);
    app.exit(0);
    return { ok: true as const };
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

  // ---- identity broker (DAT-235): gh/az/ADO device flows + MCP secrets ----
  const isProvider = (v: unknown): v is IdentityProvider =>
    typeof v === 'string' && (IDENTITY_PROVIDERS as string[]).includes(v);

  ipcMain.handle('identity:status', () => identity.status());
  ipcMain.handle('identity:login', async (_e, provider: unknown) => {
    if (!isProvider(provider)) return { ok: false as const, error: 'unknown identity provider' };
    try {
      return { ok: true as const, status: await identity.login(provider) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('identity:sign-out', (_e, provider: unknown) =>
    isProvider(provider) ? identity.signOut(provider) : identity.status(),
  );
  ipcMain.handle('identity:mcp-list', () => identity.mcpList());
  ipcMain.handle('identity:mcp-set', (_e, name: unknown, secret: unknown) => {
    if (typeof name !== 'string' || !name.trim() || typeof secret !== 'string' || !secret) {
      return identity.mcpList();
    }
    return identity.setMcpSecret(name.trim(), secret);
  });
  ipcMain.handle('identity:mcp-clear', (_e, name: unknown) =>
    typeof name === 'string' && name ? identity.clearMcpSecret(name) : identity.mcpList(),
  );

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

  // ---- agent pool (DAT-245) ----
  ipcMain.handle('agents:state', () => pool.state());
  ipcMain.handle('agents:configure', (_e, kind: unknown, opts: unknown) => {
    if (typeof kind !== 'string' || !AGENT_KINDS.includes(kind as AgentKind)) {
      return { error: 'unknown agent kind' };
    }
    const o = (opts ?? {}) as {
      instances?: unknown;
      autoStart?: unknown;
      projects?: unknown;
      model?: unknown;
      mcpServers?: unknown;
      skills?: unknown;
    };
    const strings = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : undefined;
    return pool.configure(kind as AgentKind, {
      instances: typeof o.instances === 'number' ? o.instances : undefined,
      autoStart: typeof o.autoStart === 'boolean' ? o.autoStart : undefined,
      projects: strings(o.projects),
      model: o.model === null ? null : typeof o.model === 'string' ? o.model.trim() || null : undefined,
      mcpServers: strings(o.mcpServers),
      skills: strings(o.skills),
    });
  });

  // Agent configuration sources (DAT-280): the console's registry (union of
  // the scoped projects' views, shared entries once) and model catalog.
  ipcMain.handle('console:registry', async (_e, projects: unknown) => {
    try {
      const ids = Array.isArray(projects) ? projects.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
      const scopes = ids.length ? ids : [null];
      const mcp = new Map<string, { slug: string; name: string; description: string; transport: string; requiresAuth: boolean; authEnv: string | null; scope: string }>();
      const skills = new Map<string, { slug: string; name: string; description: string; harnesses: string[]; scope: string }>();
      for (const scope of scopes) {
        const reg = await client.registry(scope);
        for (const m of reg.mcpServers) {
          if (m.status !== 'published') continue;
          const key = `${m.engagementId ?? ''}/${m.slug}`;
          if (!mcp.has(key)) mcp.set(key, { slug: m.slug, name: m.name, description: m.description, transport: m.transport, requiresAuth: m.requiresAuth, authEnv: m.authEnv, scope: m.engagementId ?? 'shared' });
        }
        for (const k of reg.skills) {
          if (k.status !== 'published') continue;
          const key = `${k.engagementId ?? ''}/${k.slug}`;
          if (!skills.has(key)) skills.set(key, { slug: k.slug, name: k.name, description: k.description, harnesses: k.harnesses, scope: k.engagementId ?? 'shared' });
        }
      }
      return { ok: true as const, registry: { mcpServers: [...mcp.values()], skills: [...skills.values()] } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, signInRequired: msg === SIGN_IN_REQUIRED, error: msg === SIGN_IN_REQUIRED ? 'Not signed in to Databricks.' : msg };
    }
  });
  // Agent Tools (DAT-280): the registry, managed from the desktop. Reads are
  // open; the console's lead gate decides who may publish where.
  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false as const, signInRequired: msg === SIGN_IN_REQUIRED, error: msg === SIGN_IN_REQUIRED ? 'Not signed in to Databricks.' : msg };
  };
  ipcMain.handle('registry:list', async (_e, scope: unknown) => {
    try {
      const project = typeof scope === 'string' && scope && scope !== 'shared' ? scope : null;
      const reg = await client.registry(project);
      // A project scope shows shared entries too; the Tools page lists the scope's own.
      return {
        ok: true as const,
        registry: {
          mcpServers: project ? reg.mcpServers.filter((m) => m.engagementId === project) : reg.mcpServers,
          skills: project ? reg.skills.filter((k) => k.engagementId === project) : reg.skills,
        },
      };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('registry:save-mcp', async (_e, id: unknown, payload: unknown) => {
    try {
      const body = (payload ?? {}) as Parameters<ConsoleClient['createMcpServer']>[0];
      const entry = typeof id === 'number' ? await client.updateMcpServer(id, body) : await client.createMcpServer(body);
      return { ok: true as const, entry };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('registry:delete-mcp', async (_e, id: unknown) => {
    try {
      if (typeof id !== 'number') throw new Error('id required');
      await client.deleteMcpServer(id);
      return { ok: true as const };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('registry:save-skill', async (_e, id: unknown, payload: unknown) => {
    try {
      const body = (payload ?? {}) as Parameters<ConsoleClient['createSkill']>[0];
      const entry = typeof id === 'number' ? await client.updateSkill(id, body) : await client.createSkill(body);
      return { ok: true as const, entry };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('registry:delete-skill', async (_e, id: unknown) => {
    try {
      if (typeof id !== 'number') throw new Error('id required');
      await client.deleteSkill(id);
      return { ok: true as const };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('console:me', async () => {
    try {
      return { ok: true as const, me: await client.me() };
    } catch (e) {
      return fail(e);
    }
  });
  // Title-bar bell: the same /api/notifications the web bar reads, as the dev.
  ipcMain.handle('console:notifications', async () => {
    try {
      return { ok: true as const, ...(await client.notifications()) };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('console:notification-read', async (_e, id: unknown) => {
    try {
      if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('notification id required');
      await client.markNotificationRead(id);
      return { ok: true as const };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('console:notifications-read-all', async () => {
    try {
      await client.markAllNotificationsRead();
      return { ok: true as const };
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('console:models', async () => {
    try {
      const models = await client.agentModels();
      return { ok: true as const, models: { source: models.source, harnessModels: models.harnessModels } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, signInRequired: msg === SIGN_IN_REQUIRED, error: msg === SIGN_IN_REQUIRED ? 'Not signed in to Databricks.' : msg };
    }
  });
  ipcMain.handle('agents:start', (_e, id: unknown) => {
    if (typeof id === 'string') pool.instance(id)?.host.start();
    return pool.state();
  });
  ipcMain.handle('agents:stop', (_e, id: unknown) => {
    if (typeof id === 'string') pool.instance(id)?.host.stop();
    return pool.state();
  });
  ipcMain.handle('agents:kill', (_e, id: unknown) => {
    if (typeof id === 'string') pool.instance(id)?.host.killRun();
    return pool.state();
  });
  ipcMain.handle('agents:release', (_e, taskId: unknown) =>
    typeof taskId === 'number' ? pool.releaseTask(taskId) : { ok: false, error: 'task id required' },
  );
  ipcMain.handle('agents:run-ticket', (_e, ticketKey: unknown) =>
    typeof ticketKey === 'string' && ticketKey ? pool.runTicket(ticketKey) : { ok: false, error: 'ticket key required' },
  );

  // Interactive terminal (DAT-240): the renderer names a task, never a path
  // — cwd derivation and validation live in TerminalHost. Input/resize use
  // fire-and-forget `on` (keystroke latency matters); the rest is invoke.
  ipcMain.handle('terminal:create', (_e, opts: unknown) => {
    const o = (opts ?? {}) as { taskId?: unknown; ticketKey?: unknown };
    const hasTask = o.taskId !== undefined || o.ticketKey !== undefined;
    return terminals.create(
      hasTask ? { taskId: typeof o.taskId === 'number' ? o.taskId : undefined, ticketKey: typeof o.ticketKey === 'string' ? o.ticketKey : undefined } : undefined,
    );
  });
  ipcMain.handle('terminal:list', () => terminals.list());
  ipcMain.handle('terminal:attach', (_e, id: unknown) =>
    typeof id === 'number' ? terminals.attach(id) : { ok: false as const, error: 'terminal id required' },
  );
  ipcMain.handle('terminal:dispose', (_e, id: unknown) =>
    typeof id === 'number' ? terminals.dispose(id) : { ok: false },
  );
  ipcMain.on('terminal:input', (_e, id: unknown, data: unknown) => {
    if (typeof id === 'number' && typeof data === 'string') terminals.write(id, data);
  });
  ipcMain.on('terminal:resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id === 'number' && typeof cols === 'number' && typeof rows === 'number') terminals.resize(id, cols, rows);
  });

  // ---- local deploy queue (DAT-236) ----
  ipcMain.handle('deploys:state', () => deploys.snapshot());
  ipcMain.handle('deploys:refresh', async () => {
    await deploys.poll();
    return deploys.snapshot();
  });
  ipcMain.handle('deploys:run', (_e, ticketKey: unknown) =>
    typeof ticketKey === 'string' && ticketKey ? deploys.deploy(ticketKey) : { ok: false, error: 'ticket key required' },
  );
  ipcMain.handle('deploys:dismiss', (_e, ticketKey: unknown) =>
    typeof ticketKey === 'string' && ticketKey ? deploys.dismiss(ticketKey) : { ok: false, error: 'ticket key required' },
  );

  ipcMain.on('window:control', (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
  });
}

void app.whenReady().then(async () => {
  replacePreviousInstance();
  cfg = loadConfig();
  creds = new CredentialManager(cfg);
  client = new ConsoleClient({
    baseUrl: cfg.consoleUrl,
    getToken: (o) => creds.getToken(o),
  });
  identity = new IdentityBroker((status: ProviderStatus) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('identity:event', status);
  });
  pool = new AgentPool(
    cfg,
    client,
    (instanceId: string, ev: RunnerEvent) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('agents:event', { instanceId, ev });
    },
    identity,
  );
  terminals = new TerminalHost(
    cfg,
    // Default cwd for a bare "+ terminal": whichever agent instance has a
    // run in flight (first one wins), else the work root.
    () => {
      const inst = pool.state().instances.find((i) => i.current != null);
      return inst?.current ? taskWorkdir(cfg.workRoot, inst.current.ticketKey, inst.current.taskId) : null;
    },
    (ev: TerminalEvent) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('terminal:event', ev);
    },
  );
  // Auto-start (DAT-245): configured instances launch with the app so the
  // work queue never waits on a Start click.
  await pool.init();

  // Local deploy queue (DAT-236): poll the dev's merged-but-undeployed tickets
  // and report deploy events home; the web app only ever sees the mirror.
  deploys = new DeployManager(cfg, client, () => creds.getToken(), (ev: DeploysEvent) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('deploys:event', ev);
  });
  deploys.start();

  // Embedded console auth: every request the Tickets webview makes to the
  // console gets the dev's workspace bearer token injected here, so the
  // web app renders fully signed-in with the same native OAuth session —
  // no second login, no cookies to manage. Sign-in pending → no header,
  // and the webview shows the proxy's response instead of hanging.
  const consoleSession = session.fromPartition('persist:console');
  consoleSession.webRequest.onBeforeSendHeaders({ urls: [`${cfg.consoleUrl}/*`] }, (details, callback) => {
    // One retry before giving up (DAT-262): a request sent without the header
    // is redirected to OAuth, which a lazy chunk import cannot follow — and a
    // token mint that fails at startup usually succeeds a moment later.
    void creds
      .getToken()
      .catch(() => new Promise<void>((resolve) => setTimeout(resolve, 750)).then(() => creds.getToken()))
      .then((token) => {
        // An empty token means the console is not behind the Apps proxy.
        callback({ requestHeaders: token ? { ...details.requestHeaders, Authorization: `Bearer ${token}` } : details.requestHeaders });
      })
      .catch(() => callback({ requestHeaders: details.requestHeaders }));
  });

  registerIpc();
  createWindow();
  // Silent updates (DAT-237): staged in the background, applied on quit.
  initAutoUpdate(cfg);

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

// Shells die with the app — a closed console must never leave hidden
// PowerShells running.
app.on('before-quit', () => terminals?.disposeAll());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
