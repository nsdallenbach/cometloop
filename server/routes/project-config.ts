import express from 'express';
import { z } from 'zod';
import { callerOf, type Caller } from './roles';

/**
 * Per-project (engagement) runner configuration: which base image an agent
 * runner boots for this project's tickets, and which libraries are installed
 * before the coding agent starts work. Lives behind the workspace Config tab
 * alongside the git repository connection.
 *
 * Two rules shape this module:
 *
 * 1. **The image list is an allowlist, not free text.** A runner pulls what it
 *    is told to pull, so an arbitrary registry reference typed into the console
 *    would be an arbitrary code execution path. `RUNNER_BASE_IMAGES` below is
 *    the single source of truth — add an image here (and build it) rather than
 *    letting projects name their own.
 * 2. **Validation happens on save, never at runner start.** Every library entry
 *    is parsed and checked here, so a typo surfaces inline under the field that
 *    caused it instead of failing a claimed ticket twenty minutes later on a
 *    devbox nobody is watching. `resolveRunnerConfig` then hands the runner
 *    ready-made argv arrays — the runner never builds a shell string.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const PROJECT_CONFIG_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.project_runner_configs (
    engagement_id TEXT PRIMARY KEY REFERENCES app.engagements(id) ON DELETE CASCADE,
    base_image TEXT NOT NULL DEFAULT 'python-3.12',
    libraries JSONB NOT NULL DEFAULT '[]',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

// ---------- base image allowlist ----------

export type PackageManager = 'pip' | 'npm' | 'apt';

export interface BaseImage {
  /** Stable id persisted against the project; never renamed once shipped. */
  id: string;
  label: string;
  /** What the runner pulls / checks itself against. */
  image: string;
  /** Manager used for library entries that don't name one. */
  defaultManager: PackageManager;
  /** Managers available in the image; entries naming anything else are rejected. */
  managers: PackageManager[];
  description: string;
}

export const RUNNER_BASE_IMAGES: BaseImage[] = [
  {
    id: 'python-3.12',
    label: 'Python 3.12 (default)',
    image: 'ghcr.io/datavail-solutions/runner-base:python-3.12',
    defaultManager: 'pip',
    managers: ['pip', 'npm', 'apt'],
    description: 'Ubuntu 24.04, Python 3.12, Node 22, git and the Databricks CLI. The console default.',
  },
  {
    id: 'python-3.11',
    label: 'Python 3.11',
    image: 'ghcr.io/datavail-solutions/runner-base:python-3.11',
    defaultManager: 'pip',
    managers: ['pip', 'npm', 'apt'],
    description: 'Same toolchain on Python 3.11, for projects pinned below 3.12.',
  },
  {
    id: 'python-3.12-data',
    label: 'Python 3.12 + data stack',
    image: 'ghcr.io/datavail-solutions/runner-base:python-3.12-data',
    defaultManager: 'pip',
    managers: ['pip', 'npm', 'apt'],
    description: 'Python 3.12 with pandas, pyarrow, dbt-core and the Databricks SQL connector preinstalled.',
  },
  {
    id: 'node-22',
    label: 'Node 22',
    image: 'ghcr.io/datavail-solutions/runner-base:node-22',
    defaultManager: 'npm',
    managers: ['npm', 'pip', 'apt'],
    description: 'Ubuntu 24.04 with Node 22 as the primary toolchain, for TypeScript and web delivery work.',
  },
  {
    id: 'ubuntu-24.04',
    label: 'Ubuntu 24.04 (minimal)',
    image: 'ghcr.io/datavail-solutions/runner-base:ubuntu-24.04',
    defaultManager: 'apt',
    managers: ['apt'],
    description: 'Bare Ubuntu with git and build essentials. Bring your own toolchain via apt entries.',
  },
];

export const DEFAULT_BASE_IMAGE = RUNNER_BASE_IMAGES[0].id;

export const findBaseImage = (id: string): BaseImage | undefined => RUNNER_BASE_IMAGES.find((i) => i.id === id);

// ---------- library entries ----------

/**
 * A library entry is `[<manager>:]<package>[<version spec>]` — package-manager
 * agnostic on the surface, resolved to a concrete manager on save. Bare entries
 * take the base image's default manager, so a Python project just types
 * `pandas==2.2.*` and a Node project just types `typescript@5`.
 */
