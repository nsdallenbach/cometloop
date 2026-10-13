import { describe, it, expect } from 'vitest';
import { blockedByRun, renderPrompt } from './agent-work';
import { COMMENT_STYLE_RULES } from './comment-style';

const task = { id: 7, ticket_key: 'DAT-146', agent: 'devbox-1', instructions: '' };
const ticket = { title: 'Validate comment steering', description: 'Do the thing.', ac: '[]' };
const engagement = { client: 'ACME', name: 'Execution Console' };

describe('renderPrompt ticket comments', () => {
  it('omits the comments section when there are none', () => {
    const prompt = renderPrompt(task, ticket, engagement, null, [], []);
    expect(prompt).not.toContain('## Ticket comments');
    expect(prompt).toContain('Steering via comments');
  });

  it('renders author, timestamp and body, and marks comments as steering', () => {
    const comments = [
      { author: 'dev@example.com', body: 'Please target the staging config only.', created_at: '2026-08-11T05:00:00Z' },
    ];
    const prompt = renderPrompt(task, ticket, engagement, null, [], comments);
    expect(prompt).toContain('## Ticket comments');
    expect(prompt).toContain('- dev@example.com (2026-08-11T05:00:00Z): Please target the staging config only.');
    expect(prompt).toContain('treat them as instructions');
  });

  it('keeps only the newest comments when over the limit, and says so', () => {
    const comments = Array.from({ length: 25 }, (_, i) => ({ author: 'lead', body: `note ${i}`, created_at: '' }));
    const prompt = renderPrompt(task, ticket, engagement, null, [], comments);
    expect(prompt).toContain('## Ticket comments (latest 20 of 25)');
    expect(prompt).not.toContain('note 4'); // oldest 5 dropped
    expect(prompt).toContain('note 24'); // newest survives the cap
  });

  it('truncates oversized comment bodies and skips empty ones', () => {
    const comments = [
      { author: 'lead', body: 'x'.repeat(5000), created_at: '' },
      { author: 'lead', body: '   ', created_at: '' },
    ];
    const prompt = renderPrompt(task, ticket, engagement, null, [], comments);
    expect(prompt).toContain('x'.repeat(1500));
    expect(prompt).not.toContain('x'.repeat(1501));
    expect(prompt.match(/^- lead/gm)).toHaveLength(1);
  });

  it('tells the agent to re-read comments mid-run via get_ticket', () => {
    const prompt = renderPrompt(task, ticket, engagement, null, [], []);
    expect(prompt).toContain('get_ticket (key DAT-146)');
  });
});

describe('blockedByRun', () => {
  const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

  it('says a queued ticket is simply already queued', () => {
    expect(blockedByRun({ id: 4, state: 'queued' }, NOW)).toBe('This ticket is already queued for agent work');
  });

  it('names the holder, how long it has been silent, and how to clear it', () => {
    // The zombie case: GET /api/agent/work showed nothing for the ticket, but
    // queueing it returned a bare 409 with no way to discover the block.
    const msg = blockedByRun(
      { id: 42, state: 'working', agent: 'devbox-2', last_heartbeat: new Date(NOW - 8 * 60 * 60_000) },
      NOW,
    );
    expect(msg).toContain('devbox-2');
    expect(msg).toContain('run 42');
    expect(msg).toContain('8h ago');
    expect(msg).toContain('Recall it first');
  });

  it('handles a claim that never heartbeated', () => {
    expect(blockedByRun({ id: 42, state: 'claimed', agent: 'devbox-2', last_heartbeat: null }, NOW)).toContain('never heartbeated');
  });
});

describe('renderPrompt review rejections', () => {
  const rejection = (n: number, reason: string) => ({
    id: n,
    reason,
    rejectedBy: 'lead@example.com',
    rejectedAt: `2026-08-1${n}T09:00:00.000Z`,
  });

  it('omits the section for a ticket that was never rejected', () => {
    expect(renderPrompt(task, ticket, engagement, null, [], [], [])).not.toContain('## Previous review rejections');
  });

  it('hands the runner every prior reason, newest last', () => {
    const prompt = renderPrompt(task, ticket, engagement, null, [], [], [], [
      rejection(1, 'No tests on the new endpoint.'),
      rejection(2, 'Still no tests.'),
    ]);
    expect(prompt).toContain('## Previous review rejections (2)');
    expect(prompt.indexOf('No tests on the new endpoint.')).toBeLessThan(prompt.indexOf('Still no tests.'));
  });

  it('puts the rejections ahead of the lead instructions and the comment thread', () => {
    const prompt = renderPrompt(
      { ...task, instructions: 'Ship it behind a flag.' },
      ticket,
      engagement,
      null,
      [],
      [{ author: 'lead', body: 'One more thing.', created_at: '' }],
      [],
      [rejection(1, 'Wrong lane after rejection.')],
    );
    expect(prompt.indexOf('## Previous review rejections')).toBeLessThan(prompt.indexOf('## Lead instructions'));
    expect(prompt.indexOf('## Previous review rejections')).toBeLessThan(prompt.indexOf('## Ticket comments'));
  });
});

describe('renderPrompt comment formatting rules (DAT-204)', () => {
  const prompt = renderPrompt(task, ticket, engagement, null, [], []);

  it('carries the shared formatting section', () => {
    expect(prompt).toContain('## Writing comments on the ticket');
    for (const rule of COMMENT_STYLE_RULES) expect(prompt).toContain(`- ${rule}`);
  });

  it('spells out line breaks, lists and short paragraphs', () => {
    expect(prompt).toContain('single newlines become line breaks');
    expect(prompt).toContain('Keep paragraphs to 1-3 sentences');
    expect(prompt).toMatch(/`-` bullets for unordered items/);
  });

  it('includes a worked example comment in the new style', () => {
    expect(prompt).toContain('Example of a well-formatted progress note:');
    expect(prompt).toContain('**Changed so far**');
  });

  it('applies to flags and completion summaries, not just progress notes', () => {
    expect(prompt).toContain('progress notes, flags, completion summaries');
  });

  it('sits between the delivery expectations and the coordination section', () => {
    const style = prompt.indexOf('## Writing comments on the ticket');
    expect(prompt.indexOf('## Delivery expectations')).toBeLessThan(style);
    expect(style).toBeLessThan(prompt.indexOf('## Coordinating with other agents'));
  });
});
