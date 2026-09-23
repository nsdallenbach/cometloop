import { describe, expect, it } from 'vitest';
import { parsePath, paths } from '../client/src/routes';

describe('parsePath', () => {
  it('maps each major screen to its path', () => {
    expect(parsePath('/projects')).toEqual({ name: 'portfolio' });
    expect(parsePath('/projects/exec-console')).toEqual({ name: 'workspace', engId: 'exec-console', tab: 'board' });
    expect(parsePath('/projects/exec-console/roadmap')).toEqual({ name: 'workspace', engId: 'exec-console', tab: 'roadmap' });
    expect(parsePath('/projects/exec-console/tickets')).toEqual({ name: 'workspace', engId: 'exec-console', tab: 'tickets' });
    expect(parsePath('/tickets/DAT-122')).toEqual({ name: 'ticket', ticketKey: 'DAT-122' });
    expect(parsePath('/setup')).toEqual({ name: 'setup' });
    expect(parsePath('/settings')).toEqual({ name: 'settings' });
    expect(parsePath('/metrics')).toEqual({ name: 'metrics' });
    expect(parsePath('/agent-map')).toEqual({ name: 'agent-map' });
    expect(parsePath('/workflows')).toEqual({ name: 'workflows' });
  });

  it('sends the old Admin URL to Settings', () => {
    expect(parsePath('/admin')).toEqual({ name: 'redirect', to: '/settings' });
    expect(parsePath('/admin/anything')).toEqual({ name: 'redirect', to: '/settings' });
  });

  it('sends the retired cross-project /tickets list to the portfolio, keeping ticket deep links', () => {
    expect(parsePath('/tickets')).toEqual({ name: 'redirect', to: '/projects' });
    expect(parsePath('/tickets/')).toEqual({ name: 'redirect', to: '/projects' });
    expect(parsePath('/tickets/DAT-122/extra')).toEqual({ name: 'redirect', to: '/tickets/DAT-122' });
  });

  it('keeps the pre-tab /agents links pointing at the Agent Map (DAT-267)', () => {
    expect(parsePath('/agents')).toEqual({ name: 'redirect', to: '/agent-map' });
    expect(parsePath('/agents/')).toEqual({ name: 'redirect', to: '/agent-map' });
    expect(parsePath('/agents/anything')).toEqual({ name: 'redirect', to: '/agent-map' });
  });

  it('redirects the root and unknown paths to the portfolio', () => {
    expect(parsePath('/')).toEqual({ name: 'redirect', to: '/projects' });
    expect(parsePath('')).toEqual({ name: 'redirect', to: '/projects' });
    expect(parsePath('/nope')).toEqual({ name: 'redirect', to: '/projects' });
    expect(parsePath('/setup/extra')).toEqual({ name: 'redirect', to: '/projects' });
  });

  it('redirects an unknown workspace tab to the board', () => {
    expect(parsePath('/projects/exec-console/nope')).toEqual({ name: 'redirect', to: '/projects/exec-console' });
  });

  it('tolerates trailing slashes', () => {
    expect(parsePath('/projects/')).toEqual({ name: 'portfolio' });
    expect(parsePath('/tickets/DAT-122/')).toEqual({ name: 'ticket', ticketKey: 'DAT-122' });
  });

  it('decodes escaped params', () => {
    expect(parsePath('/projects/a%20b')).toEqual({ name: 'workspace', engId: 'a b', tab: 'board' });
  });

  it('round-trips the path builders', () => {
    expect(parsePath(paths.project('exec-console', 'feed'))).toEqual({ name: 'workspace', engId: 'exec-console', tab: 'feed' });
    expect(parsePath(paths.project('exec-console'))).toEqual({ name: 'workspace', engId: 'exec-console', tab: 'board' });
    expect(parsePath(paths.ticket('DAT-122'))).toEqual({ name: 'ticket', ticketKey: 'DAT-122' });
    expect(parsePath(paths.agentMap)).toEqual({ name: 'agent-map' });
    expect(parsePath(paths.project('exec-console', 'tickets'))).toEqual({ name: 'workspace', engId: 'exec-console', tab: 'tickets' });
    expect(parsePath(paths.portfolio)).toEqual({ name: 'portfolio' });
    expect(parsePath(paths.settings)).toEqual({ name: 'settings' });
    expect(parsePath(paths.metrics)).toEqual({ name: 'metrics' });
    expect(parsePath(paths.workflows)).toEqual({ name: 'workflows' });
  });
});
