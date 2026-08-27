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
// mode: 'service' — the agent runs behind an HTTP API the runner bridges to
// (self-hosted or vendor). There is no stdout to parse and no exit code, so the
// four lifecycle steps become explicit calls; runner.mjs drives them from a poll
// loop and emits into the same sink parseLine writes to, so the feed is unchanged:
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
        // Per-turn token usage (DAT-266) — each assistant event carries the
        // API call's usage. emit.usage is optional: older runners without a
        // usage sink keep working untouched.
        const u = evt.message?.usage;
        if (u) {
          emit.usage?.({
            input: Number(u.input_tokens ?? 0),
            output: Number(u.output_tokens ?? 0),
            cacheRead: Number(u.cache_read_input_tokens ?? 0),
            cacheCreate: Number(u.cache_creation_input_tokens ?? 0),
          });
        }
        for (const block of evt.message?.content ?? []) {
          if (block.type === 'text' && block.text) emit.print(block.text);
          else if (block.type === 'tool_use') emit.tool(block.name, block.input);
        }
      } else if (evt.type === 'result') {
        // Authoritative end-of-run totals + cost; final:true lets the sink
        // replace its accumulated per-turn sums (covers dropped batches).
        const u = evt.usage;
        if (u) {
          emit.usage?.({
            input: Number(u.input_tokens ?? 0),
            output: Number(u.output_tokens ?? 0),
            cacheRead: Number(u.cache_read_input_tokens ?? 0),
            cacheCreate: Number(u.cache_creation_input_tokens ?? 0),
            costUsd: typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : undefined,
            final: true,
          });
        }
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
        // Codex reports usage per turn only — no final cumulative event, so
        // the sink's running sum is the total (DAT-266).
        emit.usage?.({
          input: Number(u.input_tokens ?? 0),
          output: Number(u.output_tokens ?? 0),
          cacheRead: Number(u.cached_input_tokens ?? 0),
          cacheCreate: 0,
        });
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

// ---------- Omnigent (self-hosted server — DAT-221 scaffolding) ----------

/**
 * Omnigent (github.com/omnigent-ai/omnigent, Apache-2.0) is an open-source
 * META-HARNESS: it orchestrates Claude Code, Codex, Cursor and friends rather
 * than being a model itself. It is NOT a vendor SaaS — you host the server, and
 * it exposes a REST + SSE API (`/v1/...`, default http://localhost:6767).
 *
 * It is still a `mode: 'service'` adapter, and for a sharper reason than the
 * first design assumed: `omnigent run` exists and takes a prompt, but it is a
 * REPL with no stdout event stream (--log / --debug-events write to files under
 * ~/.omnigent/logs). Everything the console needs from a runner — typed events,
 * a status vocabulary, produced-file retrieval, cancellation, spend caps — lives
 * on the server API. So runner.mjs bridges to it rather than parsing stdout.
 *
 * STILL NON-FUNCTIONAL: the four calls throw a pointer to the write-up rather
 * than shipping untested HTTP against a server nobody has stood up yet — a stub
 * that silently no-ops would fail a real ticket far more confusingly. What
 * changed is that the endpoints and states below are now VERIFIED against the
 * published OpenAPI (3.2.0, "Omnigent Server", 99 operations), so finishing this
 * is implementation, not design.
 *
 * See docs/omnigent-runner-architecture.md §3.1 (call mapping), §7.1 (checklist).
 */

const OMNIGENT_DOC = 'docs/omnigent-runner-architecture.md';

/**
 * Omnigent status word → the four states runner.mjs understands.
 *
 * The session `status` enum is `idle | running | waiting | failed`, and it does
 * NOT map one-to-one:
 *
 *   - `idle` is ambiguous — it means both "not started" and "finished the turn",
 *     so it is NEVER a success signal on its own. It returns null here; success
 *     is resolved from the response lifecycle (`ResponseCompleted`) plus a
 *     retrievable RESULT.md. Treating bare `idle` as done would complete real
 *     tickets as empty successes.
 *   - `waiting` means the agent is blocked asking a human something
 *     (ElicitationRequest). Nobody is there to answer it on an autonomous run,
 *     so it maps to 'running' and the poll loop should raise a flag; the
 *     watchdog ends it. See the write-up §5.2.
 *
 * Response-lifecycle words are accepted too, since that is what actually decides
 * a terminal state. Unknown input returns null, which the poll loop treats as
 * "keep waiting": guessing 'failed' would bin completed work and guessing
 * 'succeeded' would deliver an empty ticket, and MAX_RUN_MINUTES is the backstop.
 */
export function normalizeState(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  // `waiting` is blocked-but-live; the caller flags it rather than ending the run.
  if (['running', 'in_progress', 'pending', 'queued', 'started', 'waiting'].includes(s)) return 'running';
  if (['succeeded', 'success', 'completed', 'complete', 'done', 'response_completed'].includes(s)) return 'succeeded';
  // `incomplete` = stopped early (truncation / limit hit). That is not a delivery.
  if (['failed', 'failure', 'error', 'errored', 'timed_out', 'response_failed', 'incomplete', 'response_incomplete'].includes(s))
    return 'failed';
  if (['cancelled', 'canceled', 'aborted', 'stopped', 'response_cancelled'].includes(s)) return 'cancelled';
  return null;
}

/** True when the session is alive but blocked on human input — flag, don't wait silently. */
export function isBlockedState(raw) {
  return String(raw ?? '').trim().toLowerCase() === 'waiting';
}

function omnigentHarness(env) {
  const base = (env.OMNIGENT_BASE_URL ?? 'http://localhost:6767').replace(/\/+$/, '');
  const notImplemented = (call) => {
    throw new Error(
      `Omnigent adapter is scaffolding only: ${call}() is not implemented — no Omnigent server has been stood up yet. See ${OMNIGENT_DOC} (§3.1 call mapping, §7.1 implementation checklist).`,
    );
  };
  return {
    name: 'omnigent',
    mode: 'service',
    /**
     * All env-driven so pointing at a real server is a config change, not a code
     * change. There is deliberately NO apiKey: Omnigent is self-hosted, so auth
     * is either a server account token (`omnigent login`) or — when the server
     * runs as a Databricks App, the recommended posture — the Databricks identity
     * the runner already holds. The first design's per-task vendor-key vending
     * endpoint solves a problem that does not exist. See the write-up §6.1.
     */
    config: {
      baseUrl: base,
      token: env.OMNIGENT_TOKEN ?? null,
      hostId: env.OMNIGENT_HOST_ID ?? null,
      harness: env.OMNIGENT_HARNESS ?? 'claude-sdk',
      workspace: env.OMNIGENT_WORKSPACE ?? null,
      maxCostUsd: env.OMNIGENT_MAX_COST_USD ? Number(env.OMNIGENT_MAX_COST_USD) : null,
      // Verified paths (OpenAPI 3.2.0, "Omnigent Server").
      sessionsPath: env.OMNIGENT_SESSIONS_PATH ?? '/v1/sessions',
      sessionPath: env.OMNIGENT_SESSION_PATH ?? '/v1/sessions/{id}',
      streamPath: env.OMNIGENT_STREAM_PATH ?? '/v1/sessions/{id}/stream',
      itemsPath: env.OMNIGENT_ITEMS_PATH ?? '/v1/sessions/{id}/items',
      launchRunnerPath: env.OMNIGENT_LAUNCH_PATH ?? '/v1/hosts/{hostId}/runners',
      pollMs: Number(env.OMNIGENT_POLL_MS ?? 15000),
    },

    /**
     * task: { pkg, prompt, workdir, git } → an opaque handle (session id, host id,
     * environment id, stream position).
     *
     * Two calls: POST /v1/sessions uploads an agent bundle whose `prompt` is
     * pkg.prompt VERBATIM (it is rendered server-side, owned by the console repo,
     * and already carries the branch/PR/RESULT.md contract), then
     * POST /v1/hosts/{hostId}/runners launches it with { session_id, workspace,
     * git: { base_branch, branch_name } } — git branching is a native parameter.
     */
    submit() {
      return notImplemented('submit');
    },

    /**
     * GET /v1/sessions/{id} for authoritative status, with events consumed from
     * the SSE stream (GET /v1/sessions/{id}/stream) and replayed from
     * GET /v1/sessions/{id}/items after a dropped connection.
     */
    poll() {
      return notImplemented('poll');
    },

    /**
     * Terminal only → { summary, prUrl? }. RESULT.md is read back out of the
     * session environment over the filesystem API, then written into the runner
     * workdir by the bridge, so the "no RESULT.md means failed" rule still holds.
     */
    fetchResult() {
      return notImplemented('fetchResult');
    },

    /** Best-effort abort (DELETE /v1/sessions/{id}) for the watchdog and lead recall. */
    cancel() {
      return notImplemented('cancel');
    },

    // Nothing executes in the local workdir. Omnigent supports MCP first-class,
    // so the delivery-console server is registered on the session instead:
    // POST /v1/sessions/{id}/agent/mcp-servers (write-up §7.1 step 7).
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
