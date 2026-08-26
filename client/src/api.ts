import type {
  ActivePr,
  AdminData,
  AgentAccessLevel,
  AgentAction,
  AgentSecurityCatalog,
  AgentSecuritySettings,
  AgentTask,
  AgentTaskState,
  AgentsOverview,
  BurndownDay,
  CommitDay,
  ContextFile,
  FileLibrary,
  FileFolder,
  FileRule,
  ContextSource,
  DeployState,
  Engagement,
  EngagementDetail,
  EscalationStage,
  FeedItem,
  FleetStatus,
  Me,
  Notification,
  NudgeSettings,
  ParsedPlan,
  Phase,
  PlanningReviewFlow,
  ProjectAgentRole,
  ProjectAgentType,
  PrReview,
  ProjectRunnerConfig,
  ProjectStandards,
  RunnerConfigIssue,
  RepoCommit,
  RepoConnection,
  RepoDetail,
  RepoPr,
  RoadmapSettings,
  RunnerLoadBalancing,
  Suggestion,
  TeamMember,
  Ticket,
  TicketAttachment,
  TicketComment,
  TicketDev,
  TicketEscalation,
  TicketLink,
  TicketLinkType,
  TicketLinks,
  TicketRejection,
  TicketStatus,
  TicketWithEngagement,
  ToolCall,
  VelocityReport,
} from './types';

type Row = Record<string, unknown>;

const s = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
/** Non-empty string, else null — for optional text columns with '' noise. */
const nz = (v: unknown) => (v != null && s(v) !== '' ? s(v) : null);
const b = (v: unknown) => v === true || v === 't' || v === 'true';
const j = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
};

function mapEngagement(r: Row): Engagement {
  return {
    id: s(r.id),
    client: s(r.client),
    name: s(r.name),
    health: (s(r.health) as Engagement['health']) || 'ok',
    healthReason: s(r.health_reason),
    owner: s(r.owner),
    phase: s(r.phase),
    pct: n(r.pct),
    burn: n(r.burn),
    plan: n(r.plan),
    nextMilestone: s(r.next_milestone),
    blockers: n(r.blockers),
    sowStatus: s(r.sow_status),
    dates: s(r.dates),
    value: s(r.value),
    hours: s(r.hours),
    teamSize: n(r.team_size),
    rmStart: r.rm_start == null ? null : s(r.rm_start),
    rmEnd: r.rm_end == null ? null : s(r.rm_end),
    phases: r.phases == null ? null : j(r.phases, []),
    milestones: r.milestones == null ? null : j(r.milestones, []),
    composer: s(r.composer),
    pushed: b(r.pushed),
    roadmapSettings: r.roadmap_settings == null ? null : j(r.roadmap_settings, null),
  };
}

function mapTicket(r: Row): Ticket {
  return {
    key: s(r.key),
    engagementId: s(r.engagement_id),
    title: s(r.title),
    status: s(r.status) as TicketStatus,
    assignee: s(r.assignee),
    est: s(r.est),
    estHours: r.est_hours == null ? null : n(r.est_hours),
    humanEstHours: r.human_est_hours == null ? null : n(r.human_est_hours),
    actualHours: r.actual_hours == null ? null : n(r.actual_hours),
    workstream: s(r.workstream),
    agent: b(r.agent),
    sources: j(r.sources, []),
    description: s(r.description),
    ac: j(r.ac, []),
    blocked: b(r.blocked),
    activities: j(r.activities, []),
    tags: j(r.tags, []),
    deployState: r.deploy_state == null ? null : (s(r.deploy_state) as DeployState),
    deployUrl: r.deploy_url == null ? null : s(r.deploy_url),
    doneBlockedReason: nz(r.done_blocked_reason),
    roadmapItem: r.roadmap_item == null ? null : s(r.roadmap_item),
    branch: nz(r.branch) ?? nz(r.active_branch) ?? nz(r.pr_branch),
    runner: nz(r.task_agent) !== null && s(r.task_agent) === s(r.assignee) ? s(r.task_agent) : null,
    doneAt: r.done_at == null ? null : s(r.done_at),
    updatedAt: r.updated_at == null ? null : s(r.updated_at),
    waitingOn: n(r.waiting_on),
    // Only live escalations are joined server-side, so any stage here is current.
    escalationStage: r.escalation_stage == null ? null : (s(r.escalation_stage) as EscalationStage),
    escalationPr: r.escalation_pr == null ? null : n(r.escalation_pr),
    // Expired passes are filtered out server-side, so a flow here is live.
    planningReview:
      r.planning_review_flow == null
        ? null
        : { flow: s(r.planning_review_flow) as PlanningReviewFlow, startedAt: nz(r.planning_review_started_at) },
    activePr:
      r.pr_number == null
        ? null
        : {
            number: n(r.pr_number),
            title: s(r.pr_title),
            state: (['open', 'merged', 'closed'].includes(s(r.pr_state))
              ? s(r.pr_state)
              : 'closed') as ActivePr['state'],
            branch: s(r.pr_branch),
            url: s(r.pr_url),
          },
  };
}

