import { describe, expect, it } from 'vitest';
import { CreateTicketBody, PatchTicketBody, seedEstimates } from './api';

/**
 * DAT-207: est_hours and human_est_hours are populated by the ticket agent,
 * so they are optional on create (DAT-195 had made them mandatory human
 * input). Supplying them is still allowed — they must then be a valid pair,
 * because the agent writes both or neither. Revisions keep the DAT-195 rule:
 * an existing estimate can be changed but never cleared.
 */

describe('CreateTicketBody — estimates are optional, the agent fills them in', () => {
  const base = { description: 'Do the thing' };

  it('accepts a create with no estimates at all', () => {
    expect(CreateTicketBody.safeParse(base).success).toBe(true);
    expect(CreateTicketBody.safeParse({ title: 'T' }).success).toBe(true);
  });

  it('accepts a create that supplies both estimates', () => {
    expect(CreateTicketBody.safeParse({ ...base, estHours: 0.5, humanEstHours: 4 }).success).toBe(true);
    expect(CreateTicketBody.safeParse({ title: 'T', estHours: 2, humanEstHours: 8 }).success).toBe(true);
  });

  it('rejects a lone estimate — the pair is written together', () => {
    expect(CreateTicketBody.safeParse({ ...base, estHours: 1 }).success).toBe(false);
    expect(CreateTicketBody.safeParse({ ...base, humanEstHours: 4 }).success).toBe(false);
  });

  it('rejects zero, negative, null and non-numeric estimates', () => {
    expect(CreateTicketBody.safeParse({ ...base, estHours: 0, humanEstHours: 4 }).success).toBe(false);
    expect(CreateTicketBody.safeParse({ ...base, estHours: -1, humanEstHours: 4 }).success).toBe(false);
    expect(CreateTicketBody.safeParse({ ...base, estHours: null, humanEstHours: 4 }).success).toBe(false);
    expect(CreateTicketBody.safeParse({ ...base, estHours: '2', humanEstHours: 4 }).success).toBe(false);
  });

  it('rejects estimates beyond the storage ceilings', () => {
    expect(CreateTicketBody.safeParse({ ...base, estHours: 401, humanEstHours: 4 }).success).toBe(false);
    expect(CreateTicketBody.safeParse({ ...base, estHours: 1, humanEstHours: 1000 }).success).toBe(false);
  });

  it('still requires a title or description', () => {
    expect(CreateTicketBody.safeParse({}).success).toBe(false);
    expect(CreateTicketBody.safeParse({ estHours: 1, humanEstHours: 4 }).success).toBe(false);
  });
});

describe('PatchTicketBody — estimates can be revised but never cleared', () => {
  it('accepts a patch that leaves estimates untouched', () => {
    expect(PatchTicketBody.safeParse({ status: 'progress' }).success).toBe(true);
  });

  it('accepts positive revisions', () => {
    expect(PatchTicketBody.safeParse({ estHours: 2.5 }).success).toBe(true);
    expect(PatchTicketBody.safeParse({ humanEstHours: 12 }).success).toBe(true);
  });

  it('rejects clearing either estimate with null', () => {
    expect(PatchTicketBody.safeParse({ estHours: null }).success).toBe(false);
    expect(PatchTicketBody.safeParse({ humanEstHours: null }).success).toBe(false);
  });

  it('rejects zero and negative revisions', () => {
    expect(PatchTicketBody.safeParse({ estHours: 0 }).success).toBe(false);
    expect(PatchTicketBody.safeParse({ humanEstHours: -3 }).success).toBe(false);
  });
});

describe('seedEstimates — deterministic values for server-seeded tickets', () => {
  it('takes hour-suffixed est labels at face value, human at the 4x ratio', () => {
    expect(seedEstimates('2h')).toEqual({ estHours: 2, humanEstHours: 8 });
    expect(seedEstimates('0.5h')).toEqual({ estHours: 0.5, humanEstHours: 2 });
    expect(seedEstimates('12H')).toEqual({ estHours: 12, humanEstHours: 48 });
  });

  it('defaults day labels, dashes and missing labels to 1h / 4h', () => {
    expect(seedEstimates('3d')).toEqual({ estHours: 1, humanEstHours: 4 });
    expect(seedEstimates('—')).toEqual({ estHours: 1, humanEstHours: 4 });
    expect(seedEstimates(undefined)).toEqual({ estHours: 1, humanEstHours: 4 });
    expect(seedEstimates('')).toEqual({ estHours: 1, humanEstHours: 4 });
  });

  it('clamps to the storage ceilings', () => {
    expect(seedEstimates('600h')).toEqual({ estHours: 400, humanEstHours: 999 });
  });
});
