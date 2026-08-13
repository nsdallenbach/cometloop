import { describe, expect, it, vi } from 'vitest';
import { createNotification, mentionedEmails } from './notifications';

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
