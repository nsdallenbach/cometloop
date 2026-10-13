#!/usr/bin/env node
// Delivery Console devbox runner: wait → claim → coding agent → complete.
//
//   node devbox-runner/runner.mjs
//
// Long-polls the console's /api/agent/work/wait endpoint (outbound-only, no
// ingress needed), atomically claims queued work, materializes a working
// directory (work package, context files, repo clone via a vended GitHub App
// credential), hands the server-rendered prompt to a coding agent (Claude
// Code, Codex, …) selected by HARNESS, streams its output as a compact live
// activity feed, heartbeats while it runs, and completes with done/failed +
// the agent's RESULT.md. The lifecycle is harness-agnostic; per-harness launch,
// output parsing and MCP wiring live in harnesses.mjs.
//
// Env:
//   APP_URL           console base URL
//   DATABRICKS_HOST   workspace URL (for CLI token minting)
//   DATABRICKS_TOKEN  pre-minted OAuth token (skips the CLI)
//   DATABRICKS_CLI    databricks binary path (default: "databricks")
//   AGENT_NAME        runner name shown in the console (default: devbox-<host>)
//   ENGAGEMENT        only work one engagement's queue (optional)
//   WORK_ROOT         where task workdirs are created (default: ~/agent-work)
//   HARNESS           coding agent: claude | codex | generic (default: claude)
//   CLAUDE_BIN / CLAUDE_ARGS      claude harness (see harnesses.mjs)
//   CODEX_BIN / CODEX_ARGS        codex harness
//   AGENT_BIN / AGENT_ARGS / AGENT_LABEL   generic harness
//   MCP_SERVER        path to mcp/server.mjs — wired into the workdir so the
//                     agent can post its own progress/flags (harness-dependent)
//   MAX_RUN_MINUTES   watchdog: kill the agent and fail the task after this
//                     many minutes (default 180; "0" disables)
//   ONCE              "1" = run a single task then exit (local testing)
//   RUNNER_BASE_IMAGE   base image id this runner actually provides (see the
//                       console's Config tab allowlist). Unset = unknown, and
//                       image mismatches are reported but not enforced.
//   RUNNER_IMAGE_STRICT "1" = fail the task when the project asks for a base
//                       image this runner does not provide, instead of running
//                       on the wrong one
//   SKIP_PROVISION      "1" = skip library installs entirely (local dev)
//   PROVISION_MINUTES   per-install-command timeout (default 10)
//   DENIED_COOLDOWN_MS  pause after the console refuses a claim on agent-security
//                     grounds, so a disabled runner idles instead of spinning
//                     (default 120000)
import { execFileSync, spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { getHarness, missingAuthEnv, normalizeState, toolLabel } from './harnesses.mjs';

const APP = (process.env.APP_URL ?? '').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? '';
if (!APP || !HOST) {
  console.error('Set APP_URL (the console, e.g. https://<app>.databricksapps.com) and DATABRICKS_HOST (the workspace, for `databricks auth token`).');
  process.exit(1);
}
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const AGENT = process.env.AGENT_NAME ?? `devbox-${os.hostname()}`;
const ENGAGEMENT = process.env.ENGAGEMENT ?? null;
const WORK_ROOT = process.env.WORK_ROOT ?? path.join(os.homedir(), 'agent-work');
const HARNESS = getHarness(process.env.HARNESS);
const MAX_RUN_MINUTES = Number(process.env.MAX_RUN_MINUTES ?? 180);
const ONCE = process.env.ONCE === '1';
const RUNNER_BASE_IMAGE = process.env.RUNNER_BASE_IMAGE ?? null;
const RUNNER_IMAGE_STRICT = process.env.RUNNER_IMAGE_STRICT === '1';
const SKIP_PROVISION = process.env.SKIP_PROVISION === '1';
const PROVISION_MINUTES = Number(process.env.PROVISION_MINUTES ?? 10);
/** Pause after the console refuses a claim on security grounds (DAT-212). */
const DENIED_COOLDOWN_MS = Number(process.env.DENIED_COOLDOWN_MS ?? 120_000);

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// Short TTL: workspace tokens live ~1h, so a 10-minute cache can never hand
// out a token near death; a 401 busts the cache and retries once regardless.
let cachedTok = null;
function token() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  if (cachedTok && Date.now() < cachedTok.exp) return cachedTok.token;
  const out = execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' });
  cachedTok = { token: JSON.parse(out).access_token, exp: Date.now() + 10 * 60_000 };
  return cachedTok.token;
}

