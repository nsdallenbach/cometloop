// Zod-validated app config, lakebase-off-platform pattern: one schema, one
// load path, fails loud. Precedence: env > config.json (userData) > defaults.
// Secrets never live here — DATABRICKS_TOKEN is accepted from env for dev
// hacking only and is never written to disk.
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  consoleUrl: z
    .string()
    .url()
    .default('https://delivery-console-7474645607548631.aws.databricksapps.com'),
  databricksHost: z.string().url().default('https://dbc-96494b8f-6b86.cloud.databricks.com'),
  /**
   * How the console authenticates the desktop: 'databricks' = workspace OAuth
   * token through the Apps proxy; 'none' = the console handles sign-in itself
   * (local dev, Cometloop Cloud). Unset, a localhost consoleUrl means 'none'.
   */
  consoleAuth: z.enum(['databricks', 'none']).optional(),
  /** Databricks CLI profile for token minting; omit to use the CLI default. */
  databricksProfile: z.string().optional(),
  /** Databricks CLI binary. */
  databricksCli: z.string().default('databricks'),
  /** Runner identity shown on the board. */
  agentName: z.string().default(`desktop-${os.hostname()}`),
  /** Coding agent the embedded runner drives (harness adapter name). */
  harness: z.enum(['claude', 'codex']).default('claude'),
  /** Where task workdirs are materialized. */
  workRoot: z.string().default(path.join(os.homedir(), 'agent-work')),
  /** Watchdog: kill a run after this many minutes (0 disables). */
  maxRunMinutes: z.number().int().min(0).default(180),
  /** Path to the delivery-console MCP server to wire into workdirs (optional). */
  mcpServer: z.string().optional(),
  /** Silent auto-update from GitHub Releases (DAT-237); disable to pin a build. */
  autoUpdate: z.boolean().default(true),
  /**
   * Local deploy command override (DAT-236). Unset, the deploy executor
   * auto-detects: Databricks bundle repos run `databricks bundle deploy` +
   * `databricks bundle run app` (what CI does), else `npm run deploy`.
   */
  deployCommand: z.string().optional(),
  /**
   * Agent fleet (DAT-245): how many concurrent instances of each coding agent
   * this machine runs, and whether they launch with the app. The default —
   * one auto-starting Claude Code instance — keeps the work queue from
   * stalling on a freshly opened app.
   */
  agents: z
    .object({
      claude: agentKindSchema(1, true),
      codex: agentKindSchema(0, false),
    })
    .default({
      claude: agentKindDefaults(1, true),
      codex: agentKindDefaults(0, false),
    }),
});

/**
 * Per-agent-type configuration (DAT-245 + DAT-280). Agents are managed here,
 * on the developer's machine — the console only mirrors what this reports:
 *  - `projects`: engagement ids the instances claim from; empty = any project.
 *  - `model`: the harness's model id (`claude --model …`); null = harness default.
 *  - `mcpServers` / `skills`: registry slugs attached to every run; resolved
 *    against the console's registry at claim time, per project.
 */
function agentKindDefaults(instances: number, autoStart: boolean) {
  return { instances, autoStart, projects: [] as string[], model: null as string | null, mcpServers: [] as string[], skills: [] as string[] };
}

function agentKindSchema(instances: number, autoStart: boolean) {
  return z
    .object({
      instances: z.number().int().min(0).max(4).default(instances),
      autoStart: z.boolean().default(autoStart),
      projects: z.array(z.string().min(1)).max(50).default([]),
      model: z.string().trim().max(80).nullable().default(null),
      mcpServers: z.array(z.string().min(1)).max(40).default([]),
      skills: z.array(z.string().min(1)).max(40).default([]),
    })
    .default(agentKindDefaults(instances, autoStart));
}

export type AgentKindConfig = z.infer<ReturnType<typeof agentKindSchema>>;

export type DesktopConfig = z.infer<typeof ConfigSchema> & {
  /** Dev-mode only, from env — never persisted. */
  devToken?: string;
};

const configPath = () => path.join(app.getPath('userData'), 'config.json');

export function loadConfig(): DesktopConfig {
  let fileValues: Record<string, unknown> = {};
  const p = configPath();
  if (existsSync(p)) {
    try {
      fileValues = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    } catch {
      // Corrupt config falls back to defaults; the file is rewritten below.
    }
  }

  const envValues: Record<string, unknown> = {};
  if (process.env.APP_URL) envValues.consoleUrl = process.env.APP_URL;
  if (process.env.CONSOLE_AUTH === 'none' || process.env.CONSOLE_AUTH === 'databricks') envValues.consoleAuth = process.env.CONSOLE_AUTH;
  if (process.env.DATABRICKS_HOST) envValues.databricksHost = process.env.DATABRICKS_HOST;
  if (process.env.DATABRICKS_PROFILE) envValues.databricksProfile = process.env.DATABRICKS_PROFILE;
  if (process.env.DATABRICKS_CLI) envValues.databricksCli = process.env.DATABRICKS_CLI;
  if (process.env.AGENT_NAME) envValues.agentName = process.env.AGENT_NAME;
  if (process.env.HARNESS) envValues.harness = process.env.HARNESS;
  if (process.env.WORK_ROOT) envValues.workRoot = process.env.WORK_ROOT;
  if (process.env.MAX_RUN_MINUTES) envValues.maxRunMinutes = Number(process.env.MAX_RUN_MINUTES);
  if (process.env.MCP_SERVER) envValues.mcpServer = process.env.MCP_SERVER;
  if (process.env.DEPLOY_COMMAND) envValues.deployCommand = process.env.DEPLOY_COMMAND;
  if (process.env.AUTO_UPDATE) envValues.autoUpdate = process.env.AUTO_UPDATE !== '0';

  const parsed = ConfigSchema.parse({ ...fileValues, ...envValues });

  // First run (or corrupt file): persist the resolved non-secret config so
  // users have a file to edit.
  if (!existsSync(p)) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(parsed, null, 2));
  }

  return { ...parsed, devToken: process.env.DATABRICKS_TOKEN || undefined };
}

/** Persist the agent-fleet block (the only config the UI edits today). */
export function saveAgentsConfig(cfg: DesktopConfig): void {
  const p = configPath();
  let fileValues: Record<string, unknown> = {};
  try {
    fileValues = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    // fresh or corrupt file — rewrite from the live config
  }
  const { devToken: _devToken, ...persistable } = cfg;
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...fileValues, ...persistable }, null, 2));
}
