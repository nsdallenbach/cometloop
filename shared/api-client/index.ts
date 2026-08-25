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
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    };

    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ConsoleApiError(res.status, path, body.slice(0, 300) || res.statusText);
    }
    return (await res.json()) as T;
  }

  listEngagements(): Promise<Engagement[]> {
    return this.request<Engagement[]>('/api/engagements');
  }
}
