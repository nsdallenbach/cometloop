import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getHarness, toolLabel } from '../devbox-runner/harnesses.mjs';
import { HARNESS_PROVIDER, inferHarness } from '../server/routes/agents';
import {
  agentBrand,
  harnessBrand,
  providerBrand,
  HARNESS_DEFAULT_PROVIDER,
  HARNESS_OPTIONS,
  PROVIDER_OPTIONS,
} from '../client/src/components/AgentLogos';

/**
 * Smoke test for the harness abstraction — the seam that lets the fleet run any
 * coding agent (DAT-205). It has two halves that nothing else pins together:
 *
 * - Runner side (devbox-runner/harnesses.mjs): adapters say how to launch an
 *   agent, how to read its stream into the live tool feed, and how to wire MCP.
 *   runner.mjs touches none of that, so a broken adapter only surfaces at run
 *   time on a devbox — these tests catch it in CI instead.
 * - Console side (server inferHarness/HARNESS_PROVIDER ↔ client brand tables):
 *   three hand-maintained tables of the same harness ids. When they drift, the
 *   agent map silently loses logos or persists providers the client can't
 *   resolve.
 *
 * These are deliberately shallow: shape, ids and wiring, no behavior worth
 * mocking a process for.
 */

interface Emitted {
  kind: 'print' | 'tool';
  text: string;
}

/** Stands in for runner.mjs's emit sink, flattening tool calls to name:label. */
function capture(): { out: Emitted[]; emit: { print: (t: string) => void; tool: (n: string, i: unknown) => void } } {
  const out: Emitted[] = [];
  return {
    out,
    emit: {
      print: (text) => out.push({ kind: 'print', text }),
      tool: (name, input) => out.push({ kind: 'tool', text: `${name}:${toolLabel(input)}` }),
    },
  };
}

const GENERIC_ENV = { AGENT_BIN: 'aider' };

describe('runner harness adapters', () => {
  it('defaults to Claude Code and exposes the documented adapter shape', () => {
    const h = getHarness(undefined, {});
    expect(h.name).toBe('claude');
    expect(h.bin).toBe('claude');
    expect(h.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
    expect(h.promptVia).toBe('stdin');
  });

  it('resolves every documented harness id, case-insensitively', () => {
    for (const id of ['claude', 'codex', 'generic', 'CODEX']) {
      const h = getHarness(id, GENERIC_ENV);
      expect(typeof h.name, id).toBe('string');
      expect(h.name.length, id).toBeGreaterThan(0);
      expect(typeof h.bin, id).toBe('string');
      expect(h.bin.length, id).toBeGreaterThan(0);
      expect(Array.isArray(h.args), id).toBe(true);
      expect(['stdin', 'arg'], id).toContain(h.promptVia);
      expect(typeof h.parseLine, id).toBe('function');
      expect(typeof h.writeConfig, id).toBe('function');
    }
  });

  it('rejects an unknown harness instead of silently running Claude', () => {
    // 'cursor' is a console harness id but has no runner adapter — the runner
    // must fail loudly rather than run a different agent than the fleet expects.
    expect(() => getHarness('cursor', {})).toThrow(/Unknown HARNESS/);
  });

  it('takes the executable and its arguments from the environment', () => {
    const claude = getHarness('claude', { CLAUDE_BIN: '/opt/bin/claude', CLAUDE_ARGS: '--permission-mode plan' });
    expect(claude.bin).toBe('/opt/bin/claude');
    expect(claude.args.slice(-2)).toEqual(['--permission-mode', 'plan']);

    const codex = getHarness('codex', { CODEX_BIN: '/opt/bin/codex', CODEX_PROMPT_VIA: 'arg' });
    expect(codex.bin).toBe('/opt/bin/codex');
    expect(codex.promptVia).toBe('arg');

    const generic = getHarness('generic', { AGENT_BIN: 'aider', AGENT_LABEL: 'aider', AGENT_ARGS: '--yes --model x' });
    expect(generic.name).toBe('aider');
    expect(generic.args).toEqual(['--yes', '--model', 'x']);
  });

  it('refuses a generic harness with no executable to run', () => {
    expect(() => getHarness('generic', {})).toThrow(/AGENT_BIN/);
  });

  it('turns Claude stream-json into prints and tool calls', () => {
    const h = getHarness('claude', {});
    const { out, emit } = capture();
    h.parseLine(JSON.stringify({ type: 'system', subtype: 'init' }), emit);
    h.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'planning the change' },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'server/routes/agents.ts' } },
          ],
        },
      }),
      emit
    );
    h.parseLine('not json at all', emit);

    // system/user events are noise and stay out of the feed; anything unparsable
    // is shown raw rather than swallowed.
    expect(out).toEqual([
      { kind: 'print', text: 'planning the change' },
      { kind: 'tool', text: 'Edit:server/routes/agents.ts' },
      { kind: 'print', text: 'not json at all' },
    ]);
  });

  it('matches Codex JSONL events and degrades to raw lines', () => {
    // Real `codex exec --json` output: each action is an item wrapped in an
    // item.started / item.completed envelope. A command is logged as it starts,
    // text and edits once they complete.
    const h = getHarness('codex', {});
    const { out, emit } = capture();
    h.parseLine(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }), emit);
    h.parseLine(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', path: 'client/src/components/AgentMap.tsx' },
      }),
      emit
    );
    h.parseLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }), emit);
    h.parseLine('plain progress line', emit);

    expect(out).toEqual([
      { kind: 'tool', text: 'shell:npm test' },
      { kind: 'tool', text: 'edit:client/src/components/AgentMap.tsx' },
      { kind: 'print', text: 'done' },
      { kind: 'print', text: 'plain progress line' },
    ]);
  });

  it('passes an unstructured agent through line for line', () => {
    const h = getHarness('generic', GENERIC_ENV);
    const { out, emit } = capture();
    h.parseLine('{"type":"assistant"}', emit);
    h.parseLine('working…', emit);
    expect(out).toEqual([
      { kind: 'print', text: '{"type":"assistant"}' },
      { kind: 'print', text: 'working…' },
    ]);
  });

  it('wires the delivery-console MCP server into a Claude workdir only', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-smoke-'));
    try {
      getHarness('claude', {}).writeConfig(dir, 'mcp/server.mjs');
      const server = JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers['delivery-console'];
      expect(server.command).toBe('node');
      // Absolute: the agent runs with the workdir as cwd, not the runner's.
      expect(path.isAbsolute(server.args[0])).toBe(true);
      expect(server.args[0].endsWith(path.join('mcp', 'server.mjs'))).toBe(true);

      // Codex reads MCP from its global config and the generic agent has none;
      // neither may leave anything behind in the workdir.
      getHarness('codex', {}).writeConfig(dir, 'mcp/server.mjs');
      getHarness('generic', GENERIC_ENV).writeConfig(dir, 'mcp/server.mjs');
      expect(readdirSync(dir)).toEqual(['.mcp.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('labels tool calls by path, command, then a JSON prefix', () => {
    expect(toolLabel({ file_path: 'a.ts', command: 'ignored' })).toBe('a.ts');
    expect(toolLabel({ command: 'npm run build' })).toBe('npm run build');
    expect(toolLabel({ path: 'docs/standards.md' })).toBe('docs/standards.md');
    expect(toolLabel(undefined)).toBe('{}');
    expect(toolLabel({ pattern: 'x'.repeat(200) })).toHaveLength(60);
  });
});

