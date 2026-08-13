import { describe, expect, it, vi } from 'vitest';
import { filePatternMatches, runFileRules } from './file-library';

describe('file automation', () => {
  it('matches configurable glob patterns case-insensitively', () => {
    expect(filePatternMatches('*.txt', 'Weekly Notes.TXT')).toBe(true);
    expect(filePatternMatches('standup-??.md', 'standup-12.md')).toBe(true);
    expect(filePatternMatches('*.txt', 'notes.pdf')).toBe(false);
  });

  it('creates a review ticket when a create rule matches', async () => {
    const statements: string[] = [];
    const q = vi.fn((sql: string) => {
      statements.push(sql);
      if (sql.startsWith('SELECT * FROM app.file_rules')) {
        return Promise.resolve({ rows: [{ id: 'rule-1', file_pattern: '*.txt', action_type: 'create_ticket', target_ticket: null }] });
      }
      if (sql.startsWith('SELECT client')) return Promise.resolve({ rows: [{ client: 'Datavail' }] });
      if (sql.startsWith('SELECT key')) return Promise.resolve({ rows: [{ key: 'DAT-201' }] });
      return Promise.resolve({ rows: [] });
    });

    const fired = await runFileRules(q, 'eng-1', 'folder-1', 'file-1', 'planning.txt');

    expect(fired).toEqual([{ ruleId: 'rule-1', actionType: 'create_ticket', ticketKey: 'DAT-202' }]);
    expect(statements.some((sql) => sql.includes('INSERT INTO app.tickets'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO app.file_rule_runs'))).toBe(true);
  });

  it('does nothing when the uploaded filename does not match', async () => {
    const q = vi.fn(() => Promise.resolve({ rows: [{ id: 'rule-1', file_pattern: '*.txt', action_type: 'create_ticket' }] }));
    expect(await runFileRules(q, 'eng-1', 'folder-1', 'file-1', 'notes.pdf')).toEqual([]);
    expect(q).toHaveBeenCalledTimes(1);
  });

  it('reuses the ticket refinement flow for refine rules', async () => {
    const q = vi.fn((sql: string) =>
      Promise.resolve(
        sql.startsWith('SELECT * FROM app.file_rules')
          ? { rows: [{ id: 'rule-2', file_pattern: '*.md', action_type: 'refine_ticket', target_ticket: 'DAT-199' }] }
          : { rows: [] },
      ),
    );
    const refine = vi.fn(() => Promise.resolve(undefined));

    const fired = await runFileRules(q, 'eng-1', 'folder-1', 'file-2', 'decisions.md', refine);

    expect(fired[0]?.ticketKey).toBe('DAT-199');
    expect(refine).toHaveBeenCalledWith('DAT-199', expect.stringContaining('decisions.md'));
  });
});
