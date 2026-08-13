export const TABS = ['board', 'roadmap', 'analytics', 'sources', 'config', 'standards', 'team', 'feed'] as const;
export type Tab = (typeof TABS)[number];

export type Screen =
  | { name: 'portfolio' }
  | { name: 'setup' }
  | { name: 'admin' }
  | { name: 'learn' }
  | { name: 'tickets' }
  | { name: 'agents' }
  | { name: 'workspace'; engId: string; tab: Tab }
  | { name: 'ticket'; ticketKey: string }
  | { name: 'redirect'; to: string };

export const paths = {
  portfolio: '/projects',
  tickets: '/tickets',
  agents: '/agents',
  setup: '/setup',
  admin: '/admin',
  learn: '/learn',
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
    if (segs.length === 1) return { name: 'tickets' };
    if (segs.length === 2) return { name: 'ticket', ticketKey: id };
    return { name: 'redirect', to: paths.ticket(id) };
  }
  if (head === 'agents' && segs.length === 1) return { name: 'agents' };
  if (head === 'setup' && segs.length === 1) return { name: 'setup' };
  if (head === 'admin' && segs.length === 1) return { name: 'admin' };
  if (head === 'learn' && segs.length === 1) return { name: 'learn' };
  return { name: 'redirect', to: paths.portfolio };
}
