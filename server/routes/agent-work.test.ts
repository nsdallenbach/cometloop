import { describe, it, expect } from 'vitest';
import { renderPrompt } from './agent-work';

const task = { id: 7, ticket_key: 'DAT-146', agent: 'devbox-1', instructions: '' };
const ticket = { title: 'Validate comment steering', description: 'Do the thing.', ac: '[]' };
const engagement = { client: 'DATAVAIL', name: 'Execution Console' };

describe('renderPrompt ticket comments', () => {
  it('omits the comments section when there are none', () => {
    const prompt = renderPrompt(task, ticket, engagement, null, [], []);
    expect(prompt).not.toContain('## Ticket comments');
    expect(prompt).toContain('Steering via comments');
  });

  it('renders author, timestamp and body, and marks comments as steering', () => {
    const comments = [
      { author: 'nigel.silva@datavail.com', body: 'Please target the staging config only.', created_at: '2026-08-11T05:00:00Z' },
    ];
    const prompt = renderPrompt(task, ticket, engagement, null, [], comments);
    expect(prompt).toContain('## Ticket comments');
    expect(prompt).toContain('- nigel.silva@datavail.com (2026-08-11T05:00:00Z): Please target the staging config only.');
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

describe('renderPrompt review rejections', () => {
  const rejection = (n: number, reason: string) => ({
    id: n,
    reason,
    rejectedBy: 'lead@datavail.com',
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