export interface LibraryEntry {
  manager: PackageManager;
  /** Package name without the version spec — used for duplicate detection. */
  name: string;
  /** Exactly what gets passed to the installer, e.g. `pandas==2.2.1`. */
  spec: string;
}

const MANAGERS: PackageManager[] = ['pip', 'npm', 'apt'];
const isManager = (v: string): v is PackageManager => (MANAGERS as string[]).includes(v);

export const MAX_LIBRARIES = 40;
const MAX_ENTRY_CHARS = 200;

/**
 * Characters that may appear in a library entry at all. Deliberately a
 * whitelist: these strings end up as argv entries on a runner, and while argv
 * is not a shell, an entry containing a space, `;`, `$` or a backtick is either
 * a typo or an attempt at something — neither belongs in a package list.
 */
const SAFE_CHARS = /^[A-Za-z0-9@._+~^*<>=![\],:/-]+$/;

// pip: PEP 508-ish — name, optional extras, optional single version constraint.
const PIP_ENTRY = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[A-Za-z0-9,._-]+\])?((?:==|>=|<=|~=|!=|<|>)[A-Za-z0-9][A-Za-z0-9.*+!-]*)?$/;
// npm: optional @scope/, lowercase name, optional @version range.
const NPM_ENTRY = /^(@[a-z0-9~][a-z0-9._~-]*\/)?([a-z0-9~][a-z0-9._~-]*)(@[A-Za-z0-9^~.*<>=-]+)?$/;
// apt: Debian package name, optional =version pin.
const APT_ENTRY = /^([a-z0-9][a-z0-9+.-]+)(=[A-Za-z0-9.:+~-]+)?$/;

/** Normalized key for duplicate detection (pip treats `-`, `_` and `.` alike). */
const dupeKey = (e: LibraryEntry): string =>
  `${e.manager}:${e.manager === 'pip' ? e.name.toLowerCase().replace(/[._-]+/g, '-') : e.name.toLowerCase()}`;

export interface ConfigIssue {
  field: 'baseImage' | 'libraries';
  /** Index into the submitted library list, so the UI can mark the row. */
  index?: number;
  value?: string;
  message: string;
}

export interface RunnerConfig {
  baseImage: string;
  libraries: LibraryEntry[];
}

export type ValidationResult = { ok: true; config: RunnerConfig } | { ok: false; issues: ConfigIssue[] };

/**
 * Parse one raw library entry against the chosen image. Returns the entry or
 * the reason it was rejected — phrased for a person reading it under an input,
 * not for a log file.
 */
function parseLibrary(raw: string, image: BaseImage): { entry: LibraryEntry } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Empty entry' };
  if (trimmed.length > MAX_ENTRY_CHARS) return { error: `Too long — keep entries under ${String(MAX_ENTRY_CHARS)} characters` };
  if (!SAFE_CHARS.test(trimmed)) {
    return { error: 'Only package names and version specs are allowed here — no spaces, shell characters or flags' };
  }
  const colon = trimmed.indexOf(':');
  // `@scope/pkg` has no colon; `pip:pandas` does. A leading `@` never names a manager.
  const prefix = colon > 0 && !trimmed.startsWith('@') ? trimmed.slice(0, colon).toLowerCase() : '';
  const hasPrefix = prefix !== '' && isManager(prefix);
  if (prefix !== '' && !hasPrefix) {
    return { error: `Unknown package manager "${prefix}" — use pip:, npm: or apt:, or drop the prefix` };
  }
  const manager: PackageManager = hasPrefix ? prefix : image.defaultManager;
  const spec = hasPrefix ? trimmed.slice(colon + 1) : trimmed;
  if (!spec) return { error: 'Missing a package name after the manager prefix' };
  if (!image.managers.includes(manager)) {
    return { error: `${image.label} has no ${manager} — available: ${image.managers.join(', ')}` };
  }
  const match = manager === 'pip' ? PIP_ENTRY.exec(spec) : manager === 'npm' ? NPM_ENTRY.exec(spec) : APT_ENTRY.exec(spec);
  if (!match) {
    const hint =
      manager === 'pip'
        ? 'expected something like pandas, pandas==2.2.1 or dbt-core[databricks]>=1.8'
        : manager === 'npm'
          ? 'expected something like typescript, typescript@5.4.5 or @scope/pkg'
          : 'expected something like jq or jq=1.7-1';
    return { error: `Not a valid ${manager} package — ${hint}` };
  }
  const name = manager === 'npm' ? `${match[1] ?? ''}${match[2]}` : match[1];
  return { entry: { manager, name, spec } };
}

