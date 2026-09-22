import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { serviceBrand } from '../../../../shared/design/AgentLogos';

/**
 * Identity page (DAT-235 / DAT-280 look): a card per service, like the Agents
 * page — logo, who you are signed in as, one action. Databricks is the
 * console's identity; GitHub, Azure and Azure DevOps are the developer's own,
 * used for client-owned repos. MCP server keys are cards too, one per
 * server, plus an "Add key" tile. Everything at rest lives in the OS keychain.
 */

const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

const AUTH_TEXT: Record<AuthMode, { text: string; tone: 'ok' | 'warn' | 'muted' }> = {
  oauth: { text: 'Signed in · browser OAuth', tone: 'ok' },
  cli: { text: 'Signed in · Databricks CLI', tone: 'ok' },
  'dev-token': { text: 'Dev token from env', tone: 'warn' },
  'signed-out': { text: 'Not signed in', tone: 'muted' },
};

const PROVIDER_NOTE: Record<IdentityProvider, string> = {
  github: 'client-owned GitHub repos',
  azure: 'Azure tenant sign-in',
  ado: 'client-owned Azure DevOps repos',
};

const toneColor = (tone: 'ok' | 'warn' | 'muted' | 'agent') =>
  tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'agent' ? 'var(--agent)' : 'var(--tx3)';

