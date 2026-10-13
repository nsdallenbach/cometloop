import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendSkillsTo,
  getHarness,
  isBlockedState,
  mcpServersConfig,
  missingAuthEnv,
  normalizeState,
  toolLabel,
  writeClaudeSkills,
} from '../devbox-runner/harnesses.mjs';
import { HARNESS_PROVIDER, inferHarness } from '../server/routes/agents';
import { inferHarness as inferRunnerHarness } from '../client/src/components/RunnerLogo';
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
    // Two adapter shapes now: process adapters are spawned, service adapters are
    // bridged to over HTTP. `mode` is what runner.mjs branches on, and it is
    // absent on the originals — so the default must stay 'process' forever.
    for (const id of ['claude', 'codex', 'generic', 'omnigent', 'CODEX', 'OMNIGENT']) {
      const h = getHarness(id, GENERIC_ENV);
      expect(typeof h.name, id).toBe('string');
      expect(h.name.length, id).toBeGreaterThan(0);
      expect(typeof h.writeConfig, id).toBe('function');

      if (h.mode === 'service') {
        for (const method of ['submit', 'poll', 'fetchResult', 'cancel']) {
          expect(typeof h[method], `${id}.${method}`).toBe('function');
        }
      } else {
        expect(h.mode ?? 'process', id).toBe('process');
        expect(typeof h.bin, id).toBe('string');
        expect(h.bin.length, id).toBeGreaterThan(0);
        expect(Array.isArray(h.args), id).toBe(true);
        expect(['stdin', 'arg'], id).toContain(h.promptVia);
        expect(typeof h.parseLine, id).toBe('function');
      }
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

      // Codex reads MCP from its global config, the generic agent has none, and
      // Omnigent never runs here at all; none may leave anything in the workdir.
      getHarness('codex', {}).writeConfig(dir, 'mcp/server.mjs');
      getHarness('generic', GENERIC_ENV).writeConfig(dir, 'mcp/server.mjs');
      getHarness('omnigent', {}).writeConfig(dir, 'mcp/server.mjs');
      expect(readdirSync(dir)).toEqual(['.mcp.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes Omnigent as a service adapter with env-driven server config', () => {
    // Omnigent is self-hosted, so the default base URL is a LOCAL server, not a
    // vendor SaaS — there is no api.omnigent.ai and no vendor API key.
    const h = getHarness('omnigent', {});
    expect(h.mode).toBe('service');
    expect(h.config.baseUrl).toBe('http://localhost:6767');
    expect(h.config.pollMs).toBe(15000);
    expect(h.config.harness).toBe('claude-sdk');

    // Guards the corrected credential model: an API-key field would reintroduce
    // the per-task vendor-key vending endpoint this design explicitly dropped.
    expect(h.config).not.toHaveProperty('apiKey');

    // The paths are the real ones from the published OpenAPI, not placeholders.
    expect(h.config.sessionsPath).toBe('/v1/sessions');
    expect(h.config.launchRunnerPath).toBe('/v1/hosts/{hostId}/runners');

    const custom = getHarness('omnigent', {
      OMNIGENT_BASE_URL: 'https://omnigent.internal/api/',
      OMNIGENT_SESSIONS_PATH: '/v2/sessions',
      OMNIGENT_POLL_MS: '2500',
      OMNIGENT_HARNESS: 'codex',
      OMNIGENT_MAX_COST_USD: '5',
    });
    expect(custom.config.baseUrl).toBe('https://omnigent.internal/api'); // trailing slash trimmed
    expect(custom.config.sessionsPath).toBe('/v2/sessions');
    expect(custom.config.pollMs).toBe(2500);
    expect(custom.config.harness).toBe('codex');
    expect(custom.config.maxCostUsd).toBe(5);
  });

  it('makes the Omnigent stub fail loudly, pointing at the design doc', () => {
    // Scaffolding must never look like a working runner: a silent no-op would
    // complete a real ticket as an empty success.
    const h = getHarness('omnigent', {});
    for (const method of ['submit', 'poll', 'fetchResult', 'cancel']) {
      expect(() => h[method]({}, {}), method).toThrow(/not implemented/i);
      expect(() => h[method]({}, {}), method).toThrow(/omnigent-runner-architecture\.md/);
    }
  });

  it('normalizes run states and refuses to guess at unknown ones', () => {
    expect(normalizeState('QUEUED')).toBe('running');
    expect(normalizeState('in_progress')).toBe('running');
    expect(normalizeState('completed')).toBe('succeeded');
    expect(normalizeState('  Success ')).toBe('succeeded');
    expect(normalizeState('errored')).toBe('failed');
    expect(normalizeState('timed_out')).toBe('failed');
    expect(normalizeState('canceled')).toBe('cancelled');

    // Unknown must be null, not a guess: 'failed' would bin finished work and
    // 'succeeded' would deliver an empty ticket. The poll loop keeps waiting and
    // the MAX_RUN_MINUTES watchdog is the backstop.
    for (const unknown of ['paused', 'needs_input', '', null, undefined]) {
      expect(normalizeState(unknown), String(unknown)).toBeNull();
    }
  });

  it("maps Omnigent's real status enum, and never reads bare 'idle' as success", () => {
    // The session status enum is idle|running|waiting|failed. `idle` means BOTH
    // "not started" and "finished the turn", so resolving it to 'succeeded'
    // would complete real tickets as empty successes — it must stay unresolved
    // and be decided by the response lifecycle plus a retrievable RESULT.md.
    expect(normalizeState('idle')).toBeNull();
    expect(normalizeState('running')).toBe('running');
    expect(normalizeState('failed')).toBe('failed');

    // `waiting` is alive but blocked on human input; the run continues (and the
    // poll loop flags it) rather than being binned as a failure.
    expect(normalizeState('waiting')).toBe('running');
    expect(isBlockedState('waiting')).toBe(true);
    expect(isBlockedState('running')).toBe(false);

    // Response-lifecycle events are what actually decide a terminal state.
    expect(normalizeState('response_completed')).toBe('succeeded');
    expect(normalizeState('response_failed')).toBe('failed');
    expect(normalizeState('response_cancelled')).toBe('cancelled');
    // Stopped early (truncation / limit hit) is not a delivery.
    expect(normalizeState('response_incomplete')).toBe('failed');
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
    for (const name of ['local-runner', 'devbox-codex-3', 'Gemini-Runner', 'gh-copilot-1', 'cursor-box', 'Omnigent-2', '']) {
      expect(known, name).toContain(inferHarness(name));
    }
    // Unnamed runners are Claude Code — the fleet default.
    expect(inferHarness('local-runner')).toBe('claude-code');
  });

  it('infers the same harness server-side and client-side', () => {
    // RunnerLogo.tsx keeps its own copy of inferHarness for runner avatars. The
    // two drifting means a runner is branded one way on the /agents map and
    // another on its ticket card — pin them instead of trusting the comment.
    for (const name of ['local-runner', 'devbox-codex-3', 'Gemini-Runner', 'gh-copilot-1', 'cursor-box', 'omnigent-1', '']) {
      expect(inferRunnerHarness(name), name).toBe(inferHarness(name));
    }
  });

  it('links runner harness names to the console ids they show up as', () => {
    // The runner's HARNESS values are short ('claude'); the console's ids are
    // brand ids ('claude-code'). This is the one place the two id spaces meet.
    for (const [runner, consoleId] of Object.entries({ claude: 'claude-code', codex: 'codex', omnigent: 'omnigent' })) {
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

// ---------- agent config delivery (DAT-279) ----------

const RUN_CONFIG = {
  model: 'claude-opus-5',
  mcpServers: [
    {
      slug: 'jira',
      name: 'Jira',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'jira-mcp'],
      url: null,
      env: { JIRA_SITE: 'your-org.atlassian.net' },
      requiresAuth: true,
      authEnv: 'MCP_AUTH_JIRA',
    },
    {
      slug: 'docs',
      name: 'Docs',
      transport: 'http' as const,
      command: null,
      args: [],
      url: 'https://mcp.example.com/docs',
      env: {},
      requiresAuth: false,
      authEnv: null,
    },
  ],
  skills: [
    {
      slug: 'review-style',
      name: 'Review style',
      description: 'How we review',
      content: '# Review\n\nBe kind.',
      harnesses: ['claude-code'],
    },
  ],
};

describe('agent config delivery (DAT-279)', () => {
  it('writes every attached server into a Claude .mcp.json with auth as an env reference, never a value', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-cfg-'));
    try {
      getHarness('claude', {}).writeConfig(dir, 'mcp/server.mjs', RUN_CONFIG);
      const raw = readFileSync(path.join(dir, '.mcp.json'), 'utf8');
      const servers = JSON.parse(raw).mcpServers;
      expect(Object.keys(servers).sort()).toEqual(['delivery-console', 'docs', 'jira']);
      expect(servers.jira).toEqual({
        command: 'npx',
        args: ['-y', 'jira-mcp'],
        env: { JIRA_SITE: 'your-org.atlassian.net', MCP_AUTH_JIRA: '${MCP_AUTH_JIRA}' },
      });
      expect(servers.docs).toEqual({ type: 'http', url: 'https://mcp.example.com/docs' });
      // The reference is the only thing that mentions the secret's name.
      expect(raw).not.toMatch(/Bearer [A-Za-z0-9]/);

      // Skills land where Claude Code looks, with frontmatter.
      const skill = readFileSync(path.join(dir, '.claude', 'skills', 'review-style', 'SKILL.md'), 'utf8');
      expect(skill.startsWith('---\nname: review-style\ndescription: How we review\n---\n')).toBe(true);
      expect(skill).toContain('Be kind.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still writes only the console server when nothing is attached, and nothing without a server path', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-cfg-'));
    const bare = mkdtempSync(path.join(os.tmpdir(), 'harness-cfg-'));
    try {
      getHarness('claude', {}).writeConfig(dir, 'mcp/server.mjs', { model: null, mcpServers: [], skills: [] });
      expect(Object.keys(JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers)).toEqual([
        'delivery-console',
      ]);
      expect(readdirSync(dir)).toEqual(['.mcp.json']);
      getHarness('claude', {}).writeConfig(bare, null, null);
      expect(readdirSync(bare)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('gives Codex its skills through AGENTS.md and no MCP file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-cfg-'));
    try {
      getHarness('codex', {}).writeConfig(dir, 'mcp/server.mjs', RUN_CONFIG);
      expect(readdirSync(dir)).toEqual(['AGENTS.md']);
      const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
      expect(agents.startsWith('# Agent instructions')).toBe(true);
      expect(agents).toContain('## Skill: Review style');
      expect(agents).toContain('Be kind.');
      // Appending keeps what the file already says.
      appendSkillsTo(dir, 'AGENTS.md', RUN_CONFIG);
      expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').startsWith('# Agent instructions')).toBe(true);
      expect(writeClaudeSkills(dir, null)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns the model into each harness’s own switch', () => {
    expect(getHarness('claude', {}).modelArgs('claude-opus-5')).toEqual(['--model', 'claude-opus-5']);
    expect(getHarness('codex', {}).modelArgs('gpt-5.3-codex')).toEqual(['-m', 'gpt-5.3-codex']);
    expect(getHarness('claude', {}).modelArgs(null)).toEqual([]);
    expect(getHarness('generic', GENERIC_ENV).modelArgs('x')).toEqual([]);
    expect(getHarness('omnigent', {}).modelArgs('x')).toEqual([]);
  });

  it('reports servers whose credential the runner cannot supply', () => {
    expect(missingAuthEnv(RUN_CONFIG, {})).toEqual([{ slug: 'jira', authEnv: 'MCP_AUTH_JIRA' }]);
    expect(missingAuthEnv(RUN_CONFIG, { MCP_AUTH_JIRA: 'x' })).toEqual([]);
    expect(missingAuthEnv(null, {})).toEqual([]);
    expect(mcpServersConfig(null, null)).toEqual({ mcpServers: {} });
  });
});
