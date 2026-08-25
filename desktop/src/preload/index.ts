// Preload bridge: the whole main-process surface the renderer can see.
// Keep this file boring — every addition here is an addition to the app's
// attack surface and should carry its type in src/renderer/src/env.d.ts.
import { contextBridge, ipcRenderer } from 'electron';

const bridge = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  listEngagements: () => ipcRenderer.invoke('console:list-engagements'),
  windowControl: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.send('window:control', action),
};

export type DesktopBridge = typeof bridge;

contextBridge.exposeInMainWorld('desktopBridge', bridge);
