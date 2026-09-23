import { afterEach, describe, expect, it } from 'vitest';
import { installFakeProvider, resetLlm, withFakeRoles, type Query } from '../llm/test-support';
import {
  NEEDS_ESTIMATE_TAG,
  acList,
  clearNeedsEstimateFlag,
  ensureTicketHours,
  hasNeedsEstimateTag,
  hoursMissing,
  hoursPopulated,
  parseTags,
  withNeedsEstimateTag,
  withoutNeedsEstimateTag,
} from './ticket-hours';

/**
 * DAT-207: hours are populated by the ticket agent on every create path, and
 * a ticket that lands without them is flagged rather than silently persisted.
 */

describe('parseTags', () => {
  it('reads JSONB arrays and their JSON text form', () => {
    expect(parseTags(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseTags('["a","b"]')).toEqual(['a', 'b']);
  });

  it('is total on junk', () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags('not json')).toEqual([]);
    expect(parseTags('{"a":1}')).toEqual([]);
    expect(parseTags([1, 'keep', null])).toEqual(['keep']);
  });
});

describe('the needs-estimate flag', () => {
  it('matches case-insensitively', () => {
    expect(hasNeedsEstimateTag(['Needs-Estimate-Review'])).toBe(true);
    expect(hasNeedsEstimateTag(['other'])).toBe(false);
  });

  it('adds idempotently and removes every spelling', () => {
    expect(withNeedsEstimateTag([])).toEqual([NEEDS_ESTIMATE_TAG]);
    expect(withNeedsEstimateTag([NEEDS_ESTIMATE_TAG])).toEqual([NEEDS_ESTIMATE_TAG]);
    expect(withNeedsEstimateTag(['keep'])).toEqual(['keep', NEEDS_ESTIMATE_TAG]);
    expect(withoutNeedsEstimateTag(['keep', 'NEEDS-ESTIMATE-REVIEW'])).toEqual(['keep']);
  });
});

describe('hoursPopulated / hoursMissing', () => {
  it('requires both figures to be positive numbers', () => {
    expect(hoursPopulated(1, 4)).toBe(true);
    // Postgres REAL/NUMERIC can arrive as strings.
    expect(hoursPopulated('1.5', '6')).toBe(true);
    expect(hoursPopulated(1, null)).toBe(false);
    expect(hoursPopulated(null, 4)).toBe(false);
    expect(hoursPopulated(0, 4)).toBe(false);
    expect(hoursPopulated(-1, 4)).toBe(false);
    expect(hoursPopulated('n/a', 4)).toBe(false);
  });

  it('treats a flagged row as missing even though its columns are filled', () => {
    // Provisional placeholders written at insert — NOT NULL columns cannot
    // hold "unknown", so the tag is what marks them as un-populated.
    expect(hoursMissing({ est_hours: 1, human_est_hours: 4, tags: [NEEDS_ESTIMATE_TAG] })).toBe(true);
    expect(hoursMissing({ est_hours: 1, human_est_hours: 4, tags: [] })).toBe(false);
    expect(hoursMissing({ est_hours: null, human_est_hours: 4, tags: [] })).toBe(true);
  });
});

describe('acList', () => {
  it('coerces JSONB acceptance criteria defensively', () => {
    expect(acList(['a'])).toEqual(['a']);
    expect(acList('["a"]')).toEqual(['a']);
    expect(acList(null)).toEqual([]);
    expect(acList('nonsense')).toEqual([]);
  });
});

// ---------- ensureTicketHours: the create-time flow ----------

interface FakeTicket {
  est_hours: number | null;
  human_est_hours: number | null;
  tags: string[];
  est: string;
}

/**
 * Minimal in-memory stand-in for the Lakebase query function: routes on the
 * SQL text the way the real statements are written, so the flow under test
 * (read → estimate → re-read → retag) exercises real control flow.
 */