function mapTicketWithEngagement(r: Row): TicketWithEngagement {
  return { ...mapTicket(r), client: s(r.client), engagementName: s(r.engagement_name) };
}

function mapSource(r: Row): ContextSource {
  return {
    id: n(r.id),
    name: s(r.name),
    type: s(r.type),
    status: s(r.status),
    statusColor: s(r.status_color),
    lastSync: s(r.last_sync),
    chunks: n(r.chunks),
    linked: n(r.linked),
  };
}

function mapAgentTask(r: Row): AgentTask {
  return {
    id: n(r.id),
    ticketKey: s(r.ticket_key),
    engagementId: s(r.engagement_id),
    state: (s(r.state) as AgentTaskState) || 'queued',
    priority: n(r.priority),
    instructions: s(r.instructions),
    assignee: s(r.assignee),
    queuedBy: s(r.queued_by),
    agent: r.agent == null ? null : s(r.agent),
    claimedAt: r.claimed_at == null ? null : s(r.claimed_at),
    lastHeartbeat: r.last_heartbeat == null ? null : s(r.last_heartbeat),
    lastNote: r.last_note == null ? null : s(r.last_note),
    flag: r.flag == null ? null : s(r.flag),
    result: r.result == null ? null : s(r.result),
    resultUrl: r.result_url == null ? null : s(r.result_url),
    createdAt: s(r.created_at),
  };
}

const AGENT_ACTIONS: AgentAction[] = ['claim_work', 'git_credential', 'coordination', 'pr_review'];
const ACCESS_LEVELS: AgentAccessLevel[] = ['restricted', 'standard', 'elevated', 'custom'];

/**
 * Security settings off the wire. The server always sends a full object (it
 * falls back to the role baseline itself), so this only guards shape — an
 * unreadable payload reads as enabled with no extra scopes rather than as a
 * disabled agent, matching the server's no-silent-lockout rule.
 */
function mapAgentSecurity(v: unknown): AgentSecuritySettings {
  const r = (v && typeof v === 'object' ? v : {}) as Row;
  const level = ACCESS_LEVELS.includes(s(r.accessLevel) as AgentAccessLevel) ? (s(r.accessLevel) as AgentAccessLevel) : 'standard';
  return {
    enabled: r.enabled == null ? true : b(r.enabled),
    accessLevel: level,
    allowedActions: Array.isArray(r.allowedActions)
      ? AGENT_ACTIONS.filter((a) => (r.allowedActions as unknown[]).includes(a))
      : [],
    updatedBy: nz(r.updatedBy),
    updatedAt: nz(r.updatedAt),
  };
}

function mapFeed(r: Row): FeedItem {
  return {
    id: n(r.id),
    actor: s(r.actor),
    text: s(r.text),
    timeLabel: s(r.time_label),
    source: r.source == null ? null : s(r.source),
    reversible: b(r.reversible),
    createdAt: s(r.created_at),
  };
}

function mapTeam(r: Row): TeamMember {
  return { id: n(r.id), name: s(r.name), email: r.email == null ? null : s(r.email), role: s(r.role), skills: j(r.skills, []), load: n(r.load) };
}

function mapSuggestion(r: Row): Suggestion {
  return {
    id: s(r.id),
    ticket: s(r.ticket),
    person: s(r.person),
    rationale: s(r.rationale),
    decision: r.decision == null ? null : (s(r.decision) as 'acc' | 'ovr'),
  };
}

export class ApiError extends Error {
  status: number;
  /**
   * Field-level validation failures the endpoint sent alongside the message,
   * so a form can mark the inputs that caused them instead of only toasting
   * the summary (see the Config tab's runner config, DAT-216).
   */
  issues: RunnerConfigIssue[];
  constructor(message: string, status: number, issues: RunnerConfigIssue[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('Network error — check your connection', 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: RunnerConfigIssue[] };
    throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status, body.issues ?? []);
  }
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  async notifications(): Promise<{ notifications: Notification[]; unread: number }> {
    const data = await http<{ notifications: Row[]; unread: number }>('/api/notifications');
    return {
      unread: data.unread,
      notifications: data.notifications.map((r) => ({
        id: n(r.id),
        type: s(r.type),
        title: s(r.title),
        message: s(r.message),
        ticketKey: nz(r.ticket_key),
        engagementId: nz(r.engagement_id),
        read: b(r.read),
        createdAt: s(r.created_at),
      })),
    };
  },

