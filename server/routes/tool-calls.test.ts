import { describe, expect, it } from 'vitest';
import { archivePath, toNdjson } from './tool-calls';

const task = { id: 42, ticket_key: 'DAT-145', engagement_id: 'execution-console' };

describe('archivePath', () => {
  it('files each run under its engagement and ticket', () => {
    expect(archivePath(task)).toBe('tool-calls/execution-console/DAT-145/task-42.ndjson');
  });
});

describe('toNdjson', () => {
  it('emits one JSON line per call, newline-terminated', () => {
    const out = toNdjson(task, [
      { agent: 'devbox-1', tool: 'Bash', detail: 'git status', called_at: new Date('2026-08-11T12:00:00Z') },
      { agent: 'devbox-1', tool: 'Read', detail: 'server/server.ts', called_at: '2026-08-11T12:00:05Z' },
    ]);
    expect(out.endsWith('\n')).toBe(true);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      task_id: 42,
      ticket_key: 'DAT-145',
      engagement_id: 'execution-console',
      agent: 'devbox-1',
      tool: 'Bash',
      detail: 'git status',
      called_at: '2026-08-11T12:00:00.000Z',
    });
    expect(lines[1].called_at).toBe('2026-08-11T12:00:05Z');
  });

  it('coerces missing or non-string fields to empty strings', () => {
    const line = JSON.parse(toNdjson(task, [{ tool: 'Bash' }]).trim()) as Record<string, unknown>;
    expect(line.agent).toBe('');
    expect(line.detail).toBe('');
    expect(line.called_at).toBe('');
  });
});
