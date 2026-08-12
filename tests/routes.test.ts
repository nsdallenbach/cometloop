import { describe, expect, it } from 'vitest';
import { parsePath, paths } from '../client/src/routes';

describe('parsePath', () => {
  it('maps each major screen to its path', () => {
    expect(parsePath('/projects')).toEqual({ name: 'portfolio' });
    expect(parsePath('/projects/exec-console')).toEqual({ name: 'workspace', engId: 'exec-console', tab: 'board' });
    expect(parsePath('/projects/exec-console/roadmap')).toEqual({ name: 'workspace', engId: 'exec-console', tab: 'roadmap' });
    expect(parsePath('/tickets')).toEqual({ name: 'tickets' });
    expect(parsePath('/tickets/DAT-122')).toEqual({ name: 'ticket', ticketKey: 'DAT-122' });
    expect(parsePath('/setup')).toEqual({ name: 'setup' });
    expect(parsePath('/admin')).toEqual({ name: 'admin' });
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
  });
});
