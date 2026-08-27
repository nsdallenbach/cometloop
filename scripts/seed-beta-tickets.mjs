#!/usr/bin/env node
// Seed the beta test board (DAT-253): 6–8 small, safe sample tickets the
// beta testers run through the desktop client's embedded runner. Every
// ticket is docs/README-grade — no schema, no CI, no server code — so a
// runaway agent run can't damage anything. All are tagged `beta-sample`
// (board filter + cleanup handle); docs-only ones also carry `no-deploy`
// so the Done gate doesn't demand a deploy. One ticket (the CONTRIBUTING
// one) deliberately omits `no-deploy` so its merge queues in the Deploys
// tab for scenario 8 (observe-only).
//
//   node scripts/seed-beta-tickets.mjs
//
// Idempotent: a sample whose title already exists on the board is skipped,
// so re-running after a partial failure only fills the gaps.
//
// Env (same conventions as scripts/coordination-roundtrip.mjs):
//   APP_URL           console base URL
//   DATABRICKS_HOST   workspace URL (for CLI token minting)
//   DATABRICKS_TOKEN  pre-minted OAuth token (skips the CLI)
//   DATABRICKS_CLI    databricks binary path (default: "databricks")
//   ENGAGEMENT_ID     target engagement (default: "execution-console")
import { execFileSync } from 'child_process';

const APP = (process.env.APP_URL ?? 'https://delivery-console-7474645607548631.aws.databricksapps.com').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const ENGAGEMENT = process.env.ENGAGEMENT_ID ?? 'execution-console';