  markNotificationRead(id: number) {
    return http(`/api/notifications/${id}/read`, { method: 'PATCH', ...json({}) });
  },

  markAllNotificationsRead() {
    return http('/api/notifications/read-all', { method: 'POST', ...json({}) });
  },

  async engagements(): Promise<Engagement[]> {
    const rows = await http<Row[]>('/api/engagements');
    return rows.map(mapEngagement);
  },

  async detail(engId: string): Promise<EngagementDetail> {
    // fleet arrives already camelCased (built server-side, not a row) — pass
    // it through, and treat a missing/failed check as "nothing to warn about".
    const d = await http<{
      tickets: Row[];
      sources: Row[];
      feed: Row[];
      team: Row[];
      suggestions: Row[];
      agentTasks?: Row[];
      fleet?: FleetStatus | null;
    }>(`/api/engagements/${engId}/detail`);
    return {
      tickets: d.tickets.map(mapTicket),
      sources: d.sources.map(mapSource),
      feed: d.feed.map(mapFeed),
      team: d.team.map(mapTeam),
      suggestions: d.suggestions.map(mapSuggestion),
      agentTasks: (d.agentTasks ?? []).map(mapAgentTask),
      fleet: d.fleet ?? null,
    };
  },

  async commitActivity(engId: string): Promise<CommitDay[]> {
    const d = await http<{ days: CommitDay[] }>(`/api/engagements/${engId}/commit-activity`);
    return d.days;
  },

  velocity(engId: string): Promise<VelocityReport> {
    return http<VelocityReport>(`/api/engagements/${engId}/velocity`);
  },

  async burndown(engId: string): Promise<BurndownDay[]> {
    const d = await http<{ days: BurndownDay[] }>(`/api/engagements/${engId}/burndown`);
    return d.days ?? [];
  },

  async tickets(): Promise<TicketWithEngagement[]> {
    const rows = await http<Row[]>('/api/tickets');
    return rows.map(mapTicketWithEngagement);
  },

  async ticket(key: string): Promise<TicketWithEngagement> {
    return mapTicketWithEngagement(await http<Row>(`/api/tickets/${encodeURIComponent(key)}`));
  },

  async createTicket(
    engId: string,
    // DAT-207: estimates are optional — the ticket agent fills them in at
    // creation. Supply both or neither; the API rejects a lone figure.
    payload: {
      title?: string;
      description?: string;
      assignee?: string;
      est?: string;
      workstream?: string;
      estHours?: number;
      humanEstHours?: number;
    }
  ): Promise<Ticket> {
    return mapTicket(await http<Row>(`/api/engagements/${engId}/tickets`, { method: 'POST', ...json(payload) }));
  },

  patchTicket(
    key: string,
    patch: {
      status?: TicketStatus;
      assignee?: string;
      description?: string;
      roadmapItem?: string | null;
      estHours?: number | null;
      humanEstHours?: number | null;
      branch?: string;
      tags?: string[];
    }
  ) {
    return http(`/api/tickets/${key}`, { method: 'PATCH', ...json(patch) });
  },

  /**
   * Record a review decision (DAT-222): approve moves the ticket into the
   * Deploying lane, reject sends it back to Backlog and needs a note — the
   * server refuses a blank one, so the drawer never has to guess.
   */
  decideTicket(key: string, decision: 'approve' | 'reject', note?: string): Promise<{ ok: boolean; status: TicketStatus }> {
    return http(`/api/tickets/${encodeURIComponent(key)}/decision`, { method: 'POST', ...json({ decision, note }) });
  },

  saveRoadmapSettings(engId: string, settings: RoadmapSettings): Promise<RoadmapSettings> {
    return http<RoadmapSettings>(`/api/engagements/${engId}/roadmap-settings`, { method: 'PATCH', ...json(settings) });
  },

  deleteTicket(key: string) {
    return http(`/api/tickets/${key}`, { method: 'DELETE' });
  },

  async refineTicket(key: string): Promise<Ticket> {
    return mapTicket(await http<Row>(`/api/tickets/${key}/refine`, { method: 'POST', ...json({}) }));
  },

  /** Persist the board's ticket order (all keys, top to bottom). */
  reorderTickets(engId: string, order: string[]) {
    return http(`/api/engagements/${engId}/tickets/order`, { method: 'PUT', ...json({ order }) });
  },

