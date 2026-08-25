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

  const parsed = ConfigSchema.parse({ ...fileValues, ...envValues });

  // First run (or corrupt file): persist the resolved non-secret config so
  // users have a file to edit.
  if (!existsSync(p)) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(parsed, null, 2));
  }

  return { ...parsed, devToken: process.env.DATABRICKS_TOKEN || undefined };
}
