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
  runnerState: () => ipcRenderer.invoke('runner:state'),
  runnerStart: () => ipcRenderer.invoke('runner:start'),
  runnerStop: () => ipcRenderer.invoke('runner:stop'),
  runnerKill: () => ipcRenderer.invoke('runner:kill'),
  runnerRunTicket: (ticketKey: string) => ipcRenderer.invoke('runner:run-ticket', ticketKey),
  runnerRelease: (taskId: number) => ipcRenderer.invoke('runner:release', taskId),
  onRunnerEvent: (cb: (ev: unknown) => void) => {
    const listener = (_e: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on('runner:event', listener);
    return () => ipcRenderer.removeListener('runner:event', listener);
  },
};

export type DesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld('desktopBridge', bridge);
