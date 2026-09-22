import { describe, expect, it, vi } from 'vitest';
import { createNotification, mentionedEmails, renderEmailDigest } from './notifications';

describe('notification events', () => {
  it('extracts and de-duplicates email mentions case-insensitively', () => {
    expect(mentionedEmails('Hi @Dev@One.com and @dev@one.com, cc @lead.two@datavail.com')).toEqual([
      'dev@one.com',
      'lead.two@datavail.com',
    ]);
  });

  it('persists one canonical payload for the feed and live stream', async () => {
    const row = { id: 7, recipient_email: 'dev@datavail.com', type: 'assignment', read: false };
    const q = vi.fn().mockResolvedValue({ rows: [row] });
    await expect(
      createNotification(q, {
        recipient: ' Dev@Datavail.com ',
        type: 'assignment',
        title: 'DAT-105 assigned',
        message: 'Build it',
        ticketKey: 'DAT-105',
      })
    ).resolves.toEqual(row);
    expect(q).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO app.notifications'), [
      'dev@datavail.com',
      'assignment',
      'DAT-105 assigned',
      'Build it',
      'DAT-105',
      null,
    ]);
  });

  it('does not create notifications for placeholder assignees', async () => {
    const q = vi.fn();
    await expect(
      createNotification(q, { recipient: '—', type: 'assignment', title: 'x', message: 'x' })
    ).resolves.toBeNull();
    expect(q).not.toHaveBeenCalled();
  });
});

describe('email digest', () => {
  const row = (type: string, title: string, ticket: string | null = 'DAT-107') => ({
    type,
    title,
    message: `${title} — details`,
    ticket_key: ticket,
  });

  it('includes stale-ticket nudges as their own leading section', () => {
    const digest = renderEmailDigest(
      [
        row('comment', 'New comment on DAT-105', 'DAT-105'),
        row('stale_nudge', 'DAT-107 has been quiet for 5 business days'),
        row('deploy', 'DAT-104 deployed', 'DAT-104'),
      ],
      'last 24 hours'
    );
    expect(digest).not.toBeNull();
    expect(digest?.subject).toBe('Cometloop digest — 3 updates, 1 stale ticket');
    expect(digest?.count).toBe(3);
    const text = digest?.text ?? '';
    expect(text).toContain('## Stale tickets — needs a move (1)');
    expect(text).toContain('[DAT-107] DAT-107 has been quiet for 5 business days');
    // Unknown types still land in the digest rather than silently vanishing.
    expect(text).toContain('## Updates (1)');
    expect(text.indexOf('Stale tickets')).toBeLessThan(text.indexOf('## Comments (1)'));
  });

  it('renders no digest at all for an empty window', () => {
    expect(renderEmailDigest([], 'last 24 hours')).toBeNull();
  });
});
