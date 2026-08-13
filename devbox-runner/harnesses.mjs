// Harness adapters: the only harness-specific parts of a runner. The runner
// core (wait → claim → materialize workdir → heartbeat → RESULT.md → complete)
// is identical for every coding agent; an adapter just says how to launch one,
// how to read its streaming output into the live tool-call feed, and how (if at
// all) to wire the delivery-console MCP server into its working directory.
//
// Select with HARNESS=claude|codex|generic (default: claude). Adding a new
// harness is one entry here — nothing in runner.mjs changes.
//
// Each adapter is: {
//   name,                              // shown in logs and progress notes
//   bin,                               // executable
//   args,                              // fixed CLI args (prompt handled separately)
//   promptVia,                         // 'stdin' | 'arg' — how the prompt reaches the agent
//   parseLine(line, emit),             // one stdout line → emit.print(text) / emit.tool(name, input)
//   writeConfig(dir, mcpServerPath),   // wire MCP into the workdir (or no-op)
// }
import { writeFileSync } from 'fs';
import path from 'path';

const splitArgs = (s) => (s ?? '').split(' ').filter(Boolean);

/** Short one-line label for a tool call: file path, command, or a JSON prefix. */
export function toolLabel(input) {
  if (input && typeof input === 'object') {
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.command === 'string') return input.command;
    if (typeof input.path === 'string') return input.path;
  }
  return JSON.stringify(input ?? {}).slice(0, 60);
}

// ---------- Claude Code ----------

function claudeHarness(env) {
  return {
    name: 'claude',
    bin: env.CLAUDE_BIN ?? 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose', ...splitArgs(env.CLAUDE_ARGS ?? '--permission-mode acceptEdits')],
    promptVia: 'stdin',
    parseLine(line, emit) {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        emit.print(line); // malformed line — pass through raw
        return;
      }
      if (evt.type === 'assistant') {
        for (const block of evt.message?.content ?? []) {
          if (block.type === 'text' && block.text) emit.print(block.text);
          else if (block.type === 'tool_use') emit.tool(block.name, block.input);
        }
      } else if (evt.type === 'result') {
        emit.print(JSON.stringify(evt, null, 2));
      } else if (evt.type !== 'system' && evt.type !== 'user') {
        emit.print(line);
      }
    },
    writeConfig(dir, mcpServerPath) {
      // Claude Code auto-loads a workdir .mcp.json.
      writeFileSync(
        path.join(dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'delivery-console': { command: 'node', args: [path.resolve(mcpServerPath)] } } }, null, 2),
      );
    },
  };
}

// ---------- OpenAI Codex CLI ----------

function codexHarness(env) {
  // `codex exec` runs non-interactively. --json emits a JSONL event stream we
  // parse best-effort for the live feed; without it we fall back to raw lines.
  // The prompt goes on stdin so large prompts never hit ARG_MAX or shell quoting.
  return {
    name: 'codex',
    bin: env.CODEX_BIN ?? 'codex',
    args: splitArgs(env.CODEX_ARGS ?? 'exec --json --dangerously-bypass-approvals-and-sandbox'),
    promptVia: env.CODEX_PROMPT_VIA ?? 'stdin',
    parseLine(line, emit) {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        emit.print(line); // human-readable line (no --json, or a stray) — show it
        return;
      }
      // Codex JSONL: item.* events carry the agent's actions. Shapes shift
      // between versions, so match loosely and degrade to raw on anything new.
      const item = evt.item ?? evt.msg ?? evt;
      const itype = item.type ?? evt.type ?? '';
      if (itype.includes('command')) emit.tool('shell', { command: item.command ?? item.cmd ?? item.text ?? '' });
      else if (itype.includes('file') || itype.includes('patch') || itype.includes('edit')) emit.tool('edit', { path: item.path ?? item.file ?? '' });
      else if (itype.includes('message') || itype.includes('text') || itype.includes('reasoning')) {
        const t = item.text ?? item.content ?? (Array.isArray(item.content) ? item.content.map((c) => c.text).join('') : '');
        if (t) emit.print(String(t));
      } else emit.print(line);
    },
    // Codex reads MCP from its global config ($CODEX_HOME/config.toml), not a
    // per-workdir file, so there is nothing to write here. The runner still
    // drives the task lifecycle; wire MCP globally on the box if you want the
    // agent to post its own progress/flags. Otherwise it uses GIT_TOKEN and the
    // HTTP endpoints described in the prompt.
    writeConfig() {},
  };
}

// ---------- Generic (any prompt-taking CLI coding agent) ----------

function genericHarness(env) {
  if (!env.AGENT_BIN) throw new Error('HARNESS=generic requires AGENT_BIN (the coding-agent executable)');
  return {
    name: env.AGENT_LABEL ?? 'agent',
    bin: env.AGENT_BIN,
    args: splitArgs(env.AGENT_ARGS),
    promptVia: env.AGENT_PROMPT_VIA ?? 'stdin',
    parseLine(line, emit) {
      emit.print(line); // no structured stream — the raw output is the live log
    },
    writeConfig() {},
  };
}

export function getHarness(name, env = process.env) {
  switch ((name ?? 'claude').toLowerCase()) {
    case 'codex':
      return codexHarness(env);
    case 'generic':
      return genericHarness(env);
    case 'claude':
      return claudeHarness(env);
    default:
      throw new Error(`Unknown HARNESS "${name}" (expected claude | codex | generic)`);
  }
}
