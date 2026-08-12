import { describe, expect, it } from 'vitest';
import { findTicketKey, rememberDelivery } from './repos';

describe('findTicketKey', () => {
  it('finds a ticket key in a branch name', () => {
    expect(findTicketKey('DAT-153-pr-status-sync')).toBe('DAT-153');
  });

  it('scans texts in order and returns the first hit', () => {
    expect(findTicketKey('feature/no-key', 'DAT-9: add thing')).toBe('DAT-9');
  });

  it('returns null when no key is present', () => {
    expect(findTicketKey('main', 'chore: bump deps')).toBeNull();
  });
});

describe('rememberDelivery', () => {
  it('accepts a first delivery and rejects its redelivery', () => {
    const now = 1_000_000;
    expect(rememberDelivery('gh-delivery-1', now)).toBe(true);
    expect(rememberDelivery('gh-delivery-1', now + 5_000)).toBe(false);
  });

  it('tracks distinct delivery ids independently', () => {
    const now = 2_000_000;
    expect(rememberDelivery('gh-delivery-2', now)).toBe(true);
    expect(rememberDelivery('gh-delivery-3', now)).toBe(true);
  });

  it('forgets a delivery after the retention window', () => {
    const now = 3_000_000;
    expect(rememberDelivery('gh-delivery-4', now)).toBe(true);
    expect(rememberDelivery('gh-delivery-4', now + 16 * 60_000)).toBe(true);
  });
});
