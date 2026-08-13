import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { ProjectRunnerConfig, RepoDetail, RunnerConfigIssue } from '../types';
import { mono } from '../util';

/**
 * Project Config tab: everything about how this project's work gets executed,
 * in one place — the git repository connection (moved off the Sources tab,
 * which is now purely file/artifact browsing) and the runner environment
 * (base image + preferred libraries) that agent sessions boot into.
 *
 * Validation is the server's job: bad entries come back as `issues` anchored
 * to a field and, for libraries, a line number, and are rendered under the
 * input that caused them. Nothing invalid can reach a runner, because nothing
 * invalid is ever stored.
 */

const PR_STATE_COLOR: Record<string, string> = { open: 'var(--warn)', merged: 'var(--ok)', closed: 'var(--tx3)' };

function Empty({ label }: { label: string }) {
  return <div style={{ padding: '18px 14px', fontSize: 12, color: 'var(--tx3)', textAlign: 'center' }}>{label}</div>;
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 4,
  background: 'var(--bg2)',
  marginBottom: 14,
  overflow: 'hidden',
};

const cardHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  borderBottom: '1px solid var(--line)',
};

const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  background: 'var(--bg)',
  border: '1px solid var(--line2)',
  borderRadius: 3,
  color: 'var(--tx)',
  padding: '7px 10px',
  fontSize: 12.5,
};

const primaryBtn = (enabled: boolean): React.CSSProperties => ({
  background: 'var(--acc)',
  color: '#fff',
  border: 'none',
  borderRadius: 3,
  padding: '7px 16px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  opacity: enabled ? 1 : 0.45,
});

export function ProjectConfig({
  engId,
  lead,
  toast,
  refreshDetail,
}: {
  engId: string;
  lead: boolean;
  toast: (msg: string) => void;
  refreshDetail: () => void;
}) {
  return (
    <div className="tab-pane" style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
      <RepoCard engId={engId} lead={lead} toast={toast} refreshDetail={refreshDetail} />
      <RunnerConfigCard engId={engId} lead={lead} toast={toast} />
    </div>
  );
}

// ---------- runner environment ----------

/** Libraries are edited as text (one per line) and stored as parsed entries. */
const librariesToText = (libraries: { spec: string; manager: string }[], defaultManager: string): string =>
  libraries.map((l) => (l.manager === defaultManager ? l.spec : `${l.manager}:${l.spec}`)).join('\n');

const textToLibraries = (text: string): string[] => text.split('\n').map((l) => l.trim());

