export const TABS = ['board', 'tickets', 'roadmap', 'analytics', 'sources', 'deploys', 'config', 'standards', 'team', 'feed'] as const;
export type Tab = (typeof TABS)[number];

export type Screen =
  | { name: 'portfolio' }
  | { name: 'setup' }
  | { name: 'settings' }
  | { name: 'metrics' }
  | { name: 'agent-map' }
  | { name: 'workflows' }
  | { name: 'workspace'; engId: string; tab: Tab }
  | { name: 'ticket'; ticketKey: string }
  | { name: 'redirect'; to: string }
  | { name: 'external'; to: string };

export const paths = {
  portfolio: '/projects',
  agentMap: '/agent-map',
  workflows: '/workflows',
  metrics: '/metrics',
  setup: '/setup',
  settings: '/settings',
  // The board is the workspace's canonical URL; other tabs get a segment.
  project: (id: string, tab: Tab = 'board') =>
    tab === 'board' ? `/projects/${encodeURIComponent(id)}` : `/projects/${encodeURIComponent(id)}/${tab}`,
  ticket: (key: string) => `/tickets/${encodeURIComponent(key)}`,
};

const isTab = (v: string): v is Tab => (TABS as readonly string[]).includes(v);

/** Maps a pathname to the screen it addresses; unknown paths redirect rather than 404. */
export function parsePath(pathname: string): Screen {
  const segs = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [head, id, tab] = segs;
  if (head === 'projects') {
    if (segs.length === 1) return { name: 'portfolio' };
    if (segs.length === 2) return { name: 'workspace', engId: id, tab: 'board' };
    if (segs.length === 3 && isTab(tab)) return { name: 'workspace', engId: id, tab };
    return { name: 'redirect', to: paths.project(id) };
  }
  if (head === 'tickets') {
    // The cross-project list became each project's Tickets tab
    // (/projects/:id/tickets); a bare /tickets has no project to scope to.
    if (segs.length === 1) return { name: 'redirect', to: paths.portfolio };
    if (segs.length === 2) return { name: 'ticket', ticketKey: id };
    return { name: 'redirect', to: paths.ticket(id) };
  }
  if (head === 'agent-map' && segs.length === 1) return { name: 'agent-map' };
  if (head === 'workflows' && segs.length === 1) return { name: 'workflows' };
  if (head === 'metrics' && segs.length === 1) return { name: 'metrics' };
  // The map answered to /agents before it became a first-class nav tab
  // (DAT-267); keep those links — docs and shared URLs still point there.
  if (head === 'agents') return { name: 'redirect', to: paths.agentMap };
  if (head === 'setup' && segs.length === 1) return { name: 'setup' };
  if (head === 'settings' && segs.length === 1) return { name: 'settings' };
  // Admin became Settings; old /admin links follow it.
  if (head === 'admin') return { name: 'redirect', to: paths.settings };
  // The in-app landing page moved to the public site; old /learn links follow it.
  if (head === 'learn') return { name: 'external', to: 'https://cometloop.ai' };
  return { name: 'redirect', to: paths.portfolio };
}