function fakeDb(ticket: FakeTicket) {
  const feed: string[] = [];
  const estimateRows: unknown[][] = [];
  const q = (text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    if (text.includes('SELECT est_hours, human_est_hours, tags FROM app.tickets')) {
      return Promise.resolve({ rows: [{ ...ticket }] });
    }
    if (text.includes('FROM app.engagements')) return Promise.resolve({ rows: [{ client: 'C', name: 'N', phase: 'P' }] });
    if (text.includes('FROM app.ticket_estimates e JOIN')) return Promise.resolve({ rows: [] });
    if (text.includes('INSERT INTO app.ticket_estimates')) {
      estimateRows.push(params);
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('UPDATE app.tickets SET est = $2, est_hours = $3, human_est_hours = $4')) {
      ticket.est = String(params[1]);
      ticket.est_hours = Number(params[2]);
      ticket.human_est_hours = Number(params[3]);
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('UPDATE app.tickets SET tags = $2')) {
      ticket.tags = JSON.parse(String(params[1])) as string[];
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('INSERT INTO app.feed_items')) {
      feed.push(String(params[1]));
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  };
  return { q, feed, estimateRows };
}

/**
 * The estimate role answers with whatever text the test wants. The fake
 * adapter sits behind the real `invokeModel`, and the role-resolution reads
 * are answered by `withFakeRoles` over the test's own query stub.
 */
function fakeModel(q: Query, content: string) {
  const fake = installFakeProvider(withFakeRoles(q), 'anthropic', [content, content]);
  return { calls: () => fake.calls.length };
}

afterEach(resetLlm);

const INPUT = { key: 'DAT-1', engagementId: 'eng', title: 'T', description: 'D', ac: ['a'] };

describe('ensureTicketHours', () => {
  it('leaves a ticket that already has hours alone', async () => {
    const db = fakeDb({ est_hours: 2, human_est_hours: 8, tags: [], est: '2h' });
    const model = fakeModel(db.q, '{"hours": 9, "human_hours": 9}');

    const result = await ensureTicketHours(db.q, INPUT);

    expect(result).toEqual({ key: 'DAT-1', status: 'ready', estHours: 2, humanEstHours: 8, estimated: false });
    expect(model.calls()).toBe(0); // no model spend on a ticket that is already complete
  });

  it('populates hours and clears the flag when the agent produces an estimate', async () => {
    const ticket: FakeTicket = { est_hours: 1, human_est_hours: 4, tags: ['keep', NEEDS_ESTIMATE_TAG], est: '—' };
    const db = fakeDb(ticket);
    const model = fakeModel(db.q, '{"hours": 2.5, "human_hours": 10, "confidence": "high", "rationale": "r"}');

    const result = await ensureTicketHours(db.q, INPUT);

    expect(model.calls()).toBe(1);
    expect(result.status).toBe('ready');
    expect(result.estimated).toBe(true);
    expect(result.estHours).toBe(2.5);
    expect(result.humanEstHours).toBe(10);
    expect(ticket.est).toBe('2.5h');
    expect(ticket.tags).toEqual(['keep']); // flag cleared, other tags untouched
  });

  it('keeps the ticket flagged and announces it when the model returns nothing usable', async () => {
    const ticket: FakeTicket = { est_hours: 1, human_est_hours: 4, tags: [NEEDS_ESTIMATE_TAG], est: '—' };
    const db = fakeDb(ticket);
    fakeModel(db.q, 'I am afraid I cannot help with that.');

    const result = await ensureTicketHours(db.q, INPUT);

    expect(result.status).toBe('flagged');
    expect(ticket.tags).toEqual([NEEDS_ESTIMATE_TAG]);
    expect(db.feed.some((f) => f.includes('DAT-1') && f.includes(NEEDS_ESTIMATE_TAG))).toBe(true);
  });

  it('flags a ticket whose hour columns are empty even with no tag on it', async () => {
    const ticket: FakeTicket = { est_hours: null, human_est_hours: null, tags: [], est: '—' };
    const db = fakeDb(ticket);
    fakeModel(db.q, 'no json here');

    const result = await ensureTicketHours(db.q, INPUT);

    expect(result.status).toBe('flagged');
    expect(ticket.tags).toEqual([NEEDS_ESTIMATE_TAG]); // flag added, not just kept
  });

  it('keeps the flag when the model answers with provisional-looking hours it never wrote', async () => {
    // The row still holds the 1h/4h placeholders from insert. They are
    // non-null, so a row-only recheck would call this ready — the exact
    // silent-incomplete case the flag exists to prevent.
    const ticket: FakeTicket = { est_hours: 1, human_est_hours: 4, tags: [NEEDS_ESTIMATE_TAG], est: '—' };
    const db = fakeDb(ticket);
    fakeModel(db.q, '{"confidence": "low"}'); // no hours field — unusable

    const result = await ensureTicketHours(db.q, INPUT);

    expect(result.status).toBe('flagged');
    expect(ticket.tags).toEqual([NEEDS_ESTIMATE_TAG]);
  });

  it('reports a vanished ticket as flagged rather than throwing', async () => {
    const q: Query = () => Promise.resolve({ rows: [] });
    const model = fakeModel(q, '{"hours": 1}');

    const result = await ensureTicketHours(q, INPUT);

    expect(result.status).toBe('flagged');
    expect(model.calls()).toBe(0);
  });
});

describe('clearNeedsEstimateFlag', () => {
  it('drops the flag once a human has set real hours', async () => {
    const ticket: FakeTicket = { est_hours: 3, human_est_hours: 12, tags: ['keep', NEEDS_ESTIMATE_TAG], est: '3h' };
    const db = fakeDb(ticket);

    await clearNeedsEstimateFlag(db.q, 'DAT-1');

    expect(ticket.tags).toEqual(['keep']);
  });

  it('leaves the flag on while either figure is still missing', async () => {
    const ticket: FakeTicket = { est_hours: 3, human_est_hours: null, tags: [NEEDS_ESTIMATE_TAG], est: '3h' };
    const db = fakeDb(ticket);

    await clearNeedsEstimateFlag(db.q, 'DAT-1');

    expect(ticket.tags).toEqual([NEEDS_ESTIMATE_TAG]);
  });
});
