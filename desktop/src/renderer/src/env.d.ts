/// <reference types="vite/client" />

interface EngagementRow {
  id: string;
  client: string;
  name: string;
  phase: string;
  health: string;
}

type AuthMode = 'dev-token' | 'oauth' | 'cli' | 'signed-out';

interface DesktopBridge {
  getConfig: () => Promise<{
    consoleUrl: string;
    databricksHost: string;
    databricksProfile?: string;
    databricksCli: string;
    agentName: string;
    devMode: boolean;
  }>;
  listEngagements: () => Promise<
    { ok: true; engagements: EngagementRow[] } | { ok: false; error: string; signInRequired?: boolean }
  >;
  authStatus: () => Promise<{ mode: AuthMode; host: string }>;
  authLogin: () => Promise<{ ok: true; mode: AuthMode } | { ok: false; error: string }>;
  authSignOut: () => Promise<{ mode: AuthMode }>;
  windowControl: (action: 'minimize' | 'maximize' | 'close') => void;
}

interface Window {
  desktopBridge: DesktopBridge;
}