function RunnerConfigCard({ engId, lead, toast }: { engId: string; lead: boolean; toast: (msg: string) => void }) {
  const [cfg, setCfg] = useState<ProjectRunnerConfig | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [baseImage, setBaseImage] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<RunnerConfigIssue[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  /** Adopt a server config as the new baseline for the editor. */
  const adopt = (c: ProjectRunnerConfig) => {
    setCfg(c);
    const image = c.images.find((i) => i.id === c.baseImage);
    setBaseImage(c.baseImage);
    setText(librariesToText(c.libraries, image?.defaultManager ?? 'pip'));
    setLoadState('ready');
  };

  const fetchConfig = () => {
    api
      .runnerConfig(engId)
      .then(adopt)
      .catch(() => setLoadState('error'));
  };

  const load = () => {
    setLoadState('loading');
    fetchConfig();
  };

  // Initial state is already 'loading'; the effect only starts the fetch.
  useEffect(fetchConfig, [engId]);

  const image = cfg?.images.find((i) => i.id === baseImage) ?? null;
  const entries = textToLibraries(text).filter((l) => l !== '');
  const imageIssue = issues.find((i) => i.field === 'baseImage');
  // Issues without an index are about the list as a whole (e.g. too many).
  const listIssue = issues.find((i) => i.field === 'libraries' && i.index === undefined);
  const lineIssues = issues.filter((i) => i.field === 'libraries' && i.index !== undefined);
  const dirty =
    cfg !== null &&
    (baseImage !== cfg.baseImage || text.trim() !== librariesToText(cfg.libraries, image?.defaultManager ?? 'pip').trim());

  const save = () => {
    if (saving || !cfg) return;
    setSaving(true);
    // Clear stale markers first: leaving last save's red lines under a field
    // the user has since fixed is worse than no feedback at all.
    setIssues([]);
    api
      .saveRunnerConfig(engId, baseImage, textToLibraries(text))
      .then((c) => {
        adopt(c);
        setSavedAt(new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }));
        toast('Runner config saved — new agent sessions use it from their next claim');
      })
      .catch((e: Error) => {
        if (e instanceof ApiError && e.issues.length > 0) {
          setIssues(e.issues);
          toast(`Runner config not saved — ${String(e.issues.length)} problem${e.issues.length === 1 ? '' : 's'} to fix`);
          return;
        }
        toast(e.message);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div style={cardStyle}>
      <div style={cardHeadStyle}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>RUNNER ENVIRONMENT</span>
        {cfg && !cfg.configured && (
          <span
            style={{ ...mono(500, 9), border: '1px solid var(--line2)', color: 'var(--tx2)', borderRadius: 2, padding: '1px 6px', letterSpacing: '.06em' }}
          >
            DEFAULTS
          </span>
        )}
        <div style={{ flex: 1 }} />
        {cfg?.updatedAt && (
          <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
            SAVED{' '}
            {new Date(cfg.updatedAt)
              .toLocaleString('en', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
              .toUpperCase()}
            {cfg.updatedBy ? ` · ${cfg.updatedBy}` : ''}
          </span>
        )}
        {savedAt && !dirty && <span style={{ ...mono(400, 10), color: 'var(--ok)' }}>SAVED {savedAt}</span>}
      </div>

      {loadState === 'loading' && <Empty label="Loading runner config…" />}
      {loadState === 'error' && (
        <div style={{ padding: '14px', fontSize: 12, color: 'var(--tx3)', textAlign: 'center' }}>
          Couldn’t load the runner configuration.{' '}
          <button onClick={load} style={{ border: 'none', background: 'none', color: 'var(--acc)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
            Retry
          </button>
        </div>
      )}

      {loadState === 'ready' && cfg && (
        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 12.5, color: 'var(--tx2)', marginBottom: 12, lineHeight: 1.5 }}>
            The environment agent runners boot for this project. A new session applies the base image and installs these libraries before
            the agent starts work — runs already in flight keep the environment they claimed with.
          </div>

          <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>BASE IMAGE</div>
          <select
            value={baseImage}
            onChange={(e) => setBaseImage(e.target.value)}
            disabled={!lead}
            style={{
              ...inputStyle,
              width: '100%',
              maxWidth: 460,
              cursor: lead ? 'pointer' : 'default',
              borderColor: imageIssue ? 'var(--bad)' : 'var(--line2)',
            }}
          >
            {cfg.images.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
          {image && (
            <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 6, lineHeight: 1.5 }}>
              {image.description} <span className="mono">{image.image}</span>
            </div>
          )}
          {imageIssue && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 6 }}>{imageIssue.message}</div>}

          <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', margin: '16px 0 6px' }}>
            PREFERRED LIBRARIES — ONE PER LINE ({entries.length}/{cfg.maxLibraries})
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={!lead}
            spellCheck={false}
            rows={8}
            placeholder={
              image?.defaultManager === 'npm'
                ? 'typescript@5.4.5\n@databricks/appkit\npip:pandas==2.2.1'
                : 'pandas==2.2.1\ndbt-core[databricks]>=1.8\nnpm:typescript'
            }
            style={{
              ...inputStyle,
              ...mono(400, 12),
              width: '100%',
              resize: 'vertical',
              lineHeight: 1.6,
              borderColor: lineIssues.length > 0 || listIssue ? 'var(--bad)' : 'var(--line2)',
            }}
          />
          <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 6, lineHeight: 1.5 }}>
            Installed with {image ? image.defaultManager : 'the image default'} unless the line names a manager —{' '}
            <span className="mono">pip:</span>, <span className="mono">npm:</span> or <span className="mono">apt:</span>
            {image ? ` (this image has ${image.managers.join(', ')})` : ''}. Version specs are honoured verbatim.
          </div>

          {listIssue && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 8 }}>{listIssue.message}</div>}
          {lineIssues.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
              {lineIssues.map((i) => (
                <div key={`${String(i.index)}-${i.value ?? ''}`} style={{ fontSize: 11.5, color: 'var(--bad)' }}>
                  <span style={{ ...mono(500, 10), letterSpacing: '.06em' }}>LINE {String((i.index ?? 0) + 1)}</span>{' '}
                  {i.value && <span className="mono">{i.value}</span>} — {i.message}
                </div>
              ))}
            </div>
          )}

          {lead && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
              <button onClick={save} disabled={!dirty || saving} style={primaryBtn(dirty && !saving)}>
                {saving ? 'Saving…' : 'Save config'}
              </button>
              {dirty && !saving && (
                <button
                  onClick={() => {
                    adopt(cfg);
                    setIssues([]);
                  }}
                  style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '6px 12px', fontSize: 11.5, cursor: 'pointer' }}
                >
                  Discard changes
                </button>
              )}
              {issues.length > 0 && (
                <span style={{ fontSize: 11.5, color: 'var(--bad)' }}>Nothing was saved — fix the entries above and save again.</span>
              )}
            </div>
          )}
          {!lead && (
            <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 12 }}>
              An engagement lead can change the runner environment for this project.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- git repository ----------

