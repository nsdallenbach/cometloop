import { describe, expect, it } from 'vitest';
import {
  BRIEF_MAX_CHARS,
  BRIEF_MIN_CHARS,
  CLIENT_PLACEHOLDER,
  NAME_PLACEHOLDER,
  buildImportPrompt,
} from '../client/src/lib/import-prompt';

describe('buildImportPrompt', () => {
  it('falls back to placeholders when client/name are blank', () => {
    for (const p of [buildImportPrompt(), buildImportPrompt('', '  ')]) {
      expect(p).toContain(CLIENT_PLACEHOLDER);
      expect(p).toContain(NAME_PLACEHOLDER);
    }
  });

  it('substitutes provided client and engagement names everywhere', () => {
    const p = buildImportPrompt('  Acme Corp ', 'ERP Replatform');
    expect(p).toContain('"Acme Corp"');
    expect(p).toContain('"ERP Replatform"');
    expect(p).not.toContain(CLIENT_PLACEHOLDER);
    expect(p).not.toContain(NAME_PLACEHOLDER);
  });

  it('covers gathering context and mapping to the console structure', () => {
    const p = buildImportPrompt();
    // Context-gathering instructions.
    for (const term of ['GATHER', 'Goals and scope', 'backlog', 'Milestones', 'Team and cadence']) {
      expect(p).toContain(term);
    }
    // Mapping to what the plan parser derives, with its real limits.
    expect(p).toContain(`${BRIEF_MIN_CHARS} and ${String(BRIEF_MAX_CHARS)} characters`);
    for (const term of ['3-6 phases', '3-6 dated milestones', '10-16 draft tickets', 'day estimate']) {
      expect(p).toContain(term);
    }
    // The actual console path the brief goes through, and follow-up steps.
    for (const term of ['New engagement', 'Describe the project', 'Sources tab', 'Standards tab']) {
      expect(p).toContain(term);
    }
  });

  it('stays well under the brief character cap even with long names', () => {
    const p = buildImportPrompt('C'.repeat(120), 'N'.repeat(200));
    expect(p.length).toBeLessThan(BRIEF_MAX_CHARS);
  });
});