export function IdentityView() {
  const [cfg, setCfg] = useState<Awaited<ReturnType<DesktopBridge['getConfig']>> | null>(null);
  const [auth, setAuth] = useState<AuthMode>('signed-out');
  const [dbState, setDbState] = useState<'idle' | 'signing-in' | 'testing' | 'ok' | 'error'>('idle');
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [dbError, setDbError] = useState('');
  const [ids, setIds] = useState<IdentityStatusRow[]>([]);
  const [idErr, setIdErr] = useState<Partial<Record<IdentityProvider, string>>>({});

  useEffect(() => {
    void window.desktopBridge.getConfig().then(setCfg);
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
    void window.desktopBridge.identityStatus().then(setIds);
    return window.desktopBridge.onIdentityEvent((row) => {
      setIds((rows) => rows.map((r) => (r.provider === row.provider ? row : r)));
    });
  }, []);

  const test = async () => {
    setDbState('testing');
    setDbError('');
    const res = await window.desktopBridge.listEngagements();
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
    if (res.ok) {
      setEngagements(res.engagements);
      setDbState('ok');
    } else {
      setDbError(res.error);
      setDbState('error');
    }
  };
  const signIn = async () => {
    setDbState('signing-in');
    setDbError('');
    const res = await window.desktopBridge.authLogin();
    if (res.ok) {
      setAuth(res.mode);
      await test();
    } else {
      setDbError(res.error);
      setDbState('error');
    }
  };
  const signOut = async () => {
    const res = await window.desktopBridge.authSignOut();
    setAuth(res.mode);
    setEngagements([]);
    setDbState('idle');
  };
  const providerLogin = async (p: IdentityProvider) => {
    setIdErr((e) => ({ ...e, [p]: undefined }));
    const res = await window.desktopBridge.identityLogin(p);
    if (res.ok) setIds((rows) => rows.map((r) => (r.provider === p ? res.status : r)));
    else {
      setIdErr((e) => ({ ...e, [p]: res.error }));
      void window.desktopBridge.identityStatus().then(setIds);
    }
  };
  const providerSignOut = async (p: IdentityProvider) => setIds(await window.desktopBridge.identitySignOut(p));

  const db = AUTH_TEXT[auth];
  const host = cfg?.databricksHost.replace(/^https?:\/\//, '') ?? '';

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Identity</h2>
        <span style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>who this machine works as — kept in the OS keychain</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {/* Databricks — the console's identity */}
        <ServiceCard
          service="databricks"
          title="Databricks"
          sub={host}
          status={db.text}
          tone={dbState === 'signing-in' || dbState === 'testing' ? 'agent' : db.tone}
          busy={dbState === 'signing-in' || dbState === 'testing'}
          error={dbState === 'error' ? dbError : undefined}
          actions={
            <>
              {auth === 'signed-out' ? (
                <Btn tone="acc" onClick={() => void signIn()} disabled={dbState === 'signing-in'}>
                  {dbState === 'signing-in' ? 'Waiting for browser…' : 'Sign in'}
                </Btn>
              ) : (
                <Btn tone="agent" onClick={() => void test()} disabled={dbState === 'testing'}>
                  {dbState === 'testing' ? 'Connecting…' : dbState === 'ok' ? `✓ ${engagements.length} project${engagements.length === 1 ? '' : 's'}` : 'Test'}
                </Btn>
              )}
              {auth === 'oauth' && (
                <Btn tone="muted" onClick={() => void signOut()}>
                  Sign out
                </Btn>
              )}
            </>
          }
        />

        {ids.map((row) => {
          const tone = row.state === 'signed-in' ? 'ok' : row.state === 'pending' ? 'agent' : 'muted';
          const brand = serviceBrand(row.provider);
          return (
            <ServiceCard
              key={row.provider}
              service={row.provider}
              title={brand?.label ?? row.provider}
              sub={PROVIDER_NOTE[row.provider]}
              status={row.state === 'signed-in' ? (row.account ?? 'Signed in') : row.state === 'pending' ? 'Waiting for browser…' : 'Not signed in'}
              tone={tone}
              busy={row.state === 'pending'}
              error={idErr[row.provider]}
              detail={
                row.state === 'pending' && row.prompt ? (
                  <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
                    Code{' '}
                    <span style={{ ...mono(600, 14), color: 'var(--tx)', letterSpacing: '.14em', userSelect: 'text' }}>{row.prompt.userCode}</span>
                    {' '}at{' '}
                    <a href={row.prompt.verificationUri} target="_blank" rel="noreferrer" style={{ color: 'var(--link, var(--agent))' }}>
                      {row.prompt.verificationUri.replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                ) : undefined
              }
              actions={
                row.state === 'signed-out' ? (
                  <Btn tone="acc" onClick={() => void providerLogin(row.provider)}>
                    Sign in
                  </Btn>
                ) : row.state === 'signed-in' ? (
                  <Btn tone="muted" onClick={() => void providerSignOut(row.provider)}>
                    Sign out
                  </Btn>
                ) : null
              }
            />
          );
        })}
      </div>

      <McpKeys />
    </div>
  );
}

function ServiceCard({
  service,
  title,
  sub,
  status,
  tone,
  busy,
  error,
  detail,
  actions,
}: {
  service: string;
  title: string;
  sub: string;
  status: string;
  tone: 'ok' | 'warn' | 'muted' | 'agent';
  busy?: boolean;
  error?: string;
  detail?: ReactNode;
  actions: ReactNode;
}) {
  const brand = serviceBrand(service);
  return (
    <div
      className="hv-lift"
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '16px 16px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ display: 'inline-flex', width: 46, height: 46, borderRadius: 11, background: 'var(--bg3)', border: '1px solid var(--line2)', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          {brand?.mark(26)}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, ...mono(500, 9.5), letterSpacing: '.06em', color: toneColor(tone) }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: toneColor(tone), animation: busy ? 'eec-pulse 2.4s infinite' : undefined, flex: 'none' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.toUpperCase()}</span>
      </div>
      {detail}
      {error && <div style={{ fontSize: 11.5, color: 'var(--bad)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto' }}>{actions}</div>
    </div>
  );
}

/** Keys for third-party MCP servers, one card each; runs get them as MCP_AUTH_<NAME>. */
function McpKeys() {
  const [rows, setRows] = useState<McpAuthRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');

  useEffect(() => {
    void window.desktopBridge.identityMcpList().then(setRows);
  }, []);

  const add = async () => {
    if (!name.trim() || !secret) return;
    setRows(await window.desktopBridge.identityMcpSet(name.trim(), secret));
    setName('');
    setSecret('');
    setAdding(false);
  };
  const envName = (n: string) => `MCP_AUTH_${n.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ ...mono(600, 10.5), letterSpacing: '.1em' }}>MCP SERVER KEYS</span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>one per registry server that needs auth · the Cometloop server needs none</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {rows.map((r) => (
          <div key={r.name} style={{ background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ display: 'inline-flex', width: 40, height: 40, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--line2)', alignItems: 'center', justifyContent: 'center', color: 'var(--warn)', flex: 'none' }}>
              <KeyRound size={18} strokeWidth={1.75} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
              <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', marginTop: 2 }}>{envName(r.name)}</div>
            </div>
            <Btn tone="muted" onClick={() => void window.desktopBridge.identityMcpClear(r.name).then(setRows)}>
              Remove
            </Btn>
          </div>
        ))}
        {adding ? (
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--agent)', borderRadius: 12, padding: '14px 16px', display: 'grid', gap: 8 }}>
            <input className="no-drag" autoFocus placeholder="server slug (e.g. jira)" value={name} onChange={(e) => setName(e.target.value)} style={field} />
            <input
              className="no-drag"
              type="password"
              placeholder="secret / token"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
                if (e.key === 'Escape') setAdding(false);
              }}
              style={field}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn tone="muted" onClick={() => setAdding(false)}>
                Cancel
              </Btn>
              <Btn tone="acc" onClick={() => void add()} disabled={!name.trim() || !secret}>
                Save
              </Btn>
            </div>
          </div>
        ) : (
          <button
            className="no-drag hv-lift"
            onClick={() => setAdding(true)}
            style={{ minHeight: 70, border: '1px dashed var(--line2)', borderRadius: 12, background: 'transparent', color: 'var(--tx2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'inherit', fontSize: 13, fontWeight: 600 }}
          >
            <Plus size={16} strokeWidth={2} color="var(--agent)" />
            Add key
          </button>
        )}
      </div>
    </div>
  );
}

function Btn({ tone, onClick, disabled, children }: { tone: 'acc' | 'agent' | 'muted'; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  const color = tone === 'acc' ? 'var(--acc)' : tone === 'agent' ? 'var(--agent)' : 'var(--tx3)';
  return (
    <button
      className={disabled ? 'no-drag' : 'no-drag hv-lift'}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: tone === 'acc' ? 'var(--acc)' : 'transparent',
        color: tone === 'acc' ? '#fff' : color,
        border: `1px solid ${color}`,
        borderRadius: 7,
        padding: '6px 12px',
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? 'wait' : 'pointer',
        fontFamily: 'inherit',
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {children}
    </button>
  );
}

const field: CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--line2)',
  borderRadius: 6,
  color: 'var(--tx)',
  padding: '7px 9px',
  fontSize: 12,
  fontFamily: 'inherit',
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
};
