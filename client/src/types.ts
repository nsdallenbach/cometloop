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

/** How ticket effort (LLM agent-hours) translates into roadmap calendar time. */
export interface RoadmapSettings {
  /** Agent-hours of ticket effort that land in one working day. */
  hoursPerDay: number;
  /** Schedule buffer applied on top of the translated days, in percent. */
  bufferPct: number;
  /** Working days per week — converts working days to calendar days. */
  workdaysPerWeek: number;
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
  roadmapSettings: RoadmapSettings | null;
}

export interface TicketSource {
  type: string;
  label: string;
}

/** Deployment pipeline progress for a merged PR ('none' = no pipeline found). */
export type DeployState = 'pending' | 'running' | 'success' | 'failed' | 'none';

/** The PR currently driving a ticket: an open one if any, else the latest. */
export interface ActivePr {
  number: number;
  title: string;
  state: 'open' | 'merged' | 'closed';
  branch: string;
  url: string;
}

export interface Ticket {
  key: string;
  engagementId: string;
  title: string;
  status: TicketStatus;
  assignee: string;
  est: string;
  /** Latest LLM-hours estimate from the estimation model (1 decimal), null before it runs. */
  estHours: number | null;
  /** Estimated hours for a human developer to do the same scope, null before the model runs. */
  humanEstHours: number | null;
  /** Actual agent working hours, logged when the ticket reached Review. */
  actualHours: number | null;
  workstream: string;
  agent: boolean;
  sources: TicketSource[];
  description: string;
  ac: string[];
  blocked: boolean;
  tags: string[];
  deployState: DeployState | null;
  deployUrl: string | null;
  /** Roadmap item (phase name) this ticket is linked to; null = unscheduled. */
  roadmapItem: string | null;
  /** Git branch for the work: manual value, else the branch a runner announced
   *  for in-flight work, else the latest linked PR's branch. */
  branch: string | null;
  /** Runner id when the assignee is the runner that claimed the latest agent
   *  task (cross-project reads only; the board derives this live from
   *  agentTasks). Null for human assignees and unclaimed tickets. */
  runner: string | null;
  /** When the ticket entered Done (null while in any other status). */
  doneAt: string | null;
  /** When the ticket body/description was last edited (null = never edited). */
  updatedAt: string | null;
  /** Unresolved blocking tickets (open `blocks` links pointing at this ticket). */
  waitingOn: number;
  activePr: ActivePr | null;
  /** Live review-SLA escalation: 'pinged' = lead pinged at 24h, 'flagged' =
   *  48h breach (summary posted on the PR, ticket flagged on the board). */
  escalationStage: EscalationStage | null;
  /** PR the escalation is about, when one is live. */
  escalationPr: number | null;
}

/** Stage of a PR review-SLA escalation (DAT-201); cleared rows are never sent. */
export type EscalationStage = 'waiting' | 'pinged' | 'flagged';

/** The review-SLA clock on a ticket's open PR, as the drawer shows it. */
export interface TicketEscalation {
  prNumber: number;
  prUrl: string;
  ticketKey: string;
  stage: EscalationStage;
  hoursUnreviewed: number;
  /** Hours left before the next stage fires; null once flagged. */
  hoursUntilNextStage: number | null;
  timerStartedAt: string | null;
  pingedAt: string | null;
  flaggedAt: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
  dismissCount: number;
  leadEmail: string | null;
}

/** Ticket joined with its engagement, for cross-project views (/tickets). */
export interface TicketWithEngagement extends Ticket {
  client: string;
  engagementName: string;
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
  createdAt: string;
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
  flag: string | null;
  result: string | null;
  resultUrl: string | null;
  createdAt: string;
}

/** Node kinds on the /agents map. 'foundry' is still a placeholder. */
export type ProjectAgentType = 'runner' | 'serving-endpoint' | 'agentbricks' | 'foundry';

/** What an agent is for. 'pr-reviewer' is wired to the PR review gate. */
export type ProjectAgentRole = 'delivery' | 'pr-reviewer' | 'planning' | 'other';

/** Gateable agent actions (DAT-212) — mirrors AGENT_ACTIONS server-side. */
export type AgentAction = 'claim_work' | 'git_credential' | 'coordination' | 'pr_review';

export type AgentAccessLevel = 'restricted' | 'standard' | 'elevated' | 'custom';