// title, description, agent-hours estimate, extra tags beyond beta-sample.
// humanEstHours follows the DAT-175 4× convention for docs-grade work.
const SAMPLES = [
  {
    title: 'Beta sample: add a table of contents to docs/architecture.md',
    estHours: 1,
    tags: ['no-deploy'],
    description: [
      'Docs-only beta sample (safe for agent runs; no schema or CI changes).',
      '',
      'docs/architecture.md has grown past the point where it can be skimmed. Add a linked table of contents under the title reflecting the existing `##` headings — do not restructure the document itself.',
      '',
      'Acceptance:',
      '- TOC entries link to every `##` section and anchors resolve on GitHub',
      '- No heading text changed',
    ].join('\n'),
  },
  {
    title: 'Beta sample: troubleshooting section for local development in README.md',
    estHours: 1,
    tags: ['no-deploy'],
    description: [
      'Docs-only beta sample (safe for agent runs; no schema or CI changes).',
      '',
      'Add a "Troubleshooting" section to the root README.md covering the three issues new developers actually hit: the dev port already in use, a missing/incomplete .env, and a stale client bundle after a deploy (hard refresh). Keep it to one short subsection each.',
      '',
      'Acceptance:',
      '- Three concrete symptoms, each with its fix',
      '- Existing README structure untouched otherwise',
    ].join('\n'),
  },
  {
    title: 'Beta sample: glossary of console terms in docs/glossary.md',
    estHours: 1,
    tags: ['no-deploy'],
    description: [
      'Docs-only beta sample (safe for agent runs; no schema or CI changes).',
      '',
      'Create docs/glossary.md defining the terms the console uses that new team members ask about: engagement, workstream, roadmap item, pool vs routed task, claim, heartbeat, orphaned run, fleet, deploy gate. One or two sentences each, alphabetical, sourced from existing docs — do not invent behavior.',
      '',
      'Acceptance:',
      '- All listed terms defined and consistent with docs/architecture.md and docs/devbox-integration.md',
      '- Linked from the README docs list',
    ].join('\n'),
  },
  {
    title: 'Beta sample: curl examples for the flag endpoints in docs/devbox-integration.md',
    estHours: 0.5,
    tags: ['no-deploy'],
    description: [
      'Docs-only beta sample (safe for agent runs; no schema or CI changes).',
      '',
      'docs/devbox-integration.md documents POST and DELETE /api/agent/work/:id/flag in the endpoint table but has no worked example, unlike progress/complete. Add a short "Flag" subsection with a curl example for raising and clearing a flag, matching the style of the existing examples.',
      '',
      'Acceptance:',
      '- Both raise and clear shown, consistent with the surrounding curl examples',
    ].join('\n'),
  },
  {
    title: 'Beta sample: CONTRIBUTING.md pointing at the development standards',
    estHours: 1,
    // Deliberately NOT no-deploy: when this PR merges the ticket queues in
    // the desktop Deploys tab — that is the scenario 8 observation target.
    tags: [],
    description: [
      'Docs-only beta sample (safe for agent runs; no schema or CI changes).',
      '',
      'Add a top-level CONTRIBUTING.md that points contributors at docs/development-standards.md as the working agreement, states the one-ticket-one-branch-one-PR rule with the ticket-key naming convention, and lists the pre-push validation commands (typecheck, lint, build).',
      '',
      'Note for testers: this ticket intentionally lacks the no-deploy tag — after its PR merges it should appear in the desktop Deploys queue (scenario 8, observe-only).',
      '',
      'Acceptance:',
      '- Short (under a screen), links resolve, no duplication of the standards content',
    ].join('\n'),
  },
  {
    title: 'Beta sample: FAQ for unsigned-build install warnings in desktop/README.md',
    estHours: 1,
    tags: ['no-deploy'],
    description: [
      'Docs-only beta sample (safe for agent runs; no schema or CI changes).',
      '',
      'Add a short FAQ to desktop/README.md answering the two questions every beta installer asks: why Windows SmartScreen warns on the unsigned installer (and the More info → Run anyway path), and why macOS Gatekeeper blocks the unsigned dmg (right-click → Open, or System Settings → Privacy & Security → Open Anyway). Note that code signing is tracked on DAT-237.',
      '',
      'Acceptance:',
      '- Both OS paths described step by step, consistent with the Releases section',
    ].join('\n'),
  },
  {
    title: 'Beta sample: fix typos and heading hierarchy across docs/*.md',
    estHours: 1,
    tags: ['no-deploy'],
    description: [
      'Docs-only beta sample (safe for agent runs; no schema or CI changes).',
      '',
      'Sweep the markdown files under docs/ for typos, broken relative links, and heading-level skips (e.g. `#` jumping to `###`). Fix mechanically — no rewording of technical content, no file renames.',
      '',
      'Acceptance:',
      '- Only mechanical fixes in the diff; every relative link in docs/ resolves',
    ].join('\n'),
  },
];

function token() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  const out = execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' });
  return JSON.parse(out).access_token;
}

const tok = token();
async function call(method, path, body) {
  const resp = await fetch(`${APP}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : null;
}

console.log(`Seeding ${SAMPLES.length} beta-sample tickets into ${ENGAGEMENT} on ${APP}\n`);

const existing = await call('GET', '/api/tickets');
const have = new Set(
  existing
    .filter((t) => String(t.engagement_id) === ENGAGEMENT)
    .map((t) => String(t.title).trim().toLowerCase()),
);

let created = 0;
for (const s of SAMPLES) {
  if (have.has(s.title.toLowerCase())) {
    console.log(`  = exists, skipped: ${s.title}`);
    continue;
  }
  const row = await call('POST', `/api/engagements/${encodeURIComponent(ENGAGEMENT)}/tickets`, {
    title: s.title,
    description: s.description,
    workstream: 'Beta',
    est: `${s.estHours}h`,
    estHours: s.estHours,
    humanEstHours: Math.round(s.estHours * 4 * 10) / 10,
  });
  // Tags ride a separate PATCH: create doesn't take them, and this also
  // replaces any needs-estimate flag a race might have left behind.
  await call('PATCH', `/api/tickets/${encodeURIComponent(row.key)}`, {
    tags: ['beta-sample', ...s.tags],
  });
  console.log(`  + ${row.key}: ${s.title}`);
  created++;
}

console.log(`\nDone: ${created} created, ${SAMPLES.length - created} already present.`);