/**
 * Validate a submitted config. Every problem is collected — a save with three
 * bad entries reports all three rather than making the user fix them one round
 * trip at a time.
 */
export function validateRunnerConfig(input: { baseImage: string; libraries: string[] }): ValidationResult {
  const issues: ConfigIssue[] = [];
  const image = findBaseImage(input.baseImage.trim());
  if (!image) {
    issues.push({
      field: 'baseImage',
      value: input.baseImage,
      message: input.baseImage.trim()
        ? `"${input.baseImage.trim()}" is not an allowed base image — pick one of: ${RUNNER_BASE_IMAGES.map((i) => i.id).join(', ')}`
        : 'Pick a base image',
    });
  }
  // Blank lines are how a textarea breathes — dropped, never an error.
  const raw = input.libraries.map((l) => l.trim()).filter((l) => l !== '');
  if (raw.length > MAX_LIBRARIES) {
    issues.push({
      field: 'libraries',
      message: `Too many libraries (${String(raw.length)}) — keep the list under ${String(MAX_LIBRARIES)}. Pin the rest in the repo's own manifest.`,
    });
  }
  const libraries: LibraryEntry[] = [];
  if (image) {
    const seen = new Map<string, number>();
    raw.forEach((entry, index) => {
      const parsed = parseLibrary(entry, image);
      if ('error' in parsed) {
        issues.push({ field: 'libraries', index, value: entry, message: parsed.error });
        return;
      }
      const key = dupeKey(parsed.entry);
      const first = seen.get(key);
      if (first !== undefined) {
        issues.push({
          field: 'libraries',
          index,
          value: entry,
          message: `Already listed on line ${String(first + 1)} — remove one of them`,
        });
        return;
      }
      seen.set(key, index);
      libraries.push(parsed.entry);
    });
  }
  if (issues.length > 0 || !image) return { ok: false, issues };
  return { ok: true, config: { baseImage: image.id, libraries } };
}

// ---------- what the runner receives ----------

export interface ResolvedRunnerConfig {
  baseImage: string;
  image: string;
  label: string;
  libraries: LibraryEntry[];
  /**
   * Ready-to-spawn argv arrays, one per package manager in use. argv, not a
   * command line: the runner never interpolates these into a shell.
   */
  installCommands: { manager: PackageManager; argv: string[] }[];
}

const INSTALL_ARGV: Record<PackageManager, string[]> = {
  pip: ['python3', '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check'],
  npm: ['npm', 'install', '--global', '--no-fund', '--no-audit'],
  apt: ['apt-get', 'install', '-y', '--no-install-recommends'],
};

/** Group validated entries into one install command per manager, in a stable order. */
export function resolveRunnerConfig(config: RunnerConfig): ResolvedRunnerConfig {
  const image = findBaseImage(config.baseImage) ?? RUNNER_BASE_IMAGES[0];
  const installCommands = MANAGERS.flatMap((manager) => {
    const specs = config.libraries.filter((l) => l.manager === manager).map((l) => l.spec);
    return specs.length > 0 ? [{ manager, argv: [...INSTALL_ARGV[manager], ...specs] }] : [];
  });
  return { baseImage: image.id, image: image.image, label: image.label, libraries: config.libraries, installCommands };
}

/** Stored libraries, defensively parsed — a hand-edited JSONB column must never crash a claim. */
function readLibraries(raw: unknown): LibraryEntry[] {
  const arr: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(arr)) return [];
  return arr.flatMap((v) => {
    if (!v || typeof v !== 'object') return [];
    const e = v as { manager?: unknown; name?: unknown; spec?: unknown };
    if (typeof e.manager !== 'string' || !isManager(e.manager)) return [];
    if (typeof e.name !== 'string' || typeof e.spec !== 'string') return [];
    return [{ manager: e.manager, name: e.name, spec: e.spec }];
  });
}

