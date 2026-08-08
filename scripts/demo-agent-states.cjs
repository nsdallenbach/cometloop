// Temporary demo driver: cycles a demo ticket through every agent-task state
// on a fixed interval so the Deploy to Agent lane can be validated visually.
// Walks queued -> claimed -> working (two notes) -> done|failed (alternating),
// then resets and repeats until MAX_MINUTES elapses or it is killed.
//
//   node scripts/demo-agent-states.cjs
//
// Env overrides: APP_URL, DATABRICKS_HOST, DATABRICKS_CLI, ENGAGEMENT,
// STEP_MS (default 10000), MAX_MINUTES (default 30).
const { execFileSync } = require('child_process');

const APP = process.env.APP_URL || 'https://delivery-console-7474645607548631.aws.databricksapps.com';
const HOST = process.env.DATABRICKS_HOST || 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI =
  process.env.DATABRICKS_CLI ||
  `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\Databricks.DatabricksCLI_Microsoft.Winget.Source_8wekyb3d8bbwe\\databricks.exe`;
const ENG = process.env.ENGAGEMENT || 'execution-console';
const STEP = Number(process.env.STEP_MS || 10000);
const DEADLINE = Date.now() + Number(process.env.MAX_MINUTES || 30) * 60000;
const AGENT = 'demo-runner';
const TITLE = 'DEMO · Agent state cycle — safe to delete';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mintToken = () => JSON.parse(execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' })).access_token;

async function call(method, path, body, tok) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  let tok = mintToken();
  const detail = await call('GET', `/api/engagements/${ENG}/detail`, null, tok);
  let key = detail.tickets.find((t) => t.title === TITLE)?.key;
  if (!key) {
    key = (await call('POST', `/api/engagements/${ENG}/tickets`, { title: TITLE, workstream: 'Demo' }, tok)).key;
    console.log(`created demo ticket ${key}`);
  }
  console.log(`cycling ${key} in ${ENG} every ${STEP / 1000}s until ${new Date(DEADLINE).toLocaleTimeString()}`);

  let n = 0;
  while (Date.now() < DEADLINE) {
    try {
    n++;
    tok = mintToken();
    // Start each cycle from a clean backlog ticket, whatever the last one left.
    await call('DELETE', `/api/tickets/${key}/queue`, null, tok).catch(() => {});
    await call('PATCH', `/api/tickets/${key}`, { status: 'backlog' }, tok).catch(() => {});

    await call('POST', `/api/tickets/${key}/queue`, { instructions: `Demo cycle #${n} — automated state walk, ${STEP / 1000}s per step.` }, tok);
    console.log(`#${n} queued`);
    await sleep(STEP);

    const pkg = await call('POST', '/api/agent/work/claim', { agent: AGENT, ticket: key }, tok);
    console.log(`#${n} claimed (task ${pkg.task.id})`);
    await sleep(STEP);

    await call('POST', `/api/agent/work/${pkg.task.id}/progress`, { agent: AGENT, note: `Cycle #${n}: cloned the repo, reading context files…` }, tok);
    console.log(`#${n} working — note 1`);
    await sleep(STEP);

    await call('POST', `/api/agent/work/${pkg.task.id}/progress`, { agent: AGENT, note: `Cycle #${n}: implementing — local tests passing.` }, tok);
    console.log(`#${n} working — note 2`);
    await sleep(STEP);

    const done = n % 2 === 1;
    await call(
      'POST',
      `/api/agent/work/${pkg.task.id}/complete`,
      {
        agent: AGENT,
        outcome: done ? 'done' : 'failed',
        summary: done ? `Cycle #${n}: finished — ticket moves to Review.` : `Cycle #${n}: simulated failure — ticket returns to Backlog.`,
      },
      tok,
    );
    console.log(`#${n} completed ${done ? 'done' : 'failed'}`);
    await sleep(STEP);
    } catch (e) {
      // App restarts (deploys) 502 for a minute — ride it out, don't die.
      console.warn(`cycle #${n} hiccup: ${e.message} — retrying in 20s`);
      await sleep(20_000);
    }
  }

  const tok2 = mintToken();
  await call('DELETE', `/api/tickets/${key}/queue`, null, tok2).catch(() => {});
  await call('PATCH', `/api/tickets/${key}`, { status: 'backlog' }, tok2).catch(() => {});
  console.log('demo cycler finished — board left clean');
})().catch((e) => {
  console.error('demo cycler crashed:', e.message);
  process.exit(1);
});
