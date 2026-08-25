/// <reference types="vite/client" />

interface EngagementRow {
  id: string;
  client: string;
  name: string;
  phase: string;
  health: string;
}

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
    { ok: true; engagements: EngagementRow[] } | { ok: false; error: string }
  >;
  windowControl: (action: 'minimize' | 'maximize' | 'close') => void;
}

interface Window {
  desktopBridge: DesktopBridge;
}