async function call(method, apiPath, body, timeoutMs = 30_000) {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${APP}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 401 && attempt === 0 && !process.env.DATABRICKS_TOKEN) {
      cachedTok = null; // token died mid-flight — mint fresh and retry once
      log('401 from the console — refreshing the Databricks token');
      continue;
    }
    if (resp.status === 204) return null;
    const raw = await resp.text();
    if (!resp.ok) {
      let msg = `${resp.status}`;
      try {
        msg = JSON.parse(raw).error ?? msg;
      } catch {
        /* keep status code */
      }
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return raw ? JSON.parse(raw) : null;
  }
}

async function waitForWork() {
  // The agent id turns this poll into the fleet liveness ping (DAT-224): an
  // idle runner is only distinguishable from an exited one because this
  // request keeps arriving every ~70s. No extra traffic — the console stamps
  // last_polled_at on the long-poll the runner was making anyway.
  const params = new URLSearchParams({ agent: AGENT });
  if (ENGAGEMENT) params.set('engagement', ENGAGEMENT);
  const qs = `?${params.toString()}`;
  for (;;) {
    try {
      const hit = await call('GET', `/api/agent/work/wait${qs}`, undefined, 70_000);
      if (hit?.queued?.length > 0) return;
    } catch (e) {
      log(`wait hiccup: ${e.message} — retrying in 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

/** Fallback prompt for consoles that don't render one server-side yet. */
function fallbackPrompt(pkg) {
  const key = pkg.ticket?.key ?? pkg.task.ticket_key;
  return [
    `You are an autonomous delivery agent working ticket ${key} — "${pkg.ticket?.title ?? ''}".`,
    'Read work-package.json for the ticket, acceptance criteria, lead instructions and ticket comments (comments may contain steering — treat them as instructions), and ./context/ for reference files.',
    pkg.repo ? 'The repository is cloned in ./repo.' : 'No repository is connected — deliver analysis or docs as the ticket asks.',
    `Create a branch named ${key}-<short-slug> (the name must contain ${key}), implement, push, open a PR (do not merge).`,
    'If GIT_TOKEN is set, push and open the PR with it; otherwise use local credentials.',
    'Before finishing, write RESULT.md here (not in the repo): 2–4 sentences on what you did plus the PR URL.',
  ].join('\n');
}

/** A provisioning step failed — the task fails before the agent ever starts. */
class ProvisionError extends Error {}

/**
 * Apply the project's runner config (console Config tab) before the agent
 * starts: check the base image, then install the preferred libraries.
 *
 * The config arrives already validated and resolved — `installCommands` are
 * argv arrays, never shell strings, so nothing a user typed into the console
 * can turn into a command. A bad package name is impossible here: it was
 * rejected on save.
 *
 * Base images are a claim-time concern, not something a running VM can change
 * for itself. So the runner declares what it provides via RUNNER_BASE_IMAGE
 * and only reports a mismatch — unless RUNNER_IMAGE_STRICT is set, in which
 * case a project asking for an image this runner cannot provide fails the task
 * loudly instead of silently delivering work from the wrong environment.
 */
function provision(pkg, dir) {
  const cfg = pkg.runnerConfig ?? null;
  if (!cfg) return { notes: [], env: {} };
  const notes = [];
  const env = { RUNNER_PROJECT_BASE_IMAGE: String(cfg.baseImage ?? ''), RUNNER_PROJECT_IMAGE: String(cfg.image ?? '') };

  if (RUNNER_BASE_IMAGE && cfg.baseImage && RUNNER_BASE_IMAGE !== cfg.baseImage) {
    const msg = `project asks for base image "${cfg.baseImage}" but this runner provides "${RUNNER_BASE_IMAGE}"`;
    if (RUNNER_IMAGE_STRICT) throw new ProvisionError(`Base image mismatch — ${msg}.`);
    log(`provisioning: ${msg} — continuing (set RUNNER_IMAGE_STRICT=1 to fail instead)`);
    notes.push(`⚠ ${msg} — the run continued on the runner's image.`);
  } else if (cfg.baseImage) {
    log(`provisioning: base image ${cfg.baseImage} (${cfg.image})`);
  }

  const commands = Array.isArray(cfg.installCommands) ? cfg.installCommands : [];
  if (commands.length === 0) return { notes, env };
  if (SKIP_PROVISION) {
    log(`provisioning: SKIP_PROVISION=1 — skipping ${commands.length} install command(s)`);
    notes.push(`⚠ Library installs skipped (SKIP_PROVISION=1 on ${os.hostname()}).`);
    return { notes, env };
  }

  for (const cmd of commands) {
    const [bin, ...args] = cmd.argv ?? [];
    if (!bin) continue;
    log(`provisioning: ${cmd.manager} install — ${args.slice(-8).join(' ')}`);
    try {
      execFileSync(bin, args, { cwd: dir, stdio: 'pipe', timeout: Math.max(1, PROVISION_MINUTES) * 60_000 });
    } catch (e) {
      // stderr carries the real reason (missing wheel, 404, no network); the
      // tail of it is what a human needs on the ticket, not the exit code.
      const detail = String(e.stderr ?? '')
        .trim()
        .split('\n')
        .slice(-4)
        .join(' ')
        .slice(0, 600);
      throw new ProvisionError(`${cmd.manager} install failed${detail ? `: ${detail}` : ` (${e.message})`}`);
    }
  }
  const count = (cfg.libraries ?? []).length;
  notes.push(`Provisioned ${cfg.baseImage ?? 'the default image'} with ${count} preferred librar${count === 1 ? 'y' : 'ies'}.`);
  return { notes, env };
}

/**
 * Streams tool_use events to the console's ticket preview in small batches:
 * flushed every few seconds (or every 25 events) so the drawer feels live
 * without one HTTP round-trip per tool call. Losing a batch only costs
 * telemetry, so failures are logged and dropped — never retried against a
 * console that may be the thing that's down.
 */
class ToolCallStream {
  constructor(taskId) {
    this.taskId = taskId;
    this.pending = [];
    this.timer = null;
    this.inflight = null;
  }

  push(tool, input) {
    this.pending.push({ tool: String(tool).slice(0, 120), detail: toolLabel(input).slice(0, 600), ts: new Date().toISOString() });
    if (this.pending.length >= 25) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 4000);
  }

  /** One drain loop at a time keeps batches arriving in call order. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inflight ??= this.drain().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async drain() {
    while (this.pending.length > 0) {
      const calls = this.pending.splice(0, 200);
      try {
        await call('POST', `/api/agent/work/${this.taskId}/tool-calls`, { agent: AGENT, calls });
      } catch (e) {
        log(`tool-call stream dropped ${calls.length} event(s): ${e.message}`);
      }
    }
  }
}

/** Render one parsed event to the terminal + push tool calls to the live feed. */
function makeEmit(tools) {
  return {
    print: (text) => console.log(text),
    tool: (name, input) => {
      console.log(`  > ${name} ${toolLabel(input)}`);
      tools?.push(name, input);
    },
  };
}

/**
 * Kill the agent child for a run being abandoned (task cancelled/recalled, or
 * watchdog expiry). On Windows the spawn goes through a shell, so the pid is
 * the wrapper's — taskkill /T takes down the whole tree; elsewhere a SIGTERM
 * with a SIGKILL chaser is enough.
 *
 * A service harness has no child: the vendor run is aborted through the adapter
 * and the poll loop exits on run.abandoned, which every caller sets first.
 */
function killAgent(run, why) {
  if (HARNESS.mode === 'service') {
    if (!run.handle) return;
    log(`cancelling ${HARNESS.name} run: ${why}`);
    Promise.resolve()
      .then(() => HARNESS.cancel(run.handle, run.ctx))
      .catch((e) => log(`${HARNESS.name} cancel failed (${e.message}) — the vendor run may still be charging`));
    return;
  }
  const child = run.child;
  if (!child || child.exitCode !== null || child.killed) return;
  log(`terminating ${HARNESS.name} run: ${why}`);
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 10_000).unref();
    }
  } catch (e) {
    log(`kill failed (${e.message}) — waiting for the child to exit on its own`);
  }
}