  bulkTickets(keys: string[], patch: { status?: TicketStatus; assignee?: string }) {
    return http('/api/tickets/bulk', { method: 'POST', ...json({ keys, patch }) });
  },

  decideSuggestion(id: string, decision: 'acc' | 'ovr') {
    return http(`/api/suggestions/${id}`, { method: 'POST', ...json({ decision }) });
  },

  saveComposer(engId: string, text: string) {
    return http(`/api/engagements/${engId}/composer`, { method: 'PUT', ...json({ text }) });
  },

  pushComposer(engId: string) {
    return http(`/api/engagements/${engId}/push`, { method: 'POST', ...json({}) });
  },

  generateDraft(engId: string) {
    return http<{ text: string }>(`/api/engagements/${engId}/draft`, { method: 'POST', ...json({}) });
  },

  revertFeed(id: number) {
    return http(`/api/feed/${id}/revert`, { method: 'POST', ...json({}) });
  },

  async uploadSow(file: File): Promise<{ path: string; filename: string; size: number }> {
    return http(`/api/sow/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  },

  async parsePlan(input: { path?: string; description?: string }, client: string, name: string): Promise<ParsedPlan> {
    const plan = await http<Partial<ParsedPlan>>('/api/sow/parse', {
      method: 'POST',
      ...json({ ...input, client, name }),
    });
    return {
      phases: plan.phases ?? [],
      milestones: plan.milestones ?? [],
      proposals: plan.proposals ?? [],
      summary: plan.summary,
      extractedChars: plan.extractedChars ?? 0,
    };
  },

  createEngagement(payload: {
    client: string;
    name: string;
    sowFile?: string;
    phases: Phase[];
    milestones: { label: string; d: string }[];
    proposals: { title: string; phase: string; est: string; source: string }[];
  }): Promise<{ id: string }> {
    return http('/api/engagements', { method: 'POST', ...json(payload) });
  },

  deleteEngagement(id: string) {
    return http(`/api/engagements/${id}`, { method: 'DELETE' });
  },

  async me(): Promise<Me> {
    const r = await http<Row & { leadOf?: unknown; memberOf?: unknown }>('/api/me');
    return {
      email: s(r.email),
      role: (s(r.role) as Me['role']) || 'developer',
      leadOf: Array.isArray(r.leadOf) ? r.leadOf.map(s) : [],
      memberOf: Array.isArray(r.memberOf) ? r.memberOf.map(s) : [],
    };
  },

  async admin(): Promise<AdminData> {
    const d = await http<{ engagements: Row[]; members: Row[]; assignments: Row[]; leads: Row[] }>('/api/admin');
    return {
      engagements: d.engagements.map((r) => ({
        id: s(r.id),
        client: s(r.client),
        name: s(r.name),
        phase: s(r.phase),
        health: (s(r.health) as AdminData['engagements'][number]['health']) || 'ok',
      })),
      members: d.members.map(mapTeam),
      assignments: d.assignments.map((r) => ({ engagementId: s(r.engagement_id), memberId: n(r.member_id) })),
      leads: (d.leads ?? []).map((r) => ({ engagementId: s(r.engagement_id), email: s(r.email) })),
    };
  },

  setLeads(engagementId: string, emails: string[]) {
    return http(`/api/engagements/${engagementId}/leads`, { method: 'PUT', ...json({ emails }) });
  },

  deleteMember(id: number) {
    return http(`/api/team-members/${id}`, { method: 'DELETE' });
  },

  async comments(ticketKey: string): Promise<TicketComment[]> {
    const rows = await http<Row[]>(`/api/tickets/${ticketKey}/comments`);
    return rows.map((r) => ({ id: n(r.id), author: s(r.author), body: s(r.body), createdAt: s(r.created_at) }));
  },

  async addComment(ticketKey: string, body: string): Promise<TicketComment> {
    const r = await http<Row>(`/api/tickets/${ticketKey}/comments`, { method: 'POST', ...json({ body }) });
    return { id: n(r.id), author: s(r.author), body: s(r.body), createdAt: s(r.created_at) };
  },

  setMembers(engagementId: string, memberIds: number[]) {
    return http(`/api/engagements/${engagementId}/members`, { method: 'PUT', ...json({ memberIds }) });
  },

  async addMember(name: string, email: string, role: string): Promise<TeamMember> {
    return mapTeam(await http<Row>('/api/team-members', { method: 'POST', ...json({ name, email, role }) }));
  },

  async updateMemberEmail(id: number, email: string): Promise<TeamMember> {
    return mapTeam(await http<Row>(`/api/team-members/${id}/email`, { method: 'PUT', ...json({ email }) }));
  },

  // ---- git repo integration ----

  async repo(engId: string): Promise<RepoDetail> {
    const d = await http<{ connection: Row | null; prs?: Row[]; commits?: Row[] }>(`/api/engagements/${engId}/repo`);
    return {
      connection: d.connection ? mapRepoConnection(d.connection) : null,
      prs: (d.prs ?? []).map(mapRepoPr),
      commits: (d.commits ?? []).map(mapRepoCommit),
    };
  },

  async connectRepo(engId: string, url: string, token: string): Promise<void> {
    await http(`/api/engagements/${engId}/repo`, { method: 'POST', ...json({ url, token }) });
  },

  async connectRepoViaApp(engId: string, installationId: number, fullName: string): Promise<void> {
    await http(`/api/engagements/${engId}/repo`, { method: 'POST', ...json({ installationId, fullName }) });
  },

  githubAppStatus(): Promise<{ configured: boolean; installations: { id: number; account: string }[] }> {
    return http('/api/github-app/status');
  },

  githubAppRepos(): Promise<{
    repos: { installationId: number; fullName: string; defaultBranch: string; private: boolean }[];
  }> {
    return http('/api/github-app/repos');
  },

  disconnectRepo(engId: string) {
    return http(`/api/engagements/${engId}/repo`, { method: 'DELETE' });
  },

  syncRepo(engId: string): Promise<{ ok: boolean; commits: number; prs: number }> {
    return http(`/api/engagements/${engId}/repo/sync`, { method: 'POST', ...json({}) });
  },

  async ticketDev(key: string): Promise<TicketDev> {
    const d = await http<{ prs: Row[]; commits: Row[] }>(`/api/tickets/${key}/dev`);
    return { prs: d.prs.map(mapRepoPr), commits: d.commits.map(mapRepoCommit) };
  },

  // ---- PR review SLA (DAT-201) ----

  /** The live review-SLA clock on the ticket's open PR, or null when none is running. */
  async ticketEscalation(key: string): Promise<TicketEscalation | null> {
    const d = await http<{ escalation: TicketEscalation | null }>(`/api/tickets/${key}/escalation`);
    return d.escalation;
  },

  /** Lead-only: reset the 24h and 48h timers and clear the board flag. */
  async dismissEscalation(key: string): Promise<TicketEscalation | null> {
    const d = await http<{ escalation: TicketEscalation | null }>(`/api/tickets/${key}/escalation/dismiss`, {
      method: 'POST',
      ...json({}),
    });
    return d.escalation;
  },

  // ---- linked tickets ----

  async ticketLinks(key: string): Promise<TicketLinks> {
    const d = await http<{ links: Row[]; branches: Row[] }>(`/api/tickets/${key}/links`);
    return {
      links: d.links.map((r) => ({
        id: r.id == null ? null : n(r.id),
        key: s(r.key),
        title: s(r.title),
        status: s(r.status) as TicketLink['status'],
        type: s(r.type) as TicketLinkType,
      })),
      branches: d.branches.map((r) => ({
        branch: s(r.branch),
        prNumber: n(r.prNumber),
        state: (s(r.state) as 'open' | 'merged' | 'closed') || 'closed',
        url: s(r.url),
      })),
    };
  },

  addTicketLink(key: string, linkedKey: string, type: 'blocks' | 'blocked_by' | 'relates'): Promise<{ id: number }> {
    return http(`/api/tickets/${key}/links`, { method: 'POST', ...json({ key: linkedKey, type }) });
  },

  removeTicketLink(key: string, id: number) {
    return http(`/api/tickets/${key}/links/${id}`, { method: 'DELETE' });
  },

  async mergePr(ticketKey: string, number: number): Promise<RepoPr> {
    const d = await http<{ pr: Row }>(`/api/tickets/${ticketKey}/prs/${number}/merge`, { method: 'POST', ...json({}) });
    return mapRepoPr(d.pr);
  },

  // ---- agent work queue ----

  async queueTicket(key: string, instructions?: string, assignee?: string): Promise<AgentTask> {
    return mapAgentTask(await http<Row>(`/api/tickets/${key}/queue`, { method: 'POST', ...json({ instructions, assignee }) }));
  },

  cancelAgentTask(ticketKey: string) {
    return http(`/api/tickets/${ticketKey}/queue`, { method: 'DELETE' });
  },

  completeAgentTask(ticketKey: string) {
    return http(`/api/tickets/${ticketKey}/queue/complete`, { method: 'POST', ...json({}) });
  },

  reorderAgentQueue(engId: string, order: number[]) {
    return http(`/api/engagements/${engId}/agent-queue/order`, { method: 'PUT', ...json({ order }) });
  },

  // ---- agent map ----

  async agentsOverview(): Promise<AgentsOverview> {
    const d = await http<{ projects: Row[]; agents: Row[] }>('/api/agents/overview');
    return {
      projects: (d.projects ?? []).map((r) => ({
        id: s(r.id),
        client: s(r.client),
        name: s(r.name),
        health: (s(r.health) as AgentsOverview['projects'][number]['health']) || 'ok',
        phase: s(r.phase),
      })),
      agents: (d.agents ?? []).map((r) => ({
        id: s(r.id),
        recordId: r.recordId == null ? null : n(r.recordId),
        engagementId: s(r.engagementId),
        name: s(r.name),
        agentType: (s(r.agentType) as ProjectAgentType) || 'runner',
        role: (s(r.role) as ProjectAgentRole) || 'delivery',
        description: r.description == null ? null : s(r.description),
        harness: r.harness == null ? null : s(r.harness),
        modelProvider: r.modelProvider == null ? null : s(r.modelProvider),
        model: r.model == null ? null : s(r.model),
        endpointType: r.endpointType == null ? null : s(r.endpointType),
        endpointName: r.endpointName == null ? null : s(r.endpointName),
        endpointError: r.endpointError == null ? null : s(r.endpointError),
        status: s(r.status) || 'configured',
        source: s(r.source) === 'observed' ? 'observed' : 'configured',
        tasks: n(r.tasks),
        activeTasks: n(r.activeTasks),
        lastSeen: r.lastSeen == null ? null : s(r.lastSeen),
        createdAt: r.createdAt == null ? null : s(r.createdAt),
        security: mapAgentSecurity(r.security),
      })),
    };
  },

  // ---- per-agent security controls (DAT-212) ----

  agentSecurityCatalog(): Promise<AgentSecurityCatalog> {
    return http<AgentSecurityCatalog>('/api/agents/security/catalog');
  },

  async agentSecurity(projectId: string, agentId: number): Promise<AgentSecuritySettings> {
    const d = await http<{ security: Row }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${String(agentId)}/security`,
    );
    return mapAgentSecurity(d.security);
  },

