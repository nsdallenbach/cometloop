/// <reference types="vite/client" />

interface EngagementRow {
  id: string;
  client: string;
  name: string;
  phase: string;
  health: string;
}

type AuthMode = 'dev-token' | 'oauth' | 'cli' | 'signed-out';

interface AgentTaskRow {
  id: number;
  ticket_key: string;
  engagement_id: string;
  state: 'queued' | 'claimed' | 'working' | 'done' | 'failed' | 'cancelled';
  priority: number;
  instructions: string;
  assignee: string | null;
  queued_by: string;
  agent: string | null;
  last_heartbeat: string | null;
  last_note: string | null;
  flag: string | null;
  created_at: string;
}

interface BoardTicketRow {
  key: string;
  title: string;
  status: string;
  assignee: string;
  engagementId: string;
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
    { ok: true; engagements: EngagementRow[] } | { ok: false; error: string; signInRequired?: boolean }
  >;
  listWork: () => Promise<
    | { ok: true; work: { queued: AgentTaskRow[]; active: AgentTaskRow[] } }
    | { ok: false; error: string; signInRequired?: boolean }
  >;
  authStatus: () => Promise<{ mode: AuthMode; host: string }>;
  authLogin: () => Promise<{ ok: true; mode: AuthMode } | { ok: false; error: string }>;
  authSignOut: () => Promise<{ mode: AuthMode }>;
  windowControl: (action: 'minimize' | 'maximize' | 'close') => void;
  boardOverview: () => Promise<
    | { ok: true; myName: string; email: string; mine: BoardTicketRow[]; available: BoardTicketRow[] }
    | { ok: false; error: string; signInRequired?: boolean }
  >;
  boardPickup: (ticketKey: string) => Promise<{ ok: boolean; error?: string }>;
  runnerState: () => Promise<RunnerSnapshot>;
  runnerStart: () => Promise<RunnerSnapshot>;
  runnerStop: () => Promise<RunnerSnapshot>;
  runnerKill: () => Promise<RunnerSnapshot>;
  runnerRunTicket: (ticketKey: string) => Promise<{ ok: boolean; error?: string }>;
  onRunnerEvent: (cb: (ev: RunnerEvent) => void) => () => void;
}

type RunnerState = 'stopped' | 'waiting' | 'running' | 'completing';

type RunnerEvent =
  | { kind: 'status'; state: RunnerState; detail?: string; ts: string }
  | { kind: 'print'; text: string; ts: string }
  | { kind: 'tool'; name: string; label: string; ts: string }
  | { kind: 'note'; text: string; ts: string }
  | { kind: 'error'; text: string; ts: string };

interface RunnerSnapshot {
  state: RunnerState;
  harness: string;
  current: { taskId: number; ticketKey: string; startedAt: string } | null;
  feed: RunnerEvent[];
}

interface Window {
  desktopBridge: DesktopBridge;
}