/**
 * Launch the selected harness on the prompt, streaming its output through the
 * harness's parser. run.child is exposed so the heartbeat/watchdog sidecars can
 * kill the run.
 */
function runAgent(prompt, cwd, extraEnv, tools, run, model = null) {
  return new Promise((resolve) => {
    const viaArg = HARNESS.promptVia === 'arg';
    // The lead's model choice for this agent (DAT-279) rides as the harness's
    // own switch; no model set means the harness default, as before.
    const modelArgs = typeof HARNESS.modelArgs === 'function' ? HARNESS.modelArgs(model) : [];
    const args = viaArg ? [...HARNESS.args, ...modelArgs, prompt] : [...HARNESS.args, ...modelArgs];
    const child = spawn(HARNESS.bin, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: [viaArg ? 'ignore' : 'pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });
    run.child = child;
    const emit = makeEmit(tools);
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) HARNESS.parseLine(l, emit);
    });
    child.stdout.on('end', () => {
      if (buf.trim()) HARNESS.parseLine(buf, emit);
    });
    if (!viaArg) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      log(`${HARNESS.name} spawn failed: ${err.message}`);
      resolve(1);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive a hosted agent (mode: 'service') through submit → poll → result, and
 * return a process-style exit code so the rest of runTask is shared with the
 * process harnesses.
 *
 * Two rules carry most of the weight here:
 *
 * - A failed *poll* is not a failed *run*. Vendor 5xx/429/network blips are
 *   retried with backoff; only a run of consecutive failures gives up, because
 *   binning three hours of finished work over one dropped HTTP call is far worse
 *   than waiting. The MAX_RUN_MINUTES watchdog is the real backstop.
 * - The bridge writes RESULT.md, since a hosted agent cannot reach this workdir.
 *   An empty summary deliberately produces no file, so the existing delivery
 *   contract in runTask ("a clean exit is not done without RESULT.md") still
 *   sends an empty run back to the backlog instead of parking it in Review.
 */
async function runService(prompt, cwd, git, tools, run, pkg) {
  const emit = makeEmit(tools);
  const ctx = { agent: AGENT, log, call };
  run.ctx = ctx;
  const pollMs = Math.max(1000, Number(HARNESS.config?.pollMs) || 5000);

  try {
    run.handle = await HARNESS.submit({ pkg, prompt, workdir: cwd, git }, ctx);
  } catch (e) {
    log(`${HARNESS.name} submit failed: ${e.message}`);
    return 1; // nothing started, so nothing is stranded vendor-side
  }

  let misses = 0;
  let state = null;
  for (;;) {
    // Backoff on consecutive poll failures; reset to the base interval on success.
    // Jittered, so a fleet that all hit the same vendor blip doesn't retry in lockstep.
    await sleep(misses ? Math.min(pollMs * 2 ** misses, 60_000) * (0.5 + Math.random()) : pollMs);
    if (run.abandoned) return 1; // cancelled or watchdog — killAgent already aborted the vendor run

    let tick;
    try {
      tick = await HARNESS.poll(run.handle, ctx);
      misses = 0;
    } catch (e) {
      if (++misses >= 5) {
        log(`${HARNESS.name} poll failed ${misses}× — giving up: ${e.message}`);
        return 1;
      }
      log(`${HARNESS.name} poll hiccup (${misses}/5): ${e.message}`);
      continue;
    }

    // Same sink the process harnesses emit into, so the live tool feed, the
    // terminal rendering and the archived telemetry are identical everywhere.
    for (const ev of tick?.events ?? []) {
      if (ev?.kind === 'tool') emit.tool(ev.name ?? 'tool', ev.input ?? {});
      else if (ev?.text) emit.print(String(ev.text));
    }

    state = normalizeState(tick?.state);
    if (state === null) {
      log(`${HARNESS.name} reported an unrecognized state "${tick?.state}" — still waiting`);
      continue;
    }
    if (state !== 'running') break;
  }

  if (state === 'cancelled') {
    run.abandoned ??= 'cancelled';
    return 1;
  }
  if (state === 'failed') {
    log(`${HARNESS.name} run failed vendor-side`);
    return 1;
  }

  try {
    const res = await HARNESS.fetchResult(run.handle, ctx);
    const summary = String(res?.summary ?? '').trim();
    if (!summary) {
      log(`${HARNESS.name} reported success but returned no summary — treating as undelivered`);
      return 1;
    }
    writeFileSync(path.join(cwd, 'RESULT.md'), `${summary}\n`);
    return 0;
  } catch (e) {
    log(`${HARNESS.name} result fetch failed: ${e.message}`);
    return 1;
  }
}

async function runTask(pkg) {
  const id = pkg.task.id;
  const key = String(pkg.task.ticket_key);
  const dir = path.join(WORK_ROOT, `${key}-task${id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'work-package.json'), JSON.stringify(pkg, null, 2));
  log(`claimed task ${id} (${key}) → ${dir}`);

  // Context files land next to the work package.
  for (const f of pkg.contextFiles ?? []) {
    try {
      const resp = await fetch(`${APP}${f.url}`, { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(60_000) });
      if (resp.ok) {
        mkdirSync(path.join(dir, 'context'), { recursive: true });
        writeFileSync(path.join(dir, 'context', f.name), Buffer.from(await resp.arrayBuffer()));
      }
    } catch (e) {
      log(`context download failed for ${f.name}: ${e.message}`);
    }
  }

  // Repo clone: prefer a vended short-lived credential; fall back to local git auth.
  let gitToken = null;
  if (pkg.repo && !existsSync(path.join(dir, 'repo'))) {
    try {
      const cred = await call('POST', `/api/agent/work/${id}/git-credential`, { agent: AGENT });
      gitToken = cred.token;
      execFileSync('git', ['clone', cred.cloneUrl, 'repo'], { cwd: dir, stdio: 'pipe' });
    } catch (e) {
      log(`vended clone unavailable (${e.message}) — trying local git credentials`);
      try {
        execFileSync('git', ['clone', String(pkg.repo.repo_url), 'repo'], { cwd: dir, stdio: 'pipe' });
      } catch (e2) {
        log(`clone failed: ${e2.message} — continuing without repo`);
      }
    }
  }

  // Let the agent talk to the console (progress notes, flags) and give it
  // what the lead attached on the Agents page (DAT-279): registry MCP servers
  // and skills, plus the model. Wiring is harness-specific (Claude: workdir
  // .mcp.json + .claude/skills; Codex: global MCP config, skills in AGENTS.md).
  const mcpServerPath = process.env.MCP_SERVER && existsSync(process.env.MCP_SERVER) ? process.env.MCP_SERVER : null;
  const agentConfig = pkg.agentConfig ?? null;
  HARNESS.writeConfig(dir, mcpServerPath, agentConfig);
  const missingAuth = missingAuthEnv(agentConfig);
  for (const m of missingAuth) {
    log(`MCP server ${m.slug} requires ${m.authEnv}, which is not set on this runner — it will fail to authenticate`);
  }

  // Liveness contract: the heartbeat endpoint answers 404 the moment the
  // task leaves claimed/working for this agent (cancelled, recalled, or
  // reassigned), and 409 if another agent somehow owns it. Either means the
  // console no longer wants this run — kill the agent child and abandon,
  // instead of sitting wedged behind a dead run until it exits on its own.
  // Anything else (network blips, 5xx) is transient and never kills a run.
  const run = { child: null, handle: null, ctx: null, abandoned: null };
  const heartbeat = setInterval(() => {
    call('POST', `/api/agent/work/${id}/heartbeat`, { agent: AGENT }).catch((e) => {
      if (e.status === 404 || e.status === 409) {
        run.abandoned ??= 'cancelled';
        killAgent(run, `console reports task ${id} is no longer ours (${e.status}: ${e.message}) — abandoning the run`);
      }
    });
  }, 120_000);

  // Watchdog: a genuinely hung agent must never wedge the runner forever.
  const watchdog =
    MAX_RUN_MINUTES > 0
      ? setTimeout(
          () => {
            run.abandoned ??= 'watchdog';
            killAgent(run, `run exceeded MAX_RUN_MINUTES=${MAX_RUN_MINUTES} — failing the task`);
          },
          MAX_RUN_MINUTES * 60_000,
        )
      : null;

  // Provision the project's runner environment before the agent starts. A
  // failure here is a delivery failure, not a code failure: the ticket goes
  // back to the backlog flagged, with the reason on the ticket, rather than
  // handing the agent a half-built environment and letting it flail.
  let provisioned;
  try {
    provisioned = provision(pkg, dir);
  } catch (e) {
    if (!(e instanceof ProvisionError)) throw e;
    clearInterval(heartbeat);
    if (watchdog) clearTimeout(watchdog);
    log(`provisioning failed: ${e.message}`);
    await call('POST', `/api/agent/work/${id}/flag`, { agent: AGENT, reason: `Runner provisioning failed — ${e.message}` }).catch(() => {});
    await call('POST', `/api/agent/work/${id}/complete`, {
      agent: AGENT,
      outcome: 'failed',
      summary: [
        `Runner provisioning failed on ${os.hostname()} before the agent started, so no work was attempted.`,
        e.message,
        "Check the project's Config tab — base image and preferred libraries — then re-queue the ticket.",
      ].join('\n\n'),
    }).catch(() => {});
    return;
  }

  const configNote = [
    agentConfig?.model ? `model ${agentConfig.model}` : null,
    agentConfig?.mcpServers?.length ? `${agentConfig.mcpServers.length} MCP server${agentConfig.mcpServers.length === 1 ? '' : 's'}` : null,
    agentConfig?.skills?.length ? `${agentConfig.skills.length} skill${agentConfig.skills.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  await call('POST', `/api/agent/work/${id}/progress`, {
    agent: AGENT,
    note: [
      `Claimed on ${os.hostname()}; starting ${HARNESS.name} run${configNote.length ? ` (${configNote.join(', ')})` : ''}.`,
      ...missingAuth.map((m) => `⚠ ${m.slug} needs ${m.authEnv}, not set on this runner.`),
      ...provisioned.notes,
    ].join(' '),
  }).catch(() => {});

  const prompt = pkg.prompt ?? fallbackPrompt(pkg);
  const tools = new ToolCallStream(id);
  // Process harnesses get the token and the project's provisioned environment
  // in their env; a hosted agent cannot read our environment, so the adapter
  // has to hand the token over in the submission.
  const code =
    HARNESS.mode === 'service'
      ? await runService(prompt, dir, gitToken, tools, run, pkg)
      : await runAgent(prompt, dir, { ...provisioned.env, ...(gitToken ? { GIT_TOKEN: gitToken } : {}) }, tools, run, agentConfig?.model ?? null);
  await tools.flush(); // drain the tail of the feed before completing
  clearInterval(heartbeat);
  if (watchdog) clearTimeout(watchdog);

  // Cancelled server-side: the console already moved on (completing would
  // only 404), so drop the stale workdir and go straight back to waiting.
  if (run.abandoned === 'cancelled') {
    log(`task ${id} was cancelled by the console — returning to wait`);
    return;
  }

  const resultPath = path.join(dir, 'RESULT.md');
  const result = existsSync(resultPath) ? readFileSync(resultPath, 'utf8').trim() : '';
  const prUrl = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(result)?.[0];
  // Delivery contract: a clean exit does NOT count as done unless the agent
  // wrote RESULT.md. A run that worked but never shipped must land back in
  // the backlog as failed, not park an empty "done" in Review.
  const delivered = result.length > 0;
  const outcome = code === 0 && delivered && run.abandoned !== 'watchdog' ? 'done' : 'failed';
  const summary =
    run.abandoned === 'watchdog'
      ? `Killed by the runner watchdog after ${MAX_RUN_MINUTES} minutes — the run was hung or overlong. Partial work may remain in the runner workdir on ${os.hostname()}.`
      : result.slice(0, 7900) ||
        (code === 0
          ? `Run exited cleanly but wrote no RESULT.md — delivery unverified (no PR, no summary). Work may be stranded uncommitted in the runner workdir on ${os.hostname()}.`
          : `${HARNESS.name} exited with code ${code}; see runner logs on ${os.hostname()}.`);

  try {
    await call('POST', `/api/agent/work/${id}/complete`, { agent: AGENT, outcome, summary, ...(prUrl ? { url: prUrl } : {}) });
    log(`task ${id} completed ${outcome}`);
  } catch (e) {
    // The console rejected the completion (task cancelled/reassigned while
    // the agent was finishing) — nothing left to report, just go back to waiting.
    if (e.status === 404 || e.status === 409) {
      log(`task ${id} completion rejected (${e.status}: ${e.message}) — task was cancelled or reassigned; returning to wait`);
      return;
    }
    throw e;
  }
}

log(`runner ${AGENT} → ${APP}${ENGAGEMENT ? ` (engagement ${ENGAGEMENT})` : ''}${ONCE ? ' [single-task mode]' : ''}`);
for (;;) {
  await waitForWork();
  let pkg;
  try {
    pkg = await call('POST', '/api/agent/work/claim', { agent: AGENT, ...(ENGAGEMENT ? { engagement: ENGAGEMENT } : {}) });
  } catch (e) {
    // 403 = this runner's security settings forbid claiming (DAT-212). The
    // work stays queued, so waiting would answer instantly and spin — back off
    // until a lead re-enables the agent.
    if (e.status === 403) {
      log(`claim refused by the console's agent security settings: ${e.message} — pausing ${DENIED_COOLDOWN_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, DENIED_COOLDOWN_MS));
      continue;
    }
    if (e.status !== 404) log(`claim failed: ${e.message}`);
    continue; // another runner got there first — go back to waiting
  }
  try {
    await runTask(pkg);
  } catch (e) {
    log(`task crashed: ${e.message}`);
    await call('POST', `/api/agent/work/${pkg.task.id}/complete`, {
      agent: AGENT,
      outcome: 'failed',
      summary: `Runner error: ${e.message}`,
    }).catch(() => {});
  }
  if (ONCE) break;
}
log('runner exiting');
