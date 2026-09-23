// Typed console API client, off-platform pattern (lakebase-off-platform
// template): callers never handle tokens — they supply a getToken callback and
// the client refreshes-and-retries once on 401, mirroring the devbox runner's
// "mint via CLI, cache ≤10 min, 401 → refresh and retry once" discipline.

export interface Engagement {
  id: string;
  client: string;
  name: string;
  phase: string;
  health: string;
}

export interface ConsoleClientOptions {
  /** Console base URL, no trailing slash required. */
  baseUrl: string;
  /** Returns a workspace OAuth bearer token; forceRefresh bypasses any cache. */
  getToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  fetchImpl?: typeof fetch;
}

export class ConsoleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(`${status} ${path}: ${message}`);
    this.name = 'ConsoleApiError';
  }
}

export class ConsoleClient {
  private readonly baseUrl: string;
  private readonly getToken: ConsoleClientOptions['getToken'];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ConsoleClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const attempt = async (forceRefresh: boolean): Promise<Response> => {
      const token = await this.getToken({ forceRefresh });
      return this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          // An empty token means the console is not behind a token-checking proxy.
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    };

    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    if (res.status === 204) return null as T; // long-poll timeout etc.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let message = body.slice(0, 300) || res.statusText;
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // non-JSON error body — keep the raw slice
      }
      throw new ConsoleApiError(res.status, path, message);
    }
    return (await res.json()) as T;
  }

  listEngagements(): Promise<Engagement[]> {
    return this.request<Engagement[]>('/api/engagements');
  }

  me(): Promise<Me> {
    return this.request<Me>('/api/me');
  }

  /** The caller's notifications (newest first) and unread count — what the web bar's bell shows. */
  async notifications(): Promise<{ notifications: ConsoleNotification[]; unread: number }> {
    const d = await this.request<{ notifications?: Record<string, unknown>[]; unread?: number }>('/api/notifications');
    const s = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    return {
      unread: Number(d.unread ?? 0),
      notifications: (d.notifications ?? []).map((r) => ({
        id: Number(r.id),
        type: s(r.type),
        title: s(r.title),
        message: s(r.message),
        ticketKey: r.ticket_key == null ? null : s(r.ticket_key),
        engagementId: r.engagement_id == null ? null : s(r.engagement_id),
        read: r.read === true,
        createdAt: s(r.created_at),
      })),
    };
  }

  markNotificationRead(id: number): Promise<unknown> {
    return this.request(`/api/notifications/${encodeURIComponent(String(id))}/read`, { method: 'PATCH', body: '{}' });
  }

  markAllNotificationsRead(): Promise<unknown> {
    return this.request('/api/notifications/read-all', { method: 'POST', body: '{}' });
  }

  /** Board slice of an engagement: tickets, roster, and active agent runs. */
  async engagementBoard(id: string): Promise<EngagementBoard> {
    const d = await this.request<{
      tickets?: Record<string, unknown>[];
      team?: Record<string, unknown>[];
      agentTasks?: Record<string, unknown>[];
    }>(`/api/engagements/${encodeURIComponent(id)}/detail`);
    const s = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
      tickets: (d.tickets ?? []).map((t) => ({ key: s(t.key), title: s(t.title), status: s(t.status), assignee: s(t.assignee) })),
      team: (d.team ?? []).map((m) => ({ name: s(m.name), email: m.email == null ? null : s(m.email) })),
      activeTaskKeys: (d.agentTasks ?? [])
        .filter((a) => ['queued', 'claimed', 'working'].includes(s(a.state)))
        .map((a) => s(a.ticket_key) || s(a.ticketKey)),
    };
  }

  /** Queue a ticket for agent work, optionally routed to a person (DAT-227). */
  queueTicket(key: string, opts?: { assignee?: string; instructions?: string }): Promise<unknown> {
    return this.request(`/api/tickets/${encodeURIComponent(key)}/queue`, {
      method: 'POST',
      body: JSON.stringify({ assignee: opts?.assignee, instructions: opts?.instructions }),
    });
  }

  /** Fetch a binary body (context-file downloads) with the same auth/401 handling. */
  async requestRaw(path: string): Promise<Uint8Array> {
    const attempt = async (forceRefresh: boolean): Promise<Response> => {
      const token = await this.getToken({ forceRefresh });
      return this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
    };
    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    if (!res.ok) throw new ConsoleApiError(res.status, path, res.statusText);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Queue snapshot as this identity: `queued` is server-scoped (DAT-227) to
   * the shared pool plus tasks routed to the caller; `active` is what the
   * named runner currently holds.
   */
  listAgentWork(agent: string, engagements?: string[]): Promise<AgentWork> {
    const params = new URLSearchParams({ agent });
    if (engagements?.length) params.set('engagements', engagements.join(','));
    return this.request<AgentWork>(`/api/agent/work?${params.toString()}`);
  }

  /**
   * Report what this machine runs (DAT-280): agents are managed locally, the
   * console mirrors them so the web's Agents page shows the real configuration.
   */
  reportAgent(payload: AgentSelfReport): Promise<unknown> {
    return this.request('/api/agent/self', { method: 'PUT', body: JSON.stringify(payload) });
  }

  /** The registry a project may attach from: shared entries plus its own (DAT-238). */
  registry(project?: string | null): Promise<Registry> {
    return this.request<Registry>(`/api/registry${project ? `?project=${encodeURIComponent(project)}` : ''}`);
  }

  /** Model ids per harness + the workspace's chat endpoints (DAT-278). */
  agentModels(): Promise<AgentModelCatalog> {
    return this.request<AgentModelCatalog>('/api/agents/models');
  }

  // ---- registry publishing (DAT-238), lead-gated server-side ----

  createMcpServer(payload: McpServerPayload): Promise<RegistryMcpServer> {
    return this.request<RegistryMcpServer>('/api/registry/mcp-servers', { method: 'POST', body: JSON.stringify(payload) });
  }

  updateMcpServer(id: number, payload: Partial<McpServerPayload>): Promise<RegistryMcpServer> {
    return this.request<RegistryMcpServer>(`/api/registry/mcp-servers/${String(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
  }

  deleteMcpServer(id: number): Promise<unknown> {
    return this.request(`/api/registry/mcp-servers/${String(id)}`, { method: 'DELETE' });
  }

  createSkill(payload: SkillPayload): Promise<RegistrySkill> {
    return this.request<RegistrySkill>('/api/registry/skills', { method: 'POST', body: JSON.stringify(payload) });
  }

  updateSkill(id: number, payload: Partial<SkillPayload>): Promise<RegistrySkill> {
    return this.request<RegistrySkill>(`/api/registry/skills/${String(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
  }

  deleteSkill(id: number): Promise<unknown> {
    return this.request(`/api/registry/skills/${String(id)}`, { method: 'DELETE' });
  }
}

export interface McpServerPayload {
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

export interface SkillPayload {
  engagementId: string | null;
  slug?: string;
  name: string;
  description?: string;
  content?: string;
  harnesses?: string[];
  status?: 'published' | 'retired';
}

export interface AgentSelfReport {
  agent: string;
  /** Console harness id: 'claude-code' | 'codex' | … */
  harness: string;
  host?: string;
  /** Engagement ids the agent claims from; empty = any project. */
  projects?: string[];
  model?: string | null;
  /** Registry slugs. */
  mcpServers?: string[];
  skills?: string[];
}

export interface RegistryMcpServer {
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
}

export interface RegistrySkill {
  id: number;
  engagementId: string | null;
  slug: string;
  name: string;
  description: string;
  content: string;
  harnesses: string[];
  status: string;
}

export interface Registry {
  mcpServers: RegistryMcpServer[];
  skills: RegistrySkill[];
}

export interface AgentModelCatalog {
  source: 'workspace' | 'static';
  servingEndpoints: { name: string; servedModel: string | null; task: string | null; provider: string | null; ready: boolean }[];
  harnessModels: Record<string, { id: string; label: string; provider: string; default?: boolean }[]>;
}

/** One row of /api/notifications, camel-cased. */
export interface ConsoleNotification {
  id: number;
  type: string;
  title: string;
  message: string;
  ticketKey: string | null;
  engagementId: string | null;
  read: boolean;
  createdAt: string;
}

export interface Me {
  email: string;
  role: string;
  leadOf: string[];
  memberOf: string[];
}

export interface BoardTicket {
  key: string;
  title: string;
  status: string;
  assignee: string;
}

export interface EngagementBoard {
  tickets: BoardTicket[];
  team: { name: string; email: string | null }[];
  activeTaskKeys: string[];
}

export interface AgentTaskRow {
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

export interface AgentWork {
  queued: AgentTaskRow[];
  active: AgentTaskRow[];
}