describe('server ↔ client harness tables', () => {
  it('offers exactly the harnesses the server knows about', () => {
    expect(HARNESS_OPTIONS.map((o) => o.id).sort()).toEqual(Object.keys(HARNESS_PROVIDER).sort());
  });

  it('mirrors the server default provider for every harness', () => {
    // AgentMap used to keep its own copy of this map, with cursor mapped to ''
    // while the sync pass persisted 'anysphere'.
    expect(HARNESS_DEFAULT_PROVIDER).toEqual(HARNESS_PROVIDER);
  });

  it('has a client logo for every provider the server persists', () => {
    const options = PROVIDER_OPTIONS.map((o) => o.id);
    for (const provider of Object.values(HARNESS_PROVIDER)) {
      expect(providerBrand(provider), provider).not.toBeNull();
      expect(options, provider).toContain(provider);
    }
  });

  it('only ever infers a harness id the map can render', () => {
    const known = Object.keys(HARNESS_PROVIDER);
    for (const name of ['local-runner', 'devbox-codex-3', 'Gemini-Runner', 'gh-copilot-1', 'cursor-box', '']) {
      expect(known, name).toContain(inferHarness(name));
    }
    // Unnamed runners are Claude Code — the fleet default.
    expect(inferHarness('local-runner')).toBe('claude-code');
  });

  it('links runner harness names to the console ids they show up as', () => {
    // The runner's HARNESS values are short ('claude'); the console's ids are
    // brand ids ('claude-code'). This is the one place the two id spaces meet.
    for (const [runner, consoleId] of Object.entries({ claude: 'claude-code', codex: 'codex' })) {
      expect(getHarness(runner, {}).name).toBe(runner);
      expect(inferHarness(`devbox-${runner}-1`)).toBe(consoleId);
      expect(Object.keys(HARNESS_PROVIDER)).toContain(consoleId);
    }
  });

  it('resolves harness logos through normalized ids and misses cleanly', () => {
    expect(harnessBrand('claude-code')?.label).toBe('Claude Code');
    expect(harnessBrand(' Claude_Code ')?.label).toBe('Claude Code');
    expect(harnessBrand('sourcegraph-amp')).toBeNull();
    expect(harnessBrand(null)).toBeNull();
  });

  it('prefers the harness logo, falls back to the provider, then to nothing', () => {
    expect(agentBrand({ harness: 'codex', modelProvider: 'anthropic' })?.label).toBe('Codex');
    expect(agentBrand({ harness: null, modelProvider: 'databricks' })?.label).toBe('Databricks');
    expect(agentBrand({ harness: 'cursor', modelProvider: 'anysphere' })?.label).toBe('Cursor');
    expect(agentBrand({ harness: 'sourcegraph-amp', modelProvider: null })).toBeNull();
  });
});