/** One agent's security controls, enforced at action-execution time. */
export interface AgentSecuritySettings {
  /** Master switch — a disabled agent may only wind down a task it already holds. */
  enabled: boolean;
  accessLevel: AgentAccessLevel;
  allowedActions: AgentAction[];
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Action ids, labels and preset scopes, served from the security catalog endpoint. */
export interface AgentSecurityCatalog {
  actions: { id: AgentAction; label: string }[];
  accessLevels: AgentAccessLevel[];
  presets: Record<Exclude<AgentAccessLevel, 'custom'>, AgentAction[]>;
}

/** One agent node on the /agents architecture map. */
export interface ProjectAgent {
  id: string;
  /** project_agents.id for stored records; null for observed runners (not editable). */
  recordId: number | null;
  engagementId: string;
  name: string;
  agentType: ProjectAgentType;
  role: ProjectAgentRole;
  description: string | null;
  /** Harness id ('claude-code', 'codex', …); null when only a provider is known. */
  harness: string | null;
  modelProvider: string | null;
  model: string | null;
  endpointType: string | null;
  /** Workspace serving endpoint behind AgentBricks / model-serving agents. */
  endpointName: string | null;
  /** Why the endpoint could not be read (e.g. missing CAN_QUERY), when unreachable. */
  endpointError: string | null;
  /** 'active' | 'idle' | 'unreachable' (endpoints/runners) or 'configured' (staged deploys). */
  status: string;
  /** observed = derived from real agent_tasks history; configured = stored record. */
  source: 'configured' | 'observed';
  tasks: number;
  activeTasks: number;
  lastSeen: string | null;
  createdAt: string | null;
  /** Per-agent security controls, editable by leads from the agent's panel. */
  security: AgentSecuritySettings;
}

/** Latest automated review for a PR, as shown next to the PR on a ticket. */
export interface PrReview {
  id: number;
  state: string;
  verdict: string | null;
  summary: string | null;
  reviewer: string;
  error: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export interface AgentsOverviewProject {
  id: string;
  client: string;
  name: string;
  health: Health;
  phase: string;
}

export interface AgentsOverview {
  projects: AgentsOverviewProject[];
  agents: ProjectAgent[];
}

/** One tool invocation streamed from an agent run (live feed in the ticket drawer). */
export interface ToolCall {
  id: number;
  tool: string;
  detail: string;
  calledAt: string;
}

export interface ContextFile {
  name: string;
  size: number;
  lastModified: string | null;
  url: string;
}

export interface TicketAttachment {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  sha256: string;
  uploader: string;
  createdAt: string | null;
  url: string;
}

/** Per-engagement Project Standards markdown document. */
export interface ProjectStandards {
  content: string;
  updatedBy: string;
  updatedAt: string | null;
}

/** One end-of-day snapshot of the ticket burndown series.
 *  (Type alias, not interface, so it stays assignable to the charts' Record data prop.) */
/** Org-velocity KPI report from GET /api/engagements/:id/velocity (DAT-193). */
export interface VelocityReport {
  windowDays: number;
  leadTimeHrs: { current: number | null; previous: number | null; samples: number };
  cycleTimeHrs: { current: number | null; previous: number | null; samples: number };
  decisionTimeHrs: { current: number | null; previous: number | null; samples: number };
  reviewPassRate: number | null;
  stages: { key: 'queue' | 'build' | 'review'; label: string; medianHrs: number | null; samples: number }[];
  backlog: { date: string; open: number }[];
  backlogDelta: number | null;
  weekly: { week: string; doneCount: number; leadTimeHrs: number | null; cycleTimeHrs: number | null; humanHoursSaved: number }[];
  humanHoursSaved: { window: number; total: number; agentHoursSpent: number };
  thenVsNow: {
    spanDays: number;
    then: { donePerWeek: number; leadTimeHrs: number | null; humanHoursSavedPerWeek: number };
    now: { donePerWeek: number; leadTimeHrs: number | null; humanHoursSavedPerWeek: number };
  } | null;
}

export type CommitDay = {
  date: string;
  commits: number;
  authors: number;
};

export type BurndownDay = {
  date: string;
  open: number;
  done: number;
  total: number;
};

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
  deployState: DeployState | null;
  deployUrl: string | null;
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

/** A link seen from one ticket's side; 'mention' = detected in text, not stored. */
export type TicketLinkType = 'blocks' | 'blocked_by' | 'relates' | 'mention';

export interface TicketLink {
  /** Stored link id; null for detected mentions (which cannot be removed). */
  id: number | null;
  key: string;
  title: string;
  status: TicketStatus;
  type: TicketLinkType;
}

/** A git branch linked to the ticket via its most recent synced PR. */
export interface LinkedBranch {
  branch: string;
  prNumber: number;
  state: 'open' | 'merged' | 'closed';
  url: string;
}

export interface TicketLinks {
  links: TicketLink[];
  branches: LinkedBranch[];
}