/** The project's stored config, falling back to the default image with no libraries. */
export async function loadRunnerConfig(q: Query, engagementId: string): Promise<RunnerConfig> {
  try {
    const row = (await q('SELECT base_image, libraries FROM app.project_runner_configs WHERE engagement_id = $1', [engagementId]))
      .rows[0];
    if (!row) return { baseImage: DEFAULT_BASE_IMAGE, libraries: [] };
    const baseImage = typeof row.base_image === 'string' && findBaseImage(row.base_image) ? row.base_image : DEFAULT_BASE_IMAGE;
    return { baseImage, libraries: readLibraries(row.libraries) };
  } catch (err) {
    // A claim must never fail because the config table is unreadable — the
    // runner falls back to the default environment and says so in its logs.
    console.warn('[project-config] falling back to the default runner config:', (err as Error).message);
    return { baseImage: DEFAULT_BASE_IMAGE, libraries: [] };
  }
}

/** What rides along in the runner's work package. */
export async function runnerConfigForWorkPackage(q: Query, engagementId: string): Promise<ResolvedRunnerConfig> {
  return resolveRunnerConfig(await loadRunnerConfig(q, engagementId));
}

// ---------- routes ----------

const SaveBody = z.object({
  baseImage: z.string().max(80),
  libraries: z.array(z.string().max(500)).max(200),
});

export function setupProjectConfigRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
) {
  const engagementExists = async (id: string): Promise<boolean> =>
    (await q('SELECT 1 FROM app.engagements WHERE id = $1', [id])).rows.length > 0;

  app.get('/api/engagements/:id/runner-config', async (req, res) => {
    try {
      const engagementId = req.params.id;
      if (!(await engagementExists(engagementId))) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const row = (await q('SELECT * FROM app.project_runner_configs WHERE engagement_id = $1', [engagementId])).rows[0];
      const config = await loadRunnerConfig(q, engagementId);
      res.json({
        baseImage: config.baseImage,
        libraries: config.libraries,
        configured: row != null,
        updatedBy: typeof row?.updated_by === 'string' ? row.updated_by : '',
        updatedAt: row?.updated_at instanceof Date ? row.updated_at.toISOString() : null,
        images: RUNNER_BASE_IMAGES,
        maxLibraries: MAX_LIBRARIES,
      });
    } catch (err) {
      console.error('runner config load failed:', err);
      res.status(500).json({ error: 'Failed to load runner configuration' });
    }
  });

  app.put('/api/engagements/:id/runner-config', async (req, res) => {
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A base image and a list of libraries are required' });
      return;
    }
    try {
      const engagementId = req.params.id;
      if (!(await engagementExists(engagementId))) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      if (!(await requireLead(req, res, engagementId))) return;
      const result = validateRunnerConfig(parsed.data);
      if (!result.ok) {
        // 422, not 400: the request was well-formed, its contents weren't. The
        // Config tab renders these against the fields that produced them.
        res.status(422).json({ error: 'Runner configuration is invalid', issues: result.issues });
        return;
      }
      const who = await callerOf(req);
      const saved = await q(
        `INSERT INTO app.project_runner_configs (engagement_id, base_image, libraries, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (tenant_id, engagement_id) DO UPDATE SET base_image = $2, libraries = $3, updated_by = $4, updated_at = NOW()
         RETURNING *`,
        [engagementId, result.config.baseImage, JSON.stringify(result.config.libraries), who.email],
      );
      const image = findBaseImage(result.config.baseImage);
      const count = result.config.libraries.length;
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [
          engagementId,
          `Runner config updated — base image ${image?.label ?? result.config.baseImage}, ${String(count)} preferred librar${count === 1 ? 'y' : 'ies'}. New agent sessions pick it up on their next claim.`,
        ],
      );
      console.log(
        `[project-config] ${engagementId} → ${result.config.baseImage} + ${String(count)} librar${count === 1 ? 'y' : 'ies'} (${who.email})`,
      );
      const row = saved.rows[0];
      res.json({
        baseImage: result.config.baseImage,
        libraries: result.config.libraries,
        configured: true,
        updatedBy: typeof row.updated_by === 'string' ? row.updated_by : who.email,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : null,
        images: RUNNER_BASE_IMAGES,
        maxLibraries: MAX_LIBRARIES,
      });
    } catch (err) {
      console.error('runner config save failed:', err);
      res.status(500).json({ error: 'Failed to save runner configuration' });
    }
  });
}
