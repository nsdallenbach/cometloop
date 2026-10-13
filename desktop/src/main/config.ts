// Zod-validated app config, lakebase-off-platform pattern: one schema, one
// load path, fails loud. Precedence: env > config.json (userData) > defaults.
// Secrets never live here — DATABRICKS_TOKEN is accepted from env for dev
// hacking only and is never written to disk.
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** Build channel baked in by electron.vite.config.ts (`COMETLOOP_CHANNEL`). */
export const CHANNEL: 'production' | 'staging' = __COMETLOOP_CHANNEL__;

// Baked in at build time (electron.vite.config.ts). A production console
// that is a Databricks App comes with its workspace host and the desktop
// signs in with a workspace OAuth token; otherwise the console signs the
// user in itself (Neon Auth, consoleAuth 'none') and no workspace token is
// involved: see docs/platform-architecture.md section 5.
const PRODUCTION_CONSOLE_URL = __COMETLOOP_PRODUCTION_CONSOLE_URL__;
const STAGING_CONSOLE_URL = __COMETLOOP_STAGING_CONSOLE_URL__;
const DATABRICKS_HOST = __COMETLOOP_DATABRICKS_HOST__;

/**
 * An environment is a console deployment the desktop can sign in to.
 * The first launch asks which one; the choice is persisted as
 * `environment` and applied on every start. Users can add their own to
 * `environments` in config.json (a client's own hosted console, say).
 */
const EnvironmentSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  consoleUrl: z.string().url(),
  /** Workspace that fronts this console; omit to keep the default host. */
  databricksHost: z.string().url().optional(),
  /** See `consoleAuth` below; unset, a localhost URL means 'none'. */
  consoleAuth: z.enum(['databricks', 'none']).optional(),
  /** One line under the name on the picker. */
  note: z.string().max(160).optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const BUILT_IN_ENVIRONMENTS: Environment[] = [
  {
    id: 'production',
    label: 'Production',
    consoleUrl: PRODUCTION_CONSOLE_URL,
    consoleAuth: DATABRICKS_HOST ? 'databricks' : 'none',
    note: 'The live console — real projects, real tickets.',
  },
  {
    id: 'staging',
    label: 'Staging',
    consoleUrl: STAGING_CONSOLE_URL,
    consoleAuth: 'none',
    note: 'The tester environment: its own data, nothing you do here reaches production. Sign in with your Cometloop account.',
  },
  {
    id: 'local',
    label: 'Local',
    consoleUrl: 'http://localhost:8000',
    consoleAuth: 'none',
    note: 'A console dev server running on this machine (npm run dev at the repo root).',
  },
];

const ConfigSchema = z.object({
  /**
   * The environments this build can sign in to and which one is active.
   * `environment: null` → the picker shows on launch. `APP_URL` in the
   * environment (dev runs) bypasses both and pins the console URL directly.
   */
  environments: z.array(EnvironmentSchema).min(1).default(BUILT_IN_ENVIRONMENTS),
  environment: z.string().nullable().default(null),
  consoleUrl: z.string().url().default(PRODUCTION_CONSOLE_URL),
  databricksHost: z.string().url().or(z.literal('')).default(DATABRICKS_HOST),
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
  /**
   * Silent auto-update from GitHub Releases (DAT-237); disable to pin a build.
   * Off by default on the staging channel: the release feed carries
   * production builds, which must never replace a tester's staging install.
   */
  autoUpdate: z.boolean().default(CHANNEL !== 'staging'),
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
  /** `APP_URL` pinned the console for this run: no picker, no environment. */
  envOverride: boolean;
  /** Which build this is — drives the picker's default and the updater. */
  channel: typeof CHANNEL;
};

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function readConfigFile(): Record<string, unknown> {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    // Corrupt config falls back to defaults; the file is rewritten by loadConfig.
    return {};
  }
}

/** The environment a config names, or null when none is chosen / it was removed. */
export function activeEnvironment(cfg: Pick<DesktopConfig, 'environments' | 'environment'>): Environment | null {
  if (!cfg.environment) return null;
  return cfg.environments.find((e) => e.id === cfg.environment) ?? null;
}

export function loadConfig(): DesktopConfig {
  const fileValues = readConfigFile();

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

  // The chosen environment decides where the console is — unless APP_URL
  // pinned it for this run (developing against a local server).
  const envOverride = Boolean(process.env.APP_URL);
  const env = envOverride ? null : activeEnvironment(parsed);
  if (env) {
    parsed.consoleUrl = env.consoleUrl;
    parsed.consoleAuth = env.consoleAuth;
    if (env.databricksHost && !process.env.DATABRICKS_HOST) parsed.databricksHost = env.databricksHost;
  } else if (!envOverride && parsed.environment) {
    // Named an environment that no longer exists in the list: ask again.
    parsed.environment = null;
  }

  // First run (or corrupt file): persist the resolved non-secret config so
  // users have a file to edit.
  const p = configPath();
  if (!existsSync(p)) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(parsed, null, 2));
  }

  return { ...parsed, devToken: process.env.DATABRICKS_TOKEN || undefined, envOverride, channel: CHANNEL };
}

/** Persist the agent-fleet block (the only config the UI edits today). */
export function saveAgentsConfig(cfg: DesktopConfig): void {
  const p = configPath();
  const fileValues = readConfigFile();
  const { devToken: _devToken, envOverride: _envOverride, channel: _channel, ...persistable } = cfg;
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...fileValues, ...persistable }, null, 2));
}

/**
 * Persist the environment choice (null → ask again on next launch). The
 * caller relaunches: the credential manager, console client, agent pool and
 * webview session are all built from the resolved URL at startup.
 */
export function saveEnvironmentChoice(id: string | null): void {
  const p = configPath();
  const fileValues = readConfigFile();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...fileValues, environment: id }, null, 2));
}
