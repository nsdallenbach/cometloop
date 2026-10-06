/// <reference types="vite/client" />

interface EngagementRow {
  id: string;
  client: string;
  name: string;
  phase: string;
  health: string;
}

type AuthMode = 'dev-token' | 'oauth' | 'cli' | 'console' | 'signed-out' | 'local';
type AuthProvider = 'databricks' | 'neon-auth' | 'none';
interface AuthStatus {
  mode: AuthMode;
  provider: AuthProvider;
  host: string;
  account: string | null;
  error?: string;
}

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

/** One of the caller's console notifications (the web bar's bell), camel-cased by the shared client. */
interface NotificationRow {
  id: number;
  type: string;
  title: string;
  message: string;
  ticketKey: string | null;
  engagementId: string | null;
  read: boolean;
  createdAt: string;
}

interface BoardTicketRow {
  key: string;
  title: string;
  status: string;
  assignee: string;
  engagementId: string;
}

/** A console deployment the desktop can sign in to. */
interface EnvironmentRow {
  id: string;
  label: string;
  consoleUrl: string;
  databricksHost?: string;
  consoleAuth?: 'databricks' | 'none';
  note?: string;
}

interface DesktopConfigView {
  consoleUrl: string;
  databricksHost: string;
  databricksProfile?: string;
  databricksCli: string;
  agentName: string;
  devMode: boolean;
  /** 'production' or 'staging' — baked into the build. */
  channel: 'production' | 'staging';
  environments: EnvironmentRow[];
  /** Chosen environment id, or null → the picker shows. */
  environment: string | null;
  activeEnvironment: EnvironmentRow | null;
  /** APP_URL pinned the console for this run (dev): no picker. */
  envOverride: boolean;
}

interface DesktopBridge {
  getConfig: () => Promise<DesktopConfigView>;
  selectEnvironment: (id: string | null) => Promise<{ ok: true } | { ok: false; error: string }>;
  listEngagements: () => Promise<
    { ok: true; engagements: EngagementRow[] } | { ok: false; error: string; signInRequired?: boolean }
  >;
  listWork: () => Promise<
    | { ok: true; work: { queued: AgentTaskRow[]; active: AgentTaskRow[] } }
    | { ok: false; error: string; signInRequired?: boolean }
  >;
  authStatus: () => Promise<AuthStatus>;
  authLogin: () => Promise<{ ok: true; status: AuthStatus } | { ok: false; error: string }>;
  authLoginConsole: (email: string, password: string) => Promise<{ ok: true; status: AuthStatus } | { ok: false; error: string }>;
  authSignUpConsole: (name: string, email: string, password: string) => Promise<{ ok: true; status: AuthStatus } | { ok: false; error: string }>;
  authRetryDiscovery: () => Promise<AuthStatus>;
  authSignOut: () => Promise<AuthStatus>;
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
  agentsConfigure: (kind: AgentKind, opts: Partial<AgentKindConfig>) => Promise<AgentsState>;
  consoleRegistry: (
    projects: string[],
  ) => Promise<{ ok: true; registry: RegistryView } | { ok: false; error: string; signInRequired?: boolean }>;
  registryList: (
    scope: string | null,
  ) => Promise<{ ok: true; registry: RegistryFull } | { ok: false; error: string; signInRequired?: boolean }>;
  registrySaveMcp: (
    id: number | null,
    payload: McpServerPayload,
  ) => Promise<{ ok: true; entry: RegistryMcpServerRow } | { ok: false; error: string }>;
  registryDeleteMcp: (id: number) => Promise<{ ok: true } | { ok: false; error: string }>;
  registrySaveSkill: (
    id: number | null,
    payload: SkillPayload,
  ) => Promise<{ ok: true; entry: RegistrySkillRow } | { ok: false; error: string }>;
  registryDeleteSkill: (id: number) => Promise<{ ok: true } | { ok: false; error: string }>;
  consoleNotifications: () => Promise<
    { ok: true; notifications: NotificationRow[]; unread: number } | { ok: false; error: string; signInRequired?: boolean }
  >;
  consoleNotificationRead: (id: number) => Promise<{ ok: true } | { ok: false; error: string }>;
  consoleNotificationsReadAll: () => Promise<{ ok: true } | { ok: false; error: string }>;
  consoleMe: () => Promise<
    { ok: true; me: { email: string; role: string; leadOf: string[]; memberOf: string[] } } | { ok: false; error: string; signInRequired?: boolean }
  >;
  consoleModels: () => Promise<
    | { ok: true; models: { source: string; harnessModels: Record<string, { id: string; label: string; default?: boolean }[]> } }
    | { ok: false; error: string; signInRequired?: boolean }
  >;
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

/** Per-agent-type configuration, managed on this machine (DAT-245 + DAT-280). */
interface AgentKindConfig {
  instances: number;
  autoStart: boolean;
  /** Engagement ids the instances claim from; empty = any project. */
  projects: string[];
  /** Harness model id; null = harness default. */
  model: string | null;
  /** Registry slugs attached to every run. */
  mcpServers: string[];
  skills: string[];
}

interface AgentsState {
  kinds: Record<AgentKind, AgentKindConfig & { installed: boolean; version: string | null }>;
  instances: InstanceSnapshot[];
}

/** Full registry rows for the Agent Tools page (DAT-238 / DAT-280). */
interface RegistryMcpServerRow {
  id: number;
  engagementId: string | null;
  slug: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  requiresAuth: boolean;
  authEnv: string | null;
  status: string;
  updatedBy?: string;
}
interface RegistrySkillRow {
  id: number;
  engagementId: string | null;
  slug: string;
  name: string;
  description: string;
  content: string;
  harnesses: string[];
  status: string;
  updatedBy?: string;
}
interface RegistryFull {
  mcpServers: RegistryMcpServerRow[];
  skills: RegistrySkillRow[];
}
interface McpServerPayload {
  engagementId: string | null;
  slug?: string;
  name: string;
  description?: string;
  transport?: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
  requiresAuth?: boolean;
  status?: 'published' | 'retired';
}
interface SkillPayload {
  engagementId: string | null;
  slug?: string;
  name: string;
  description?: string;
  content?: string;
  harnesses?: string[];
  status?: 'published' | 'retired';
}

/** Registry entries this machine may attach (DAT-238), deduplicated across the scoped projects. */
interface RegistryView {
  mcpServers: { slug: string; name: string; description: string; transport: string; requiresAuth: boolean; authEnv: string | null; scope: string }[];
  skills: { slug: string; name: string; description: string; harnesses: string[]; scope: string }[];
}

interface Window {
  desktopBridge: DesktopBridge;
}
