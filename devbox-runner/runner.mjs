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
import { execFileSync, spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { getHarness, toolLabel } from './harnesses.mjs';

const APP = (process.env.APP_URL ?? 'https://delivery-console-7474645607548631.aws.databricksapps.com').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const AGENT = process.env.AGENT_NAME ?? `devbox-${os.hostname()}`;
const ENGAGEMENT = process.env.ENGAGEMENT ?? null;
const WORK_ROOT = process.env.WORK_ROOT ?? path.join(os.homedir(), 'agent-work');
const HARNESS = getHarness(process.env.HARNESS);
const MAX_RUN_MINUTES = Number(process.env.MAX_RUN_MINUTES ?? 180);
const ONCE = process.env.ONCE === '1';

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
 */
function killAgent(run, why) {
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
function runAgent(prompt, cwd, extraEnv, tools, run) {
  return new Promise((resolve) => {
    const viaArg = HARNESS.promptVia === 'arg';
    const args = viaArg ? [...HARNESS.args, prompt] : HARNESS.args;
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

  // Let the agent talk to the console (progress notes, flags) — wiring is
  // harness-specific (Claude: workdir .mcp.json; Codex: global config; …).
  if (process.env.MCP_SERVER && existsSync(process.env.MCP_SERVER)) {
    HARNESS.writeConfig(dir, process.env.MCP_SERVER);
  }

  // Liveness contract: the heartbeat endpoint answers 404 the moment the
  // task leaves claimed/working for this agent (cancelled, recalled, or
  // reassigned), and 409 if another agent somehow owns it. Either means the
  // console no longer wants this run — kill the agent child and abandon,
  // instead of sitting wedged behind a dead run until it exits on its own.
  // Anything else (network blips, 5xx) is transient and never kills a run.
  const run = { child: null, abandoned: null };
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

  await call('POST', `/api/agent/work/${id}/progress`, {
    agent: AGENT,
    note: `Claimed on ${os.hostname()}; starting ${HARNESS.name} run.`,
  }).catch(() => {});

  const prompt = pkg.prompt ?? fallbackPrompt(pkg);
  const tools = new ToolCallStream(id);
  const code = await runAgent(prompt, dir, gitToken ? { GIT_TOKEN: gitToken } : {}, tools, run);
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
