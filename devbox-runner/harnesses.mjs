// Harness adapters: the only harness-specific parts of a runner. The runner
// core (wait → claim → materialize workdir → heartbeat → RESULT.md → complete)
// is identical for every coding agent; an adapter just says how to launch one,
// how to read its streaming output into the live tool-call feed, and how (if at
// all) to wire the delivery-console MCP server into its working directory.
//
// Select with HARNESS=claude|codex|generic|omnigent (default: claude). Adding a
// new harness is one entry here — nothing in runner.mjs changes.
//
// Adapters come in two modes. `mode` is absent on the originals, which means
// 'process' — the historical shape, and still the only one that spawns anything.
//
// mode: 'process' (default) — the agent is a local child process:
//   name,                              // shown in logs and progress notes
//   bin,                               // executable
//   args,                              // fixed CLI args (prompt handled separately)
//   promptVia,                         // 'stdin' | 'arg' — how the prompt reaches the agent
//   parseLine(line, emit),             // one stdout line → emit.print(text) / emit.tool(name, input)
//   writeConfig(dir, mcpServerPath),   // wire MCP into the workdir (or no-op)
//
// mode: 'service' — the agent is a hosted API the runner bridges to. There is no
// process to spawn, no stdout to parse and no exit code, so the four lifecycle
// steps become explicit calls; runner.mjs drives them from a poll loop and emits
// into the same sink parseLine writes to, so the live tool feed is unchanged:
//   name,
//   submit(task, ctx) → handle,        // task: { pkg, prompt, workdir, git }
//   poll(handle, ctx) → { state, events },   // state: running|succeeded|failed|cancelled
//   fetchResult(handle, ctx) → { summary, prUrl? },  // becomes RESULT.md
//   cancel(handle, ctx),               // best-effort abort (watchdog / lead recall)
//   writeConfig(dir, mcpServerPath),   // usually a no-op — nothing runs locally
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
    // --skip-git-repo-check because the agent's cwd is the task workdir (the
    // repo is cloned one level down in ./repo), which is not itself a repo.
    args: splitArgs(env.CODEX_ARGS ?? 'exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox'),
    promptVia: env.CODEX_PROMPT_VIA ?? 'stdin',
    parseLine(line, emit) {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        emit.print(line); // human-readable line (no --json, or a stray) — show it
        return;
      }
      // Codex emits `{type: item.started|item.completed, item: {...}}` around
      // each action, plus thread/turn lifecycle events. Actions therefore
      // appear TWICE — key off the outer event type so each logs once.
      const etype = evt.type ?? '';
      const item = evt.item ?? evt.msg ?? {};
      const itype = item.type ?? '';

      if (etype === 'thread.started' || etype === 'turn.started') return; // no signal
      if (etype === 'turn.completed') {
        const u = evt.usage ?? {};
        emit.print(`— turn complete (${u.input_tokens ?? 0} in / ${u.output_tokens ?? 0} out tokens)`);
        return;
      }
      if (etype === 'turn.failed' || etype === 'error') {
        emit.print(`— codex error: ${typeof evt.message === 'string' ? evt.message : JSON.stringify(evt)}`);
        return;
      }

      if (itype === 'agent_message' || itype === 'reasoning') {
        if (etype !== 'item.completed') return; // text only arrives complete
        const t = item.text ?? (Array.isArray(item.content) ? item.content.map((c) => c?.text ?? '').join('') : '');
        if (t) emit.print(String(t));
        return;
      }
      if (itype === 'command_execution') {
        // Show the command as it starts; on completion only surface failures.
        if (etype === 'item.started') emit.tool('shell', { command: item.command ?? '' });
        else if (etype === 'item.completed' && item.exit_code) emit.print(`  ! command exited ${item.exit_code}`);
        return;
      }
      if (itype.includes('file') || itype.includes('patch') || itype.includes('edit')) {
        if (etype !== 'item.completed') return;
        const paths = Array.isArray(item.changes) ? item.changes.map((c) => c?.path).filter(Boolean) : [];
        emit.tool('edit', { path: paths.length ? paths.join(', ') : (item.path ?? item.file ?? '') });
        return;
      }
      if (itype === 'mcp_tool_call') {
        if (etype !== 'item.started') return;
        emit.tool(`mcp:${item.server ?? '?'}.${item.tool ?? '?'}`, item.arguments ?? {});
        return;
      }
      emit.print(line); // unknown event type — stay visible rather than silent
    },
    // Codex reads MCP from its global config ($CODEX_HOME/config.toml), not a
    // per-workdir file, so there is nothing to write here. The runner still
    // drives the task lifecycle; wire MCP globally on the box if you want the
    // agent to post its own progress/flags. Otherwise it uses GIT_TOKEN and the
    // HTTP endpoints described in the prompt.
    writeConfig() {},
  };
}