/** Git repository connection card — lives on the Config tab (moved off Sources in DAT-216). */
/** Also rendered by the Sources tab’s Git sub-tab (DAT-202). */
export function RepoCard({
  engId,
  lead,
  toast,
  refreshDetail,
}: {
  engId: string;
  lead: boolean;
  toast: (msg: string) => void;
  refreshDetail: () => void;
}) {
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  // GitHub App picker: null = probing, 'off' = app not configured/reachable.
  const [appRepos, setAppRepos] = useState<{ installationId: number; fullName: string }[] | 'off' | null>(null);
  const [appPick, setAppPick] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);

  const fetchRepo = () => {
    api
      .repo(engId)
      .then((r) => {
        setRepo(r);
        setLoadState('ready');
      })
      .catch(() => setLoadState('error'));
  };

  const load = () => {
    setLoadState('loading');
    fetchRepo();
  };

  // Initial state is already 'loading'; the effect only starts the fetch.
  useEffect(fetchRepo, [engId]);

  useEffect(() => {
    if (!lead) return;
    api
      .githubAppStatus()
      .then((s) => (s.configured ? api.githubAppRepos().then((r) => setAppRepos(r.repos)) : setAppRepos('off')))
      .catch(() => setAppRepos('off'));
  }, [lead]);

  const connectViaApp = () => {
    const pick = (Array.isArray(appRepos) ? appRepos : []).find((r) => r.fullName === appPick);
    if (!pick || connecting) return;
    setConnecting(true);
    api
      .connectRepoViaApp(engId, pick.installationId, pick.fullName)
      .then(() => {
        toast('Repository connected via GitHub App — first sync complete');
        setAppPick('');
        load();
        refreshDetail();
      })
      .catch((e: Error) => toast(e.message))
      .finally(() => setConnecting(false));
  };

  const connect = () => {
    if (!url.trim() || !token.trim() || connecting) return;
    setConnecting(true);
    api
      .connectRepo(engId, url.trim(), token.trim())
      .then(() => {
        toast('Repository connected — first sync complete');
        setUrl('');
        setToken('');
        load();
        refreshDetail();
      })
      .catch((e: Error) => toast(e.message))
      .finally(() => setConnecting(false));
  };

  const syncNow = () => {
    if (syncing) return;
    setSyncing(true);
    api
      .syncRepo(engId)
      .then((r) => {
        toast(`Synced — ${r.commits} new commit${r.commits === 1 ? '' : 's'}, ${r.prs} PR update${r.prs === 1 ? '' : 's'}`);
        load();
        refreshDetail();
      })
      .catch((e: Error) => toast(`Sync failed: ${e.message}`))
      .finally(() => setSyncing(false));
  };

  const conn = repo?.connection ?? null;
  const openPrs = (repo?.prs ?? []).filter((p) => p.state === 'open');

  return (
    <div style={cardStyle}>
      <div style={cardHeadStyle}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>REPOSITORY</span>
        {conn && (
          <span style={{ ...mono(500, 9), border: '1px solid var(--line2)', color: 'var(--tx2)', borderRadius: 2, padding: '1px 6px', letterSpacing: '.06em' }}>
            {conn.provider === 'github' ? 'GITHUB' : 'AZURE DEVOPS'}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {conn && (
          <button
            onClick={syncNow}
            disabled={syncing}
            style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: syncing ? 0.5 : 1 }}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        {conn && lead && !disconnectConfirm && (
          <button
            className="hv-bad"
            onClick={() => setDisconnectConfirm(true)}
            style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 10), cursor: 'pointer', letterSpacing: '.06em' }}
          >
            DISCONNECT
          </button>
        )}
        {conn && lead && disconnectConfirm && (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              onClick={() => {
                api
                  .disconnectRepo(engId)
                  .then(() => {
                    toast('Repository disconnected');
                    setDisconnectConfirm(false);
                    load();
                  })
                  .catch(() => toast('Disconnect failed'));
              }}
              style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
            >
              Confirm
            </button>
            <button
              onClick={() => setDisconnectConfirm(false)}
              style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </span>
        )}
      </div>

      {loadState === 'loading' && <Empty label="Loading repository…" />}
      {loadState === 'error' && (
        <div style={{ padding: '14px', fontSize: 12, color: 'var(--tx3)', textAlign: 'center' }}>
          Couldn’t load the repository connection.{' '}
          <button onClick={load} style={{ border: 'none', background: 'none', color: 'var(--acc)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
            Retry
          </button>
        </div>
      )}

      {loadState === 'ready' && !conn && !lead && (
        <Empty label="No repository connected — an engagement lead can connect GitHub or Azure DevOps here." />
      )}

      {loadState === 'ready' && !conn && lead && (
        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 12.5, color: 'var(--tx2)', marginBottom: 10, lineHeight: 1.5 }}>
            Connect the delivery repo to link commits and PRs to tickets by key (e.g. <span className="mono">ABC-104</span> in a branch or PR
            title). Opening a linked PR moves its ticket to Review; merging holds it in Review while the deploy pipeline runs, then Done
            once the pipeline succeeds.
          </div>
          {Array.isArray(appRepos) && appRepos.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ ...mono(500, 9), border: '1px solid var(--line2)', color: 'var(--tx2)', borderRadius: 2, padding: '2px 6px', letterSpacing: '.06em' }}>
                GITHUB APP
              </span>
              <select value={appPick} onChange={(e) => setAppPick(e.target.value)} style={{ ...inputStyle, flex: '1 1 300px', cursor: 'pointer' }}>
                <option value="">Pick an installed repository…</option>
                {appRepos.map((r) => (
                  <option key={r.fullName} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
              <button onClick={connectViaApp} disabled={!appPick || connecting} style={primaryBtn(!!appPick && !connecting)}>
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
              <div style={{ flexBasis: '100%', ...mono(400, 10), color: 'var(--tx3)' }}>
                No stored tokens — the console mints short-lived credentials per sync. Or paste a token below.
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo or https://dev.azure.com/org/project/_git/repo"
              style={{ ...inputStyle, flex: '1 1 340px' }}
            />
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="Access token (read-only scope)"
              autoComplete="off"
              style={{ ...inputStyle, flex: '1 1 180px' }}
            />
            <button onClick={connect} disabled={!url.trim() || !token.trim() || connecting} style={primaryBtn(!!url.trim() && !!token.trim() && !connecting)}>
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      )}

      {loadState === 'ready' && conn && (
        <div style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: repo && (repo.prs.length > 0 || repo.commits.length > 0) ? 12 : 0 }}>
            <a href={conn.repoUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx)', textDecoration: 'none' }}>
              {conn.repoName}
            </a>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{conn.defaultBranch}</span>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
              {openPrs.length} OPEN PR{openPrs.length === 1 ? '' : 'S'}
            </span>
            <span style={{ ...mono(400, 10), color: conn.status === 'error' ? 'var(--bad)' : 'var(--ok)', letterSpacing: '.06em' }}>
              {conn.status === 'error' ? 'SYNC ERROR' : 'CONNECTED'}
            </span>
            {conn.lastSyncAt && (
              <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
                SYNCED{' '}
                {new Date(conn.lastSyncAt).toLocaleString('en', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).toUpperCase()}
              </span>
            )}
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>TOKEN {conn.tokenHint}</span>
          </div>
          {conn.status === 'error' && conn.lastError && (
            <div style={{ fontSize: 12, color: 'var(--bad)', marginBottom: 10 }}>{conn.lastError}</div>
          )}
          {repo && (repo.prs.length > 0 || repo.commits.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>PULL REQUESTS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {repo.prs.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>None synced yet.</span>}
                  {repo.prs.slice(0, 6).map((pr) => (
                    <a
                      key={pr.number}
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--tx2)', textDecoration: 'none', minWidth: 0 }}
                    >
                      <span style={{ ...mono(500, 9), color: PR_STATE_COLOR[pr.state], flex: 'none' }}>{pr.state.toUpperCase()}</span>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        #{pr.number} {pr.title}
                      </span>
                      {pr.ticketKey && <span style={{ ...mono(400, 9), color: 'var(--agent)', flex: 'none' }}>{pr.ticketKey}</span>}
                    </a>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>RECENT COMMITS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {repo.commits.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>None synced yet.</span>}
                  {repo.commits.slice(0, 6).map((c) => (
                    <a
                      key={c.sha}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--tx2)', textDecoration: 'none', minWidth: 0 }}
                    >
                      <span style={{ ...mono(400, 9), color: 'var(--tx3)', flex: 'none' }}>{c.sha.slice(0, 7)}</span>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.message.split('\n')[0]}</span>
                      {c.ticketKey && <span style={{ ...mono(400, 9), color: 'var(--agent)', flex: 'none' }}>{c.ticketKey}</span>}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
