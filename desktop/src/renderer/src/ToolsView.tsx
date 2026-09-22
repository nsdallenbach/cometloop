import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { KeyRound, Plus, Plug, Sparkles } from 'lucide-react';
import { harnessBrand, serviceBrand } from '../../../../shared/design/AgentLogos';

/**
 * Agent Tools (DAT-280): the registry of what agents can be given — MCP
 * servers and skills — managed from the desktop like everything else about
 * agents. Card grid per shelf, a scope switch (Shared / per project), and a
 * compact editor. Publishing is lead-gated by the console: a non-lead sees
 * the shelves read-only for scopes they do not lead.
 */

const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

const HARNESS_CHOICES = ['claude-code', 'codex', 'gemini', 'copilot', 'cursor'];

type Editing = { kind: 'mcp'; entry: RegistryMcpServerRow | null } | { kind: 'skill'; entry: RegistrySkillRow | null };

export function ToolsView() {
  const [projects, setProjects] = useState<EngagementRow[]>([]);
  const [me, setMe] = useState<{ role: string; leadOf: string[] } | null>(null);
  const [scope, setScope] = useState<string>('shared');
  const [reg, setReg] = useState<RegistryFull | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(() => {
    void window.desktopBridge.listEngagements().then((r) => (r.ok ? setProjects(r.engagements) : setError(r.error)));
    void window.desktopBridge.consoleMe().then((r) => {
      if (r.ok) setMe({ role: r.me.role, leadOf: r.me.leadOf });
    });
  }, []);

  const load = useCallback(() => {
    return window.desktopBridge.registryList(scope === 'shared' ? null : scope).then((r) => {
      if (r.ok) {
        setReg(r.registry);
        setError('');
      } else setError(r.error);
    });
  }, [scope]);
  useEffect(() => {
    void load();
  }, [load]);

  const canPublish = me ? (scope === 'shared' ? me.role === 'admin' : me.role === 'admin' || me.leadOf.includes(scope)) : false;
  const projectName = (id: string | null) => (id ? (projects.find((p) => p.id === id)?.client ?? id) : 'Shared');

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Agent Tools</h2>
        <span style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>the registry your agents draw from — MCP servers and skills</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <ScopeChip active={scope === 'shared'} onClick={() => setScope('shared')}>
          Shared
        </ScopeChip>
        {projects.map((p) => (
          <ScopeChip key={p.id} active={scope === p.id} onClick={() => setScope(p.id)} title={p.name}>
            {p.client}
          </ScopeChip>
        ))}
        {me && !canPublish && (
          <span style={{ ...mono(400, 9.5), color: 'var(--tx3)', marginLeft: 8, letterSpacing: '.04em' }}>
            READ-ONLY · {scope === 'shared' ? 'admins publish shared tools' : 'project leads publish here'}
          </span>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{error}</div>}

      <Shelf title="MCP servers" icon={<Plug size={14} strokeWidth={1.75} />} count={reg?.mcpServers.length ?? 0}>
        <ToolCard locked icon={serviceBrand('databricks')?.mark(24)} title="Cometloop" sub="tickets · progress · flags · git credentials" tags={['always on']} />
        {(reg?.mcpServers ?? []).map((m) => (
          <ToolCard
            key={m.id}
            icon={<Plug size={22} strokeWidth={1.6} />}
            title={m.name}
            sub={m.transport === 'http' ? (m.url ?? '') : [m.command, ...m.args].filter(Boolean).join(' ')}
            tags={[projectName(m.engagementId), m.transport, ...(m.requiresAuth ? ['needs key'] : []), ...(m.status === 'retired' ? ['retired'] : [])]}
            keyed={m.requiresAuth}
            retired={m.status === 'retired'}
            onClick={() => setEditing({ kind: 'mcp', entry: m })}
          />
        ))}
        {canPublish && <AddTile label="Add MCP server" onClick={() => setEditing({ kind: 'mcp', entry: null })} />}
      </Shelf>

      <Shelf title="Skills" icon={<Sparkles size={14} strokeWidth={1.75} />} count={reg?.skills.length ?? 0}>
        {(reg?.skills ?? []).map((k) => (
          <ToolCard
            key={k.id}
            icon={<Sparkles size={22} strokeWidth={1.6} />}
            title={k.name}
            sub={k.description || k.slug}
            tags={[projectName(k.engagementId), ...(k.status === 'retired' ? ['retired'] : [])]}
            marks={k.harnesses}
            retired={k.status === 'retired'}
            onClick={() => setEditing({ kind: 'skill', entry: k })}
          />
        ))}
        {canPublish && <AddTile label="Add skill" onClick={() => setEditing({ kind: 'skill', entry: null })} />}
      </Shelf>

      {editing && (
        <ToolEditor
          editing={editing}
          scope={scope}
          scopeLabel={projectName(scope === 'shared' ? null : scope)}
          canPublish={canPublish}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---------- cards ----------

function Shelf({ title, icon, count, children }: { title: string; icon: ReactNode; count: number; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--agent)', display: 'inline-flex' }}>{icon}</span>
        <span style={{ ...mono(600, 10.5), letterSpacing: '.1em' }}>{title.toUpperCase()}</span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{count}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>{children}</div>
    </div>
  );
}

function ToolCard({
  icon,
  title,
  sub,
  tags,
  marks,
  keyed,
  locked,
  retired,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  tags: string[];
  marks?: string[];
  keyed?: boolean;
  locked?: boolean;
  retired?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={locked ? undefined : 'hv-lift'}
      onClick={onClick}
      style={{
        background: 'var(--bg2)',
        border: `1px ${retired ? 'dashed' : 'solid'} var(--line)`,
        borderRadius: 12,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        cursor: locked ? 'default' : 'pointer',
        opacity: retired ? 0.6 : locked ? 0.85 : 1,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ display: 'inline-flex', width: 42, height: 42, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--line2)', alignItems: 'center', justifyContent: 'center', color: 'var(--agent)', flex: 'none' }}>
          {icon}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
            {keyed && <KeyRound size={12} strokeWidth={1.75} color="var(--warn)" />}
            {marks?.map((h) => {
              const b = harnessBrand(h);
              return b ? (
                <span key={h} title={b.label} style={{ display: 'inline-flex' }}>
                  {b.mark(12)}
                </span>
              ) : null;
            })}
          </div>
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {tags.map((t) => (
          <span key={t} style={{ ...mono(500, 9), letterSpacing: '.05em', color: t === 'Shared' ? 'var(--agent)' : 'var(--tx2)', background: 'var(--bg3)', border: '1px solid var(--line)', borderRadius: 4, padding: '2px 7px' }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function AddTile({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="no-drag hv-lift"
      onClick={onClick}
      style={{ minHeight: 96, border: '1px dashed var(--line2)', borderRadius: 12, background: 'transparent', color: 'var(--tx2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: 'inherit', fontSize: 13, fontWeight: 600 }}
    >
      <Plus size={16} strokeWidth={2} color="var(--agent)" />
      {label}
    </button>
  );
}

function ScopeChip({ active, onClick, title, children }: { active: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      className="no-drag"
      onClick={onClick}
      title={title}
      style={{
        border: `1px solid ${active ? 'var(--agent)' : 'var(--line2)'}`,
        background: active ? 'var(--agentsoft, rgba(122,143,245,.13))' : 'transparent',
        color: active ? 'var(--tx)' : 'var(--tx2)',
        borderRadius: 6,
        padding: '5px 11px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

// ---------- editor ----------

const slugify = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function ToolEditor({
  editing,
  scope,
  scopeLabel,
  canPublish,
  onClose,
  onSaved,
}: {
  editing: Editing;
  scope: string;
  scopeLabel: string;
  canPublish: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const creating = editing.entry === null;
  const mcp = editing.kind === 'mcp' ? editing.entry : null;
  const skill = editing.kind === 'skill' ? editing.entry : null;
  const engagementId = editing.entry ? editing.entry.engagementId : scope === 'shared' ? null : scope;
  const [name, setName] = useState(editing.entry?.name ?? '');
  const [slug, setSlug] = useState(editing.entry?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(editing.entry));
  const [description, setDescription] = useState(editing.entry?.description ?? '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(mcp?.transport ?? 'stdio');
  const [command, setCommand] = useState(mcp ? [mcp.command, ...mcp.args].filter(Boolean).join(' ') : '');
  const [url, setUrl] = useState(mcp?.url ?? '');
  const [requiresAuth, setRequiresAuth] = useState(mcp?.requiresAuth ?? false);
  const [harnesses, setHarnesses] = useState<string[]>(skill?.harnesses ?? ['claude-code']);
  const [content, setContent] = useState(skill?.content ?? '');
  const [retired, setRetired] = useState(editing.entry?.status === 'retired');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rename = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  };
  const authEnv = `MCP_AUTH_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

  const save = async () => {
    setError('');
    if (!name.trim()) return setError('Give it a name.');
    if (!slug) return setError('The slug needs a letter or digit.');
    setBusy(true);
    let res: { ok: true } | { ok: false; error: string };
    if (editing.kind === 'mcp') {
      const [cmd, ...args] = command.trim().split(/\s+/).filter(Boolean);
      if (transport === 'stdio' && !cmd) {
        setBusy(false);
        return setError('A stdio server needs a command.');
      }
      if (transport === 'http' && !url.trim()) {
        setBusy(false);
        return setError('An http server needs a URL.');
      }
      res = await window.desktopBridge.registrySaveMcp(editing.entry?.id ?? null, {
        engagementId,
        slug,
        name: name.trim(),
        description: description.trim(),
        transport,
        command: transport === 'stdio' ? cmd : null,
        args: transport === 'stdio' ? args : [],
        url: transport === 'http' ? url.trim() : null,
        requiresAuth,
        status: retired ? 'retired' : 'published',
      });
    } else {
      res = await window.desktopBridge.registrySaveSkill(editing.entry?.id ?? null, {
        engagementId,
        slug,
        name: name.trim(),
        description: description.trim(),
        content,
        harnesses,
        status: retired ? 'retired' : 'published',
      });
    }
    setBusy(false);
    if (res.ok) onSaved();
    else setError(res.error);
  };

  const remove = async () => {
    if (!editing.entry) return;
    if (!confirm) return setConfirm(true);
    const res = editing.kind === 'mcp' ? await window.desktopBridge.registryDeleteMcp(editing.entry.id) : await window.desktopBridge.registryDeleteSkill(editing.entry.id);
    if (res.ok) onSaved();
    else setError(res.error);
  };

  const ro = !canPublish;
  const isMcp = editing.kind === 'mcp';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 50, display: 'grid', placeItems: 'center' }}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        style={{ width: 620, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 48px)', background: 'var(--bg2)', border: '1px solid var(--line2)', borderRadius: 12, boxShadow: '0 24px 80px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 22px 12px' }}>
          <span style={{ display: 'inline-flex', width: 40, height: 40, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--line2)', alignItems: 'center', justifyContent: 'center', color: 'var(--agent)' }}>
            {isMcp ? <Plug size={20} strokeWidth={1.6} /> : <Sparkles size={20} strokeWidth={1.6} />}
          </span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{creating ? (isMcp ? 'New MCP server' : 'New skill') : editing.entry?.name}</div>
            <div style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{scopeLabel === 'Shared' ? 'Shared — every project' : `${scopeLabel} only`}</div>
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: '4px 22px 12px', display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Name">
              <input className="no-drag" style={field} value={name} readOnly={ro} onChange={(e) => rename(e.target.value)} autoFocus={creating} placeholder={isMcp ? 'Jira Cloud' : 'Review style'} maxLength={80} />
            </Field>
            <Field label="Slug">
              <input
                className="no-drag"
                style={{ ...field, ...mono(400, 12) }}
                value={slug}
                readOnly={ro}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(slugify(e.target.value));
                }}
                maxLength={60}
              />
            </Field>
          </div>
          <Field label="What it gives an agent">
            <input className="no-drag" style={field} value={description} readOnly={ro} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="one line" />
          </Field>

          {isMcp ? (
            <>
              <Field label="Transport">
                <div style={{ display: 'flex', gap: 8 }}>
                  <Seg active={transport === 'stdio'} onClick={() => !ro && setTransport('stdio')}>
                    Command
                  </Seg>
                  <Seg active={transport === 'http'} onClick={() => !ro && setTransport('http')}>
                    HTTP
                  </Seg>
                </div>
              </Field>
              {transport === 'stdio' ? (
                <Field label="Command">
                  <input className="no-drag" style={{ ...field, ...mono(400, 12) }} value={command} readOnly={ro} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-github" />
                </Field>
              ) : (
                <Field label="URL">
                  <input className="no-drag" style={{ ...field, ...mono(400, 12) }} value={url} readOnly={ro} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
                </Field>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: ro ? 'default' : 'pointer' }}>
                <Switch on={requiresAuth} onToggle={() => !ro && setRequiresAuth((v) => !v)} />
                <span style={{ fontSize: 12.5 }}>Needs a key</span>
                {requiresAuth && <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>runners supply {authEnv} from Identity</span>}
              </label>
            </>
          ) : (
            <>
              <Field label="For">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {HARNESS_CHOICES.map((h) => {
                    const b = harnessBrand(h);
                    const on = harnesses.includes(h);
                    return (
                      <Seg key={h} active={on} onClick={() => !ro && setHarnesses((hs) => (on ? hs.filter((x) => x !== h) : [...hs, h]))}>
                        <span style={{ display: 'inline-flex', marginRight: 6 }}>{b?.mark(13)}</span>
                        {b?.label ?? h}
                      </Seg>
                    );
                  })}
                </div>
              </Field>
              <Field label="Skill (markdown)">
                <textarea className="no-drag" style={{ ...field, ...mono(400, 12), minHeight: 200, resize: 'vertical', lineHeight: 1.5 }} value={content} readOnly={ro} onChange={(e) => setContent(e.target.value)} placeholder={'# When to use\n\n# Steps'} maxLength={60000} />
              </Field>
            </>
          )}

          {!creating && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: ro ? 'default' : 'pointer' }}>
              <Switch on={!retired} onToggle={() => !ro && setRetired((v) => !v)} />
              <span style={{ fontSize: 12.5 }}>{retired ? 'Retired — not delivered to runs' : 'Published'}</span>
            </label>
          )}
          {error && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{error}</div>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 22px 16px', borderTop: '1px solid var(--line)' }}>
          {!creating && canPublish && (
            <button className="no-drag" onClick={() => void remove()} style={{ ...ghostBtn, color: confirm ? 'var(--bad)' : 'var(--tx3)', borderColor: confirm ? 'var(--bad)' : 'var(--line2)' }}>
              {confirm ? 'Confirm remove' : 'Remove'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="no-drag" onClick={onClose} style={ghostBtn}>
            {ro ? 'Close' : 'Cancel'}
          </button>
          {canPublish && (
            <button className="no-drag hv-lift" disabled={busy} onClick={() => void save()} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
              {busy ? 'Saving…' : creating ? 'Publish' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.1em', marginBottom: 6 }}>{label.toUpperCase()}</div>
      {children}
    </div>
  );
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className="no-drag"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? 'var(--agent)' : 'var(--line2)'}`,
        background: active ? 'var(--agentsoft, rgba(122,143,245,.13))' : 'var(--bg)',
        color: active ? 'var(--tx)' : 'var(--tx2)',
        borderRadius: 8,
        padding: '7px 12px',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <span className="no-drag" onClick={onToggle} role="switch" aria-checked={on} style={{ width: 34, height: 18, borderRadius: 9, background: on ? 'var(--agent)' : 'var(--line2)', position: 'relative', display: 'inline-block', transition: 'background .15s', flex: 'none' }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
    </span>
  );
}

const field: CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  border: '1px solid var(--line2)',
  borderRadius: 7,
  color: 'var(--tx)',
  fontSize: 12.5,
  padding: '8px 10px',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const ghostBtn: CSSProperties = {
  background: 'transparent',
  color: 'var(--tx2)',
  border: '1px solid var(--line2)',
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const primaryBtn: CSSProperties = {
  background: 'var(--agent)',
  color: '#fff',
  border: '1px solid var(--agent)',
  borderRadius: 8,
  padding: '8px 18px',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