  async updateAgentSecurity(
    projectId: string,
    agentId: number,
    payload: { enabled?: boolean; accessLevel?: AgentAccessLevel; allowedActions?: AgentAction[] },
  ): Promise<AgentSecuritySettings> {
    const d = await http<{ security: Row }>(`/api/projects/${encodeURIComponent(projectId)}/agents/${String(agentId)}/security`, {
      method: 'PUT',
      ...json(payload),
    });
    return mapAgentSecurity(d.security);
  },

  async runnerLoadBalancing(projectId: string, modelType: string): Promise<RunnerLoadBalancing> {
    const d = await http<{ modelType: unknown; runners?: Row[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/runner-load-balancing/${encodeURIComponent(modelType)}`,
    );
    return {
      modelType: s(d.modelType),
      runners: (d.runners ?? []).map((r) => ({
        name: s(r.name), status: s(r.status), weight: n(r.weight), cap: r.cap == null ? null : n(r.cap), activeTasks: n(r.activeTasks),
      })),
    };
  },

  saveRunnerLoadBalancing(projectId: string, modelType: string, runners: { name: string; weight: number; cap: number | null }[]): Promise<RunnerLoadBalancing> {
    return http(`/api/projects/${encodeURIComponent(projectId)}/runner-load-balancing/${encodeURIComponent(modelType)}`, {
      method: 'PUT', ...json({ runners }),
    });
  },

  /** Register an agent on a project. Endpoint-backed agents (AgentBricks, model
   *  serving) go live immediately; harness runners are staged until rollout. */
  createAgent(
    projectId: string,
    payload: {
      name: string;
      agentType?: ProjectAgentType;
      role?: ProjectAgentRole;
      harness?: string;
      modelProvider?: string;
      model?: string;
      endpointName?: string;
      description?: string;
      notes?: string;
    }
  ): Promise<unknown> {
    return http(`/api/projects/${encodeURIComponent(projectId)}/agents`, { method: 'POST', ...json(payload) });
  },

  updateAgent(
    projectId: string,
    agentId: number,
    payload: { role?: ProjectAgentRole; description?: string; endpointName?: string }
  ): Promise<unknown> {
    return http(`/api/projects/${encodeURIComponent(projectId)}/agents/${String(agentId)}`, {
      method: 'PATCH',
      ...json(payload),
    });
  },

  deleteAgent(projectId: string, agentId: number): Promise<unknown> {
    return http(`/api/projects/${encodeURIComponent(projectId)}/agents/${String(agentId)}`, { method: 'DELETE' });
  },

  // ---- PR review gate ----

  async prReview(ticketKey: string, prNumber: number): Promise<PrReview | null> {
    const d = await http<{ review: PrReview | null }>(
      `/api/tickets/${encodeURIComponent(ticketKey)}/prs/${String(prNumber)}/review`
    );
    return d.review;
  },

  runPrReview(ticketKey: string, prNumber: number): Promise<{ ok: boolean; verdict?: string }> {
    return http(`/api/tickets/${encodeURIComponent(ticketKey)}/prs/${String(prNumber)}/review`, {
      method: 'POST',
      ...json({}),
    });
  },

  // ---- ticket review (DAT-217) ----

  /** Every review rejection this ticket has collected, oldest first. */
  async rejections(ticketKey: string): Promise<TicketRejection[]> {
    const d = await http<{ rejections: TicketRejection[] }>(`/api/tickets/${encodeURIComponent(ticketKey)}/rejections`);
    return d.rejections;
  },

  /** Send a reviewed ticket back with a reason; the server refuses a blank one. */
  rejectTicket(ticketKey: string, reason: string, requeue: boolean): Promise<{ ok: boolean; requeued: boolean; count: number }> {
    return http(`/api/tickets/${encodeURIComponent(ticketKey)}/reject`, { method: 'POST', ...json({ reason, requeue }) });
  },

  // ---- ticket attachments ----

  async attachments(ticketKey: string): Promise<TicketAttachment[]> {
    const d = await http<{ attachments: TicketAttachment[] }>(
      `/api/tickets/${encodeURIComponent(ticketKey)}/attachments`
    );
    return d.attachments;
  },

  uploadAttachment(ticketKey: string, file: File, folderId?: string): Promise<TicketAttachment> {
    return http(
      `/api/tickets/${encodeURIComponent(ticketKey)}/attachments?filename=${encodeURIComponent(file.name)}${folderId ? `&folderId=${encodeURIComponent(folderId)}` : ''}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(file.type ? { 'X-Attachment-Content-Type': file.type } : {}),
        },
        body: file,
      }
    );
  },

  deleteAttachment(ticketKey: string, id: string) {
    return http(`/api/tickets/${encodeURIComponent(ticketKey)}/attachments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /** Tool-call feed for the ticket's latest agent run; `after` makes the poll incremental. */
  async toolCalls(ticketKey: string, after?: number): Promise<{ taskId: number | null; calls: ToolCall[] }> {
    const qs = after && after > 0 ? `?after=${after}` : '';
    const d = await http<{ task_id: unknown; calls?: Row[] }>(`/api/tickets/${ticketKey}/tool-calls${qs}`);
    return {
      taskId: d.task_id == null ? null : n(d.task_id),
      calls: (d.calls ?? []).map((r) => ({
        id: n(r.id),
        tool: s(r.tool),
        detail: s(r.detail),
        calledAt: s(r.called_at),
      })),
    };
  },

  // ---- context files ----

  async contextFiles(engId: string): Promise<ContextFile[]> {
    const d = await http<{ files: ContextFile[] }>(`/api/engagements/${engId}/context-files`);
    return d.files;
  },

  uploadContextFile(engId: string, file: File): Promise<{ name: string; size: number }> {
    return http(`/api/engagements/${engId}/context-files?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  },

  deleteContextFile(engId: string, name: string) {
    return http(`/api/engagements/${engId}/context-files/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  fileLibrary(engId: string): Promise<FileLibrary> {
    return http(`/api/engagements/${encodeURIComponent(engId)}/files`);
  },
  createFolder(engId: string, name: string, parentId: string | null): Promise<FileFolder> {
    return http(`/api/engagements/${encodeURIComponent(engId)}/folders`, {
      method: 'POST',
      ...json({ name, parentId }),
    });
  },
  renameFolder(engId: string, folderId: string, name: string): Promise<FileFolder> {
    return http(`/api/engagements/${encodeURIComponent(engId)}/folders/${folderId}`, {
      method: 'PATCH',
      ...json({ name }),
    });
  },
  deleteFolder(engId: string, folderId: string) {
    return http(`/api/engagements/${encodeURIComponent(engId)}/folders/${folderId}`, { method: 'DELETE' });
  },
  uploadLibraryFile(engId: string, folderId: string, file: File): Promise<{ fired: { ticketKey: string }[] }> {
    return http(
      `/api/engagements/${encodeURIComponent(engId)}/files?folderId=${encodeURIComponent(folderId)}&filename=${encodeURIComponent(file.name)}`,
      { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file }
    );
  },
  deleteLibraryFile(engId: string, fileId: string) {
    return http(`/api/engagements/${encodeURIComponent(engId)}/files/${fileId}`, { method: 'DELETE' });
  },
  createFileRule(engId: string, rule: Omit<FileRule, 'id'>): Promise<FileRule> {
    return http(`/api/engagements/${encodeURIComponent(engId)}/file-rules`, { method: 'POST', ...json(rule) });
  },
  deleteFileRule(engId: string, ruleId: string) {
    return http(`/api/engagements/${encodeURIComponent(engId)}/file-rules/${ruleId}`, { method: 'DELETE' });
  },

  // ---- project standards ----

  async standards(engId: string): Promise<ProjectStandards> {
    return mapStandards(await http<Row>(`/api/engagements/${engId}/standards`));
  },

  async saveStandards(engId: string, content: string): Promise<ProjectStandards> {
    return mapStandards(
      await http<Row>(`/api/engagements/${engId}/standards`, { method: 'PUT', ...json({ content }) })
    );
  },

  refineStandards(engId: string, content: string, instructions?: string): Promise<{ content: string }> {
    return http(`/api/engagements/${engId}/standards/refine`, {
      method: 'POST',
      ...json({ content, instructions: instructions?.trim() || undefined }),
    });
  },

  async standardsFiles(engId: string): Promise<ContextFile[]> {
    const d = await http<{ files: ContextFile[] }>(`/api/engagements/${engId}/standards/files`);
    return d.files;
  },

  uploadStandardsFile(engId: string, file: File): Promise<{ name: string; size: number }> {
    return http(`/api/engagements/${engId}/standards/files?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  },

  deleteStandardsFile(engId: string, name: string) {
    return http(`/api/engagements/${engId}/standards/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  // ---- project runner config (Config tab) ----

  runnerConfig(engId: string): Promise<ProjectRunnerConfig> {
    return http(`/api/engagements/${engId}/runner-config`);
  },

  /**
   * Save the base image and library list. Rejected configs come back as an
   * ApiError carrying `issues` — the caller renders them against the fields.
   */
  saveRunnerConfig(engId: string, baseImage: string, libraries: string[]): Promise<ProjectRunnerConfig> {
    return http(`/api/engagements/${engId}/runner-config`, { method: 'PUT', ...json({ baseImage, libraries }) });
  },

  // ---- stale-ticket nudges (DAT-107) ----

  nudgeSettings(engId: string): Promise<NudgeSettings> {
    return http(`/api/engagements/${engId}/nudge-settings`);
  },

  saveNudgeSettings(engId: string, quietDays: number): Promise<NudgeSettings> {
    return http(`/api/engagements/${engId}/nudge-settings`, { method: 'PUT', ...json({ quietDays }) });
  },
};

function mapStandards(r: Row): ProjectStandards {
  return {
    content: s(r.content),
    updatedBy: s(r.updated_by),
    updatedAt: r.updated_at == null ? null : s(r.updated_at),
  };
}

function mapRepoConnection(r: Row): RepoConnection {
  return {
    id: n(r.id),
    provider: s(r.provider) === 'ado' ? 'ado' : 'github',
    repoUrl: s(r.repo_url),
    repoName: s(r.repo_name),
    defaultBranch: s(r.default_branch),
    status: s(r.status),
    lastError: r.last_error == null ? null : s(r.last_error),
    lastSyncAt: r.last_sync_at == null ? null : s(r.last_sync_at),
    tokenHint: s(r.token_hint),
  };
}

function mapRepoPr(r: Row): RepoPr {
  const state = s(r.state);
  return {
    number: n(r.number),
    title: s(r.title),
    author: s(r.author),
    state: state === 'merged' ? 'merged' : state === 'open' ? 'open' : 'closed',
    branch: s(r.branch),
    url: s(r.url),
    ticketKey: r.ticket_key == null ? null : s(r.ticket_key),
    deployState: r.deploy_state == null ? null : (s(r.deploy_state) as DeployState),
    deployUrl: r.deploy_url == null ? null : s(r.deploy_url),
  };
}

function mapRepoCommit(r: Row): RepoCommit {
  return {
    sha: s(r.sha),
    message: s(r.message),
    author: s(r.author),
    committedAt: r.committed_at == null ? null : s(r.committed_at),
    url: s(r.url),
    ticketKey: r.ticket_key == null ? null : s(r.ticket_key),
  };
}
