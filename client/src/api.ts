import type {
  ActivePr,
  AdminData,
  AgentTask,
  AgentTaskState,
  BurndownDay,
  ContextFile,
  ContextSource,
  DeployState,
  Engagement,
  EngagementDetail,
  FeedItem,
  Me,
  ParsedPlan,
  Phase,
  ProjectStandards,
  RepoCommit,
  RepoConnection,
  RepoDetail,
  RepoPr,
  RoadmapSettings,
  Suggestion,
  TeamMember,
  Ticket,
  TicketAttachment,
  TicketComment,
  TicketDev,
  TicketLink,
  TicketLinkType,
  TicketLinks,
  TicketStatus,
  TicketWithEngagement,
  ToolCall,
} from './types';

type Row = Record<string, unknown>;

const s = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
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
    tags: j(r.tags, []),
    deployState: r.deploy_state == null ? null : (s(r.deploy_state) as DeployState),
    deployUrl: r.deploy_url == null ? null : s(r.deploy_url),
    roadmapItem: r.roadmap_item == null ? null : s(r.roadmap_item),
    branch: r.branch != null && s(r.branch) !== '' ? s(r.branch) : r.pr_branch != null && s(r.pr_branch) !== '' ? s(r.pr_branch) : null,
    doneAt: r.done_at == null ? null : s(r.done_at),
    waitingOn: n(r.waiting_on),
    activePr:
      r.pr_number == null
        ? null
        : {
            number: n(r.pr_number),
            title: s(r.pr_title),
            state: (['open', 'merged', 'closed'].includes(s(r.pr_state)) ? s(r.pr_state) : 'closed') as ActivePr['state'],
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
  return { id: n(r.id), name: s(r.name), role: s(r.role), skills: j(r.skills, []), load: n(r.load) };
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
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  async engagements(): Promise<Engagement[]> {
    const rows = await http<Row[]>('/api/engagements');
    return rows.map(mapEngagement);
  },

  async detail(engId: string): Promise<EngagementDetail> {
    const d = await http<{ tickets: Row[]; sources: Row[]; feed: Row[]; team: Row[]; suggestions: Row[]; agentTasks?: Row[] }>(
      `/api/engagements/${engId}/detail`,
    );
    return {
      tickets: d.tickets.map(mapTicket),
      sources: d.sources.map(mapSource),
      feed: d.feed.map(mapFeed),
      team: d.team.map(mapTeam),
      suggestions: d.suggestions.map(mapSuggestion),
      agentTasks: (d.agentTasks ?? []).map(mapAgentTask),
    };
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
    payload: { title?: string; description?: string; assignee?: string; est?: string; workstream?: string },
  ): Promise<Ticket> {
    return mapTicket(await http<Row>(`/api/engagements/${engId}/tickets`, { method: 'POST', ...json(payload) }));
  },

  patchTicket(
    key: string,
    patch: { status?: TicketStatus; assignee?: string; roadmapItem?: string | null; estHours?: number | null; humanEstHours?: number | null; branch?: string; tags?: string[] },
  ) {
    return http(`/api/tickets/${key}`, { method: 'PATCH', ...json(patch) });
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
    const plan = await http<Partial<ParsedPlan>>('/api/sow/parse', { method: 'POST', ...json({ ...input, client, name }) });
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
    const r = await http<Row & { leadOf?: unknown }>('/api/me');
    return {
      email: s(r.email),
      role: (s(r.role) as Me['role']) || 'developer',
      leadOf: Array.isArray(r.leadOf) ? r.leadOf.map(s) : [],
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

  async addMember(name: string, role: string): Promise<TeamMember> {
    return mapTeam(await http<Row>('/api/team-members', { method: 'POST', ...json({ name, role }) }));
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

  githubAppRepos(): Promise<{ repos: { installationId: number; fullName: string; defaultBranch: string; private: boolean }[] }> {
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

  async queueTicket(key: string, instructions?: string): Promise<AgentTask> {
    return mapAgentTask(await http<Row>(`/api/tickets/${key}/queue`, { method: 'POST', ...json({ instructions }) }));
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

  // ---- ticket attachments ----

  async attachments(ticketKey: string): Promise<TicketAttachment[]> {
    const d = await http<{ attachments: TicketAttachment[] }>(`/api/tickets/${encodeURIComponent(ticketKey)}/attachments`);
    return d.attachments;
  },

  uploadAttachment(ticketKey: string, file: File): Promise<TicketAttachment> {
    return http(`/api/tickets/${encodeURIComponent(ticketKey)}/attachments?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(file.type ? { 'X-Attachment-Content-Type': file.type } : {}),
      },
      body: file,
    });
  },

  deleteAttachment(ticketKey: string, id: string) {
    return http(`/api/tickets/${encodeURIComponent(ticketKey)}/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },


  /** Tool-call feed for the ticket's latest agent run; `after` makes the poll incremental. */
  async toolCalls(ticketKey: string, after?: number): Promise<{ taskId: number | null; calls: ToolCall[] }> {
    const qs = after && after > 0 ? `?after=${after}` : '';
    const d = await http<{ task_id: unknown; calls?: Row[] }>(`/api/tickets/${ticketKey}/tool-calls${qs}`);
    return {
      taskId: d.task_id == null ? null : n(d.task_id),
      calls: (d.calls ?? []).map((r) => ({ id: n(r.id), tool: s(r.tool), detail: s(r.detail), calledAt: s(r.called_at) })),
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

  // ---- project standards ----

  async standards(engId: string): Promise<ProjectStandards> {
    return mapStandards(await http<Row>(`/api/engagements/${engId}/standards`));
  },

  async saveStandards(engId: string, content: string): Promise<ProjectStandards> {
    return mapStandards(await http<Row>(`/api/engagements/${engId}/standards`, { method: 'PUT', ...json({ content }) }));
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
