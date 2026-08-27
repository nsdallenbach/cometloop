/// <reference types="vite/client" />

interface EngagementRow {
  id: string;
  client: string;
  name: string;
  phase: string;
  health: string;
}

type AuthMode = 'dev-token' | 'oauth' | 'cli' | 'signed-out';

type IdentityProvider = 'github' | 'azure' | 'ado';

interface IdentityStatusRow {
  provider: IdentityProvider;
  state: 'signed-in' | 'signed-out' | 'pending';
  account: string | null;
  prompt?: { userCode: string; verificationUri: string };
}

interface McpAuthRow {
  name: string;
  hasSecret: boolean;
}

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
  identityStatus: () => Promise<IdentityStatusRow[]>;
  identityLogin: (
    provider: IdentityProvider,
  ) => Promise<{ ok: true; status: IdentityStatusRow } | { ok: false; error: string }>;
  identitySignOut: (provider: IdentityProvider) => Promise<IdentityStatusRow[]>;
  identityMcpList: () => Promise<McpAuthRow[]>;
  identityMcpSet: (name: string, secret: string) => Promise<McpAuthRow[]>;
  identityMcpClear: (name: string) => Promise<McpAuthRow[]>;
  onIdentityEvent: (cb: (status: IdentityStatusRow) => void) => () => void;
  windowControl: (action: 'minimize' | 'maximize' | 'close') => void;
  boardOverview: () => Promise<
    | { ok: true; myName: string; email: string; mine: BoardTicketRow[]; available: BoardTicketRow[] }
    | { ok: false; error: string; signInRequired?: boolean }
  >;
  boardPickup: (ticketKey: string) => Promise<{ ok: boolean; error?: string }>;
  agentsState: () => Promise<AgentsState>;
  agentsConfigure: (kind: AgentKind, opts: { instances?: number; autoStart?: boolean }) => Promise<AgentsState>;
  agentsStart: (id: string) => Promise<AgentsState>;
  agentsStop: (id: string) => Promise<AgentsState>;
  agentsKill: (id: string) => Promise<AgentsState>;
  agentsRunTicket: (ticketKey: string) => Promise<{ ok: boolean; error?: string }>;
  agentsRelease: (taskId: number) => Promise<{ ok: boolean; error?: string }>;
  onAgentsEvent: (cb: (payload: { instanceId: string; ev: RunnerEvent }) => void) => () => void;
  terminalCreate: (opts?: {
    taskId?: number;
    ticketKey?: string;
  }) => Promise<{ ok: true; info: TerminalInfo } | { ok: false; error: string }>;
  terminalList: () => Promise<TerminalInfo[]>;
  terminalAttach: (
    id: number,
  ) => Promise<
    { ok: true; info: TerminalInfo; buffer: string; lastSeq: number } | { ok: false; error: string }
  >;
  terminalDispose: (id: number) => Promise<{ ok: boolean }>;
  terminalInput: (id: number, data: string) => void;
  terminalResize: (id: number, cols: number, rows: number) => void;
  onTerminalEvent: (cb: (ev: TerminalEvent) => void) => () => void;
  deploysState: () => Promise<DeploysSnapshot>;
  deploysRefresh: () => Promise<DeploysSnapshot>;
  deploysRun: (ticketKey: string) => Promise<{ ok: boolean; error?: string }>;
  deploysDismiss: (ticketKey: string) => Promise<{ ok: boolean; error?: string }>;
  onDeploysEvent: (cb: (ev: DeploysEvent) => void) => () => void;
}

interface TerminalInfo {
  id: number;
  title: string;
  cwd: string;
  live: boolean;
  exitCode: number | null;
}

type DeployState = 'queued' | 'deploying' | 'succeeded' | 'failed';

interface DeployItem {
  ticketKey: string;
  title: string;
  engagementId: string;
  prNumber: number | null;
  branch: string;
  repoName: string;
  repoUrl: string;
  defaultBranch: string;
  state: DeployState;
  log: string[];
  error: string;
  queuedAt: string;
  finishedAt: string | null;
}

type DeploysEvent = { kind: 'items' } | { kind: 'log'; ticketKey: string; line: string; ts: string };

interface DeploysSnapshot {
  items: DeployItem[];
  deploying: string | null;
  polledAt: string | null;
  pollError: string;
}

type TerminalEvent =
  | { kind: 'data'; id: number; seq: number; data: string }
  | { kind: 'exit'; id: number; exitCode: number }
  | { kind: 'opened'; id: number }
  | { kind: 'closed'; id: number };

type RunnerState = 'stopped' | 'waiting' | 'running' | 'completing';

type AgentKind = 'claude' | 'codex';

type RunnerEvent =
  | { kind: 'status'; state: RunnerState; detail?: string; ts: string }
  | { kind: 'print'; text: string; ts: string }
  | { kind: 'tool'; name: string; label: string; ts: string }
  | { kind: 'note'; text: string; ts: string }
  | { kind: 'error'; text: string; ts: string }
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheCreate: number; costUsd?: number; final?: boolean; ticketKey: string; ts: string };

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  costUsd: number | null;
}

interface InstanceSnapshot {
  id: string;
  kind: AgentKind;
  label: string;
  agentName: string;
  state: RunnerState;
  harness: string;
  current: { taskId: number; ticketKey: string; startedAt: string } | null;
  feed: RunnerEvent[];
  runUsage: UsageTotals;
  sessionUsage: UsageTotals;
}

interface AgentsState {
  kinds: Record<AgentKind, { installed: boolean; version: string | null; instances: number; autoStart: boolean }>;
  instances: InstanceSnapshot[];
}

interface Window {
  desktopBridge: DesktopBridge;
}
