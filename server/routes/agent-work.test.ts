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
