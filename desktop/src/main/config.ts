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
      claude: z
        .object({ instances: z.number().int().min(0).max(4).default(1), autoStart: z.boolean().default(true) })
        .default({ instances: 1, autoStart: true }),
      codex: z
        .object({ instances: z.number().int().min(0).max(4).default(0), autoStart: z.boolean().default(false) })
        .default({ instances: 0, autoStart: false }),
    })
    .default({
      claude: { instances: 1, autoStart: true },
      codex: { instances: 0, autoStart: false },
    }),
});

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
  if (process.env.DATABRICKS_HOST) envValues.databricksHost = process.env.DATABRICKS_HOST;
  if (process.env.DATABRICKS_PROFILE) envValues.databricksProfile = process.env.DATABRICKS_PROFILE;
  if (process.env.DATABRICKS_CLI) envValues.databricksCli = process.env.DATABRICKS_CLI;
  if (process.env.AGENT_NAME) envValues.agentName = process.env.AGENT_NAME;
  if (process.env.HARNESS) envValues.harness = process.env.HARNESS;
  if (process.env.WORK_ROOT) envValues.workRoot = process.env.WORK_ROOT;
  if (process.env.MAX_RUN_MINUTES) envValues.maxRunMinutes = Number(process.env.MAX_RUN_MINUTES);
  if (process.env.MCP_SERVER) envValues.mcpServer = process.env.MCP_SERVER;
  if (process.env.DEPLOY_COMMAND) envValues.deployCommand = process.env.DEPLOY_COMMAND;

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
