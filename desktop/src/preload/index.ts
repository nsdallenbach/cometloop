// Preload bridge: the whole main-process surface the renderer can see.
// Keep this file boring — every addition here is an addition to the app's
// attack surface and should carry its type in src/renderer/src/env.d.ts.
import { contextBridge, ipcRenderer } from 'electron';

const bridge = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  listEngagements: () => ipcRenderer.invoke('console:list-engagements'),
  listWork: () => ipcRenderer.invoke('queue:list'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  authSignOut: () => ipcRenderer.invoke('auth:sign-out'),
  windowControl: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.send('window:control', action),
  boardOverview: () => ipcRenderer.invoke('board:overview'),
  boardPickup: (ticketKey: string) => ipcRenderer.invoke('board:pickup', ticketKey),
  agentsState: () => ipcRenderer.invoke('agents:state'),
  agentsConfigure: (kind: string, opts: { instances?: number; autoStart?: boolean }) =>
    ipcRenderer.invoke('agents:configure', kind, opts),
  agentsStart: (id: string) => ipcRenderer.invoke('agents:start', id),
  agentsStop: (id: string) => ipcRenderer.invoke('agents:stop', id),
  agentsKill: (id: string) => ipcRenderer.invoke('agents:kill', id),
  agentsRunTicket: (ticketKey: string) => ipcRenderer.invoke('agents:run-ticket', ticketKey),
  agentsRelease: (taskId: number) => ipcRenderer.invoke('agents:release', taskId),
  onAgentsEvent: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('agents:event', listener);
    return () => ipcRenderer.removeListener('agents:event', listener);
  },
  // Interactive terminal pane (DAT-240). The renderer references tasks by
  // id + key — path resolution stays in the main process.
  terminalCreate: (opts?: { taskId?: number; ticketKey?: string }) =>
    ipcRenderer.invoke('terminal:create', opts),
  terminalList: () => ipcRenderer.invoke('terminal:list'),
  terminalAttach: (id: number) => ipcRenderer.invoke('terminal:attach', id),
  terminalDispose: (id: number) => ipcRenderer.invoke('terminal:dispose', id),
  terminalInput: (id: number, data: string) => ipcRenderer.send('terminal:input', id, data),
  terminalResize: (id: number, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  onTerminalEvent: (cb: (ev: unknown) => void) => {
    const listener = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on('terminal:event', listener);
    return () => ipcRenderer.removeListener('terminal:event', listener);
  },
  // Local deployment queue (DAT-236).
  deploysState: () => ipcRenderer.invoke('deploys:state'),
  deploysRefresh: () => ipcRenderer.invoke('deploys:refresh'),
  deploysRun: (ticketKey: string) => ipcRenderer.invoke('deploys:run', ticketKey),
  deploysDismiss: (ticketKey: string) => ipcRenderer.invoke('deploys:dismiss', ticketKey),
  onDeploysEvent: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('deploys:event', listener);
    return () => ipcRenderer.removeListener('deploys:event', listener);
  },
};

export type DesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld('desktopBridge', bridge);