// ---------- Omnigent (hosted service — DAT-221 scaffolding) ----------

/**
 * Omnigent runs tasks in its own sandbox behind an HTTP API, so it is the first
 * `mode: 'service'` adapter: runner.mjs submits, polls, and writes RESULT.md from
 * the fetched result rather than spawning anything.
 *
 * DELIBERATELY NON-FUNCTIONAL. The vendor API was not available when this was
 * designed (DAT-221), so the four calls throw a pointer to the write-up instead
 * of guessing endpoint shapes — a stub that silently no-ops would fail a real
 * ticket in a much more confusing way. Everything that does NOT depend on the
 * vendor (config resolution, state normalization, the runner-side poll loop and
 * the console's harness registry) is real and exercised by
 * tests/harness-abstraction.test.ts.
 *
 * To finish it: fill in submit/poll/fetchResult/cancel and correct the *_PATH
 * defaults. See docs/omnigent-runner-architecture.md §7.1.
 */

const OMNIGENT_DOC = 'docs/omnigent-runner-architecture.md';

/**
 * Vendor status word → the four states runner.mjs understands. Returns null for
 * anything unrecognized, which the poll loop treats as "keep waiting" and logs:
 * guessing 'failed' would bin completed work, and guessing 'succeeded' would
 * deliver an empty ticket. An unknown state that never resolves is caught by the
 * MAX_RUN_MINUTES watchdog, which is the safe direction to be wrong in.
 */
export function normalizeState(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (['running', 'in_progress', 'pending', 'queued', 'started'].includes(s)) return 'running';
  if (['succeeded', 'success', 'completed', 'complete', 'done'].includes(s)) return 'succeeded';
  if (['failed', 'failure', 'error', 'errored', 'timed_out'].includes(s)) return 'failed';
  if (['cancelled', 'canceled', 'aborted', 'stopped'].includes(s)) return 'cancelled';
  return null;
}

function omnigentHarness(env) {
  const base = (env.OMNIGENT_BASE_URL ?? 'https://api.omnigent.ai').replace(/\/+$/, '');
  const notImplemented = (call) => {
    throw new Error(
      `Omnigent adapter is scaffolding only: ${call}() is not implemented — the vendor API is unconfirmed. See ${OMNIGENT_DOC} (§7.1 implementation checklist, §8 open questions).`,
    );
  };
  return {
    name: 'omnigent',
    mode: 'service',
    /**
     * Vendor-specific configuration, all env-driven so confirming the real API is
     * a config change rather than a code change. `apiKey` here is the local
     * emulation fallback ONLY — in the fleet the credential is vended per task by
     * the console (POST /api/agent/work/:id/omnigent-credential), so a long-lived
     * vendor key never lands on a runner box. See the write-up §6.
     */
    config: {
      baseUrl: base,
      apiKey: env.OMNIGENT_API_KEY ?? null,
      project: env.OMNIGENT_PROJECT ?? null,
      submitPath: env.OMNIGENT_SUBMIT_PATH ?? '/v1/runs',
      statusPath: env.OMNIGENT_STATUS_PATH ?? '/v1/runs/{id}',
      resultPath: env.OMNIGENT_RESULT_PATH ?? '/v1/runs/{id}/result',
      cancelPath: env.OMNIGENT_CANCEL_PATH ?? '/v1/runs/{id}/cancel',
      pollMs: Number(env.OMNIGENT_POLL_MS ?? 5000),
    },

    /**
     * task: { pkg, prompt, workdir, git } → an opaque handle carrying whatever
     * poll/fetchResult/cancel need (at minimum the vendor run id, plus the event
     * cursor once we know whether the status endpoint is cursorable).
     *
     * The prompt is passed through VERBATIM: it is rendered server-side and owned
     * by the console repo, and it already carries the branch/PR/RESULT.md contract.
     */
    submit() {
      return notImplemented('submit');
    },

    /** One status check → { state, events } with only events new since the cursor. */
    poll() {
      return notImplemented('poll');
    },

    /** Terminal only → { summary, prUrl? }; the bridge writes summary to RESULT.md. */
    fetchResult() {
      return notImplemented('fetchResult');
    },

    /** Best-effort abort for the watchdog and lead-side cancellation. */
    cancel() {
      return notImplemented('cancel');
    },

    // Nothing executes locally, so there is no workdir to wire MCP into. If
    // Omnigent supports MCP it is registered vendor-side (write-up §8, item 7).
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
    case 'omnigent':
      return omnigentHarness(env);
    case 'claude':
      return claudeHarness(env);
    default:
      throw new Error(`Unknown HARNESS "${name}" (expected claude | codex | generic | omnigent)`);
  }
}
