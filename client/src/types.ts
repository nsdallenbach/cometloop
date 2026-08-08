export type Health = 'ok' | 'risk' | 'off';
export type TicketStatus = 'backlog' | 'progress' | 'review' | 'done' | 'proposed' | 'dismissed';

export interface Phase {
  name: string;
  s: string;
  e: string;
  pct?: number;
}

export interface Milestone {
  label: string;
  d: string;
  done: boolean;
}

export interface Engagement {
  id: string;
  client: string;
  name: string;
  health: Health;
  healthReason: string;
  owner: string;
  phase: string;
  pct: number;
  burn: number;
  plan: number;
  nextMilestone: string;
  blockers: number;
  sowStatus: string;
  dates: string;
  value: string;
  hours: string;
  teamSize: number;
  rmStart: string | null;
  rmEnd: string | null;
  phases: Phase[] | null;
  milestones: Milestone[] | null;
  composer: string;
  pushed: boolean;
}

export interface TicketSource {
  type: string;
  label: string;
}

export interface Ticket {
  key: string;
  engagementId: string;
  title: string;
  status: TicketStatus;
  assignee: string;
  est: string;
  workstream: string;
  agent: boolean;
  sources: TicketSource[];
  description: string;
  ac: string[];
  blocked: boolean;
}

export interface ContextSource {
  id: number;
  name: string;
  type: string;
  status: string;
  statusColor: string;
  lastSync: string;
  chunks: number;
  linked: number;
}

export interface TeamMember {
  id: number;
  name: string;
  role: string;
  skills: number[];
  load: number;
}

export interface Suggestion {
  id: string;
  ticket: string;
  person: string;
  rationale: string;
  decision: 'acc' | 'ovr' | null;
}

export interface FeedItem {
  id: number;
  actor: string;
  text: string;
  timeLabel: string;
  source: string | null;
  reversible: boolean;
}

export type AgentTaskState = 'queued' | 'claimed' | 'working' | 'done' | 'failed' | 'cancelled';

export interface AgentTask {
  id: number;
  ticketKey: string;
  engagementId: string;
  state: AgentTaskState;
  priority: number;
  instructions: string;
  queuedBy: string;
  agent: string | null;
  claimedAt: string | null;
  lastHeartbeat: string | null;
  lastNote: string | null;
  result: string | null;
  resultUrl: string | null;
  createdAt: string;
}

export interface ContextFile {
  name: string;
  size: number;
  lastModified: string | null;
  url: string;
}

export interface EngagementDetail {
  tickets: Ticket[];
  sources: ContextSource[];
  feed: FeedItem[];
  team: TeamMember[];
  suggestions: Suggestion[];
  agentTasks: AgentTask[];
}

export interface Proposal {
  title: string;
  phase: string;
  est: string;
  source: string;
  dec: 'pending' | 'acc' | 'dis';
}

export interface ParsedPlan {
  phases: Phase[];
  milestones: { label: string; d: string }[];
  proposals: { title: string; phase: string; est: string; source: string }[];
  summary?: string;
  extractedChars: number;
}

export interface AdminData {
  engagements: { id: string; client: string; name: string; phase: string; health: Health }[];
  members: TeamMember[];
  assignments: { engagementId: string; memberId: number }[];
  leads: { engagementId: string; email: string }[];
}

export type Role = 'admin' | 'lead' | 'developer';

export interface Me {
  email: string;
  role: Role;
  leadOf: string[];
}

export interface TicketComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface RepoConnection {
  id: number;
  provider: 'github' | 'ado';
  repoUrl: string;
  repoName: string;
  defaultBranch: string;
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
  tokenHint: string;
}

export interface RepoPr {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'merged' | 'closed';
  branch: string;
  url: string;
  ticketKey: string | null;
}

export interface RepoCommit {
  sha: string;
  message: string;
  author: string;
  committedAt: string | null;
  url: string;
  ticketKey: string | null;
}

export interface RepoDetail {
  connection: RepoConnection | null;
  prs: RepoPr[];
  commits: RepoCommit[];
}

export interface TicketDev {
  prs: RepoPr[];
  commits: RepoCommit[];
}
