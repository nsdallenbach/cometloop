#!/usr/bin/env node
// Delivery Console devbox runner: wait → claim → Claude Code → complete.
//
//   node devbox-runner/runner.mjs
//
// Long-polls the console's /api/agent/work/wait endpoint (outbound-only, no
// ingress needed), atomically claims queued work, materializes a working
// directory (work package, context files, repo clone via a vended GitHub App
// credential), hands the server-rendered prompt to `claude -p` (stream-json
// output rendered as a compact live activity feed), heartbeats while it runs,
// and completes with done/failed + the agent's RESULT.md.
//
// Env:
//   APP_URL           console base URL
//   DATABRICKS_HOST   workspace URL (for CLI token minting)
//   DATABRICKS_TOKEN  pre-minted OAuth token (skips the CLI)
//   DATABRICKS_CLI    databricks binary path (default: "databricks")
//   AGENT_NAME        runner name shown in the console (default: devbox-<host>)
//   ENGAGEMENT        only work one engagement's queue (optional)
//   WORK_ROOT         where task workdirs are created (default: ~/agent-work)
//   CLAUDE_BIN        claude binary (default: "claude")
//   CLAUDE_ARGS       extra args, space-separated
//                     (default: "--permission-mode acceptEdits")
//   MCP_SERVER        path to mcp/server.mjs — written into the workdir's
//                     .mcp.json so Claude can post progress/flags (optional)
//   ONCE              "1" = run a single task then exit (local testing)
import { execFileSync, spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

const APP = (process.env.APP_URL ?? 'https://delivery-console-7474645607548631.aws.databricksapps.com').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const AGENT = process.env.AGENT_NAME ?? `devbox-${os.hostname()}`;
const ENGAGEMENT = process.env.ENGAGEMENT ?? null;
const WORK_ROOT = process.env.WORK_ROOT ?? path.join(os.homedir(), 'agent-work');
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const CLAUDE_ARGS = (process.env.CLAUDE_ARGS ?? '--permission-mode acceptEdits').split(' ').filter(Boolean);
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
  const qs = ENGAGEMENT ? `?engagement=${encodeURIComponent(ENGAGEMENT)}` : '';
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
    'Read work-package.json for the ticket, acceptance criteria and lead instructions, and ./context/ for reference files.',
    pkg.repo ? 'The repository is cloned in ./repo.' : 'No repository is connected — deliver analysis or docs as the ticket asks.',
    `Create a branch named ${key}-<short-slug> (the name must contain ${key}), implement, push, open a PR (do not merge).`,
    'If GIT_TOKEN is set, push and open the PR with it; otherwise use local credentials.',
    'Before finishing, write RESULT.md here (not in the repo): 2–4 sentences on what you did plus the PR URL.',
  ].join('\n');
}

/** Short one-line label for a tool_use event: file path, command, or a prefix of the input JSON. */
function toolLabel(input) {
  if (input && typeof input === 'object') {
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.command === 'string') return input.command;
  }
  return JSON.stringify(input ?? {}).slice(0, 60);
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

/** Print one NDJSON line from Claude's stream-json output as a compact live feed. */
function printEvent(line, tools) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    console.log(line); // malformed line — pass through raw
    return;
  }
  if (evt.type === 'assistant') {
    for (const block of evt.message?.content ?? []) {
      if (block.type === 'text' && block.text) console.log(block.text);
      else if (block.type === 'tool_use') {
        console.log(`  > ${block.name} ${toolLabel(block.input)}`);
        tools?.push(block.name, block.input);
      }
    }
  } else if (evt.type === 'result') {
    console.log(JSON.stringify(evt, null, 2)); // final result event in full
  } else if (evt.type !== 'system' && evt.type !== 'user') {
    console.log(line); // unknown event type — pass through raw
  }
}

function runClaude(prompt, cwd, extraEnv, tools) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'stream-json', '--verbose', ...CLAUDE_ARGS], {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) printEvent(l, tools);
    });
    child.stdout.on('end', () => {
      if (buf.trim()) printEvent(buf, tools);
    });
    child.stdin.write(prompt);
    child.stdin.end();
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      log(`claude spawn failed: ${err.message}`);
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

  // Let Claude talk to the console (progress notes, flags) from the workdir.
  if (process.env.MCP_SERVER && existsSync(process.env.MCP_SERVER)) {
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'delivery-console': { command: 'node', args: [path.resolve(process.env.MCP_SERVER)] } } }, null, 2),
    );
  }

  const heartbeat = setInterval(() => {
    call('POST', `/api/agent/work/${id}/heartbeat`, { agent: AGENT }).catch(() => {});
  }, 120_000);

  await call('POST', `/api/agent/work/${id}/progress`, {
    agent: AGENT,
    note: `Claimed on ${os.hostname()}; starting Claude Code run.`,
  }).catch(() => {});

  const prompt = pkg.prompt ?? fallbackPrompt(pkg);
  const tools = new ToolCallStream(id);
  const code = await runClaude(prompt, dir, gitToken ? { GIT_TOKEN: gitToken } : {}, tools);
  await tools.flush(); // drain the tail of the feed before completing
  clearInterval(heartbeat);

  const resultPath = path.join(dir, 'RESULT.md');
  const result = existsSync(resultPath) ? readFileSync(resultPath, 'utf8').trim() : '';
  const prUrl = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(result)?.[0];
  const outcome = code === 0 ? 'done' : 'failed';
  const summary =
    result.slice(0, 7900) ||
    (code === 0 ? 'Claude Code run finished (no RESULT.md written).' : `Claude Code exited with code ${code}; see runner logs on ${os.hostname()}.`);

  await call('POST', `/api/agent/work/${id}/complete`, { agent: AGENT, outcome, summary, ...(prUrl ? { url: prUrl } : {}) });
  log(`task ${id} completed ${outcome}`);
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
