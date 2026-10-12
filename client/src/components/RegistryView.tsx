import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, type McpServerPayload, type SkillPayload } from '../api';
import type { AgentsOverviewProject, ProjectAgent, RegistryMcpServer, RegistrySkill } from '../types';
import { mono } from '../util';
import { HARNESS_OPTIONS, harnessBrand } from './AgentLogos';
import { FIELD, LABEL } from '../lib/agents';

/**
 * The MCP / skills registry (DAT-238) — the REGISTRY view of the Agents page.
 * Two shelves, MCP servers and skills, scoped SHARED (every project; admins
 * publish) or to one project (its leads publish). Agents attach entries from
 * the configure drawer; this view is where the entries themselves live.
 *
 * Secrets never enter here: a server that needs a credential is marked
 * "requires auth" and the runner injects `MCP_AUTH_<SLUG>` from its own
 * keychain / environment.
 */

/** 'shared', or an engagement id. */
type Scope = string;

const SCOPE_KEY = 'eec-registry-scope';

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      className="hv-border"
      onClick={onClick}
      title={title}
      style={{
        border: `1px solid ${active ? 'var(--tx3)' : 'var(--line)'}`,
        background: active ? 'var(--bg3)' : 'transparent',
        color: active ? 'var(--tx)' : 'var(--tx2)',
        borderRadius: 3,
        padding: '4px 9px',
        ...mono(500, 9.5),
        letterSpacing: '.06em',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

const ScopeTag = ({ engagementId, projects }: { engagementId: string | null; projects: AgentsOverviewProject[] }) => {
  const p = engagementId ? projects.find((x) => x.id === engagementId) : null;
  return (
    <span
      style={{
        ...mono(500, 8),
        letterSpacing: '.08em',
        color: engagementId ? 'var(--tx2)' : 'var(--agent)',
        border: `1px solid ${engagementId ? 'var(--line2)' : 'var(--agent)'}`,
        borderRadius: 3,
        padding: '1px 5px',
        flex: 'none',
      }}
    >
      {engagementId ? (p?.client.toUpperCase() ?? engagementId.toUpperCase()) : 'SHARED'}
    </span>
  );
};

function McpCard({
  entry,
  projects,
  usedBy,
  canEdit,
  onEdit,
}: {
  entry: RegistryMcpServer;
  projects: AgentsOverviewProject[];
  usedBy: number;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const retired = entry.status === 'retired';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', visualDuration: 0.26, bounce: 0.18 }}
      className="hv-card"
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'var(--bg2)',
        border: retired ? '1px dashed var(--line2)' : '1px solid var(--line)',
        borderRadius: 6,
        padding: '11px 13px 10px',
        cursor: 'pointer',
        opacity: retired ? 0.65 : 1,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: 'var(--bg3)',
            border: '1px solid var(--line2)',
            display: 'grid',
            placeItems: 'center',
            ...mono(700, 11),
            color: 'var(--agent)',
            flex: 'none',
          }}
        >
          {entry.transport === 'http' ? '⇄' : '⌘'}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              ...mono(600, 11.5),
              letterSpacing: '.03em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.name}
          </div>
          <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.08em', marginTop: 1 }}>
            {entry.slug} · {entry.transport.toUpperCase()}
            {retired ? ' · RETIRED' : ''}
          </div>
        </div>
        <ScopeTag engagementId={entry.engagementId} projects={projects} />
      </div>
      <div
        style={{
          ...mono(400, 10.5),
          color: 'var(--tx2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.transport === 'http' ? entry.url : [entry.command, ...entry.args].filter(Boolean).join(' ')}
      </div>
      {entry.description && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--tx3)',
            lineHeight: 1.45,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {entry.description}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          ...mono(400, 8.5),
          color: 'var(--tx3)',
          letterSpacing: '.06em',
          flexWrap: 'wrap',
        }}
      >
        {entry.requiresAuth && (
          <span
            style={{ color: 'var(--warn)' }}
            title={`Runners inject ${entry.authEnv ?? ''} from their own keychain`}
          >
            ⚿ AUTH · {entry.authEnv}
          </span>
        )}
        <span>
          {usedBy} AGENT{usedBy === 1 ? '' : 'S'}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button
            className="hv-border"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            style={{
              ...mono(500, 8.5),
              background: 'none',
              border: `1px solid ${canEdit ? 'var(--agent)' : 'var(--line2)'}`,
              color: canEdit ? 'var(--agent)' : 'var(--tx2)',
              borderRadius: 3,
              padding: '3px 8px',
              cursor: 'pointer',
              letterSpacing: '.07em',
            }}
          >
            {canEdit ? 'EDIT' : 'DETAILS'}
          </button>
        </span>
      </div>
    </motion.div>
  );
}

function SkillCard({
  entry,
  projects,
  usedBy,
  canEdit,
  onEdit,
}: {
  entry: RegistrySkill;
  projects: AgentsOverviewProject[];
  usedBy: number;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const retired = entry.status === 'retired';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', visualDuration: 0.26, bounce: 0.18 }}
      className="hv-card"
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'var(--bg2)',
        border: retired ? '1px dashed var(--line2)' : '1px solid var(--line)',
        borderRadius: 6,
        padding: '11px 13px 10px',
        cursor: 'pointer',
        opacity: retired ? 0.65 : 1,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: 'var(--bg3)',
            border: '1px solid var(--line2)',
            display: 'grid',
            placeItems: 'center',
            ...mono(700, 11),
            color: 'var(--acc)',
            flex: 'none',
          }}
        >
          ✦
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              ...mono(600, 11.5),
              letterSpacing: '.03em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.name}
          </div>
          <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.08em', marginTop: 1 }}>
            {entry.slug}
            {retired ? ' · RETIRED' : ''}
          </div>
        </div>
        <ScopeTag engagementId={entry.engagementId} projects={projects} />
      </div>
      {entry.description && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--tx3)',
            lineHeight: 1.45,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {entry.description}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          ...mono(400, 8.5),
          color: 'var(--tx3)',
          letterSpacing: '.06em',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          {entry.harnesses.map((h) => {
            const b = harnessBrand(h);
            return (
              <span key={h} title={b?.label ?? h} style={{ display: 'inline-flex' }}>
                {b ? b.mark(12) : h}
              </span>
            );
          })}
        </span>
        <span>{entry.content.length ? `${Math.max(1, Math.round(entry.content.length / 1000))}K CHARS` : 'EMPTY'}</span>
        <span>
          {usedBy} AGENT{usedBy === 1 ? '' : 'S'}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button
            className="hv-border"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            style={{
              ...mono(500, 8.5),
              background: 'none',
              border: `1px solid ${canEdit ? 'var(--agent)' : 'var(--line2)'}`,
              color: canEdit ? 'var(--agent)' : 'var(--tx2)',
              borderRadius: 3,
              padding: '3px 8px',
              cursor: 'pointer',
              letterSpacing: '.07em',
            }}
          >
            {canEdit ? 'EDIT' : 'DETAILS'}
          </button>
        </span>
      </div>
    </motion.div>
  );
}

type Editing = { kind: 'mcp'; entry: RegistryMcpServer | null } | { kind: 'skill'; entry: RegistrySkill | null };

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        borderBottom: '1px solid var(--line)',
        paddingBottom: 5,
      }}
    >
      <span style={{ ...mono(600, 9.5), letterSpacing: '.12em', color: 'var(--tx2)' }}>{title}</span>
      {hint && <span style={{ fontSize: 10.5, color: 'var(--tx3)' }}>{hint}</span>}
    </div>
    {children}
  </section>
);

const parseArgs = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const parseEnv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
const slugify = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function RegistryDrawer({
  editing,
  scope,
  projects,
  canEdit,
  onClose,
  onSaved,
  toast,
}: {
  editing: Editing;
  scope: Scope;
  projects: AgentsOverviewProject[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
  toast: (msg: string) => void;
}) {
  const creating = editing.entry === null;
  const engagementId = editing.entry ? editing.entry.engagementId : scope === 'shared' ? null : scope;
  const project = engagementId ? projects.find((p) => p.id === engagementId) : null;
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [slugTouched, setSlugTouched] = useState(Boolean(editing.entry));

  const mcp = editing.kind === 'mcp' ? editing.entry : null;
  const skill = editing.kind === 'skill' ? editing.entry : null;
  const [name, setName] = useState(editing.entry?.name ?? '');
  const [slug, setSlug] = useState(editing.entry?.slug ?? '');
  const [description, setDescription] = useState(editing.entry?.description ?? '');
  const [status, setStatus] = useState<'published' | 'retired'>(editing.entry?.status ?? 'published');
  const [transport, setTransport] = useState<'stdio' | 'http'>(mcp?.transport ?? 'stdio');
  const [command, setCommand] = useState(mcp?.command ?? '');
  const [args, setArgs] = useState((mcp?.args ?? []).join('\n'));
  const [url, setUrl] = useState(mcp?.url ?? '');
  const [env, setEnv] = useState(
    Object.entries(mcp?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  );
  const [requiresAuth, setRequiresAuth] = useState(mcp?.requiresAuth ?? false);
  const [harnesses, setHarnesses] = useState<string[]>(skill?.harnesses ?? ['claude-code']);
  const [content, setContent] = useState(skill?.content ?? '');

  // The slug follows the name until someone edits the slug by hand.
  const rename = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const authEnv = `MCP_AUTH_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const disabledStyle = canEdit ? {} : { opacity: 0.7, cursor: 'not-allowed' as const };

  const submit = () => {
    if (!name.trim()) return toast('Give it a name');
    if (!slug) return toast('The slug needs at least one letter or digit');
    if (editing.kind === 'mcp' && transport === 'stdio' && !command.trim())
      return toast('A stdio server needs a command');
    if (editing.kind === 'mcp' && transport === 'http' && !url.trim()) return toast('An http server needs a URL');
    setBusy(true);
    const fail = (e: Error) => {
      setBusy(false);
      toast(`Could not save — ${e.message}`);
    };
    if (editing.kind === 'mcp') {
      const payload: McpServerPayload = {
        engagementId,
        slug,
        name: name.trim(),
        description: description.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() : null,
        args: transport === 'stdio' ? parseArgs(args) : [],
        url: transport === 'http' ? url.trim() : null,
        env: parseEnv(env),
        requiresAuth,
        status,
      };
      (editing.entry ? api.updateMcpServer(editing.entry.id, payload) : api.createMcpServer(payload))
        .then(() => onSaved(`${name.trim()} ${creating ? 'published' : 'updated'}`))
        .catch(fail);
    } else {
      const payload: SkillPayload = {
        engagementId,
        slug,
        name: name.trim(),
        description: description.trim(),
        content,
        harnesses,
        status,
      };
      (editing.entry ? api.updateSkill(editing.entry.id, payload) : api.createSkill(payload))
        .then(() => onSaved(`${name.trim()} ${creating ? 'published' : 'updated'}`))
        .catch(fail);
    }
  };

  const remove = () => {
    if (!editing.entry) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    (editing.kind === 'mcp' ? api.deleteMcpServer(editing.entry.id) : api.deleteSkill(editing.entry.id))
      .then(() => onSaved(`${editing.entry?.name ?? 'Entry'} removed from the registry`))
      .catch((e: Error) => {
        setConfirmDelete(false);
        toast(`Could not remove — ${e.message}`);
      });
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 40 }}
      />
      <motion.aside
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ type: 'spring', visualDuration: 0.28, bounce: 0.12 }}
        role="dialog"
        aria-label={
          creating ? `New ${editing.kind === 'mcp' ? 'MCP server' : 'skill'}` : `Edit ${editing.entry?.name ?? ''}`
        }
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 520,
          maxWidth: '100vw',
          background: 'var(--bg2)',
          borderLeft: '1px solid var(--line)',
          zIndex: 41,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-12px 0 40px rgba(0,0,0,.35)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            flex: 'none',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ ...mono(600, 12.5), letterSpacing: '.06em' }}>
              {creating ? (editing.kind === 'mcp' ? 'NEW MCP SERVER' : 'NEW SKILL') : editing.entry?.name}
            </div>
            <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginTop: 2 }}>
              {engagementId
                ? `${project?.client.toUpperCase() ?? engagementId} — PROJECT SCOPE`
                : 'SHARED — EVERY PROJECT'}
            </div>
          </div>
          <button
            className="hv-tx"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none',
              background: 'none',
              color: 'var(--tx3)',
              fontSize: 18,
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          {!canEdit && (
            <div
              style={{
                border: '1px solid var(--line2)',
                borderRadius: 3,
                padding: '7px 9px',
                fontSize: 11.5,
                color: 'var(--tx3)',
              }}
            >
              Read-only — {engagementId ? 'the project’s leads' : 'admins'} publish to this scope.
            </div>
          )}
          <Section title="IDENTITY">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={LABEL}>NAME</div>
                <input
                  style={{ ...FIELD, ...disabledStyle }}
                  value={name}
                  disabled={!canEdit}
                  onChange={(e) => rename(e.target.value)}
                  maxLength={80}
                  autoFocus={creating}
                  placeholder={editing.kind === 'mcp' ? 'e.g. Jira Cloud' : 'e.g. Review style'}
                />
              </div>
              <div>
                <div style={LABEL}>SLUG</div>
                <input
                  style={{ ...FIELD, ...mono(400, 11.5), ...disabledStyle }}
                  value={slug}
                  disabled={!canEdit}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(slugify(e.target.value));
                  }}
                  maxLength={60}
                />
              </div>
            </div>
            <div>
              <div style={LABEL}>DESCRIPTION</div>
              <textarea
                style={{ ...FIELD, minHeight: 50, resize: 'vertical', fontFamily: 'inherit', ...disabledStyle }}
                value={description}
                disabled={!canEdit}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                placeholder="What it gives an agent and when to attach it."
              />
            </div>
          </Section>

          {editing.kind === 'mcp' ? (
            <Section title="SERVER" hint="how the runner launches or reaches it">
              <div>
                <div style={LABEL}>TRANSPORT</div>
                <select
                  style={{ ...FIELD, ...disabledStyle }}
                  value={transport}
                  disabled={!canEdit}
                  onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
                >
                  <option value="stdio">stdio — the runner spawns a process</option>
                  <option value="http">http — a Streamable HTTP endpoint</option>
                </select>
              </div>
              {transport === 'stdio' ? (
                <>
                  <div>
                    <div style={LABEL}>COMMAND</div>
                    <input
                      style={{ ...FIELD, ...mono(400, 11.5), ...disabledStyle }}
                      value={command}
                      disabled={!canEdit}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="npx"
                      maxLength={200}
                    />
                  </div>
                  <div>
                    <div style={LABEL}>ARGUMENTS (ONE PER LINE)</div>
                    <textarea
                      style={{ ...FIELD, ...mono(400, 11.5), minHeight: 64, resize: 'vertical', ...disabledStyle }}
                      value={args}
                      disabled={!canEdit}
                      onChange={(e) => setArgs(e.target.value)}
                      placeholder={'-y\n@modelcontextprotocol/server-github'}
                    />
                  </div>
                </>
              ) : (
                <div>
                  <div style={LABEL}>URL</div>
                  <input
                    style={{ ...FIELD, ...mono(400, 11.5), ...disabledStyle }}
                    value={url}
                    disabled={!canEdit}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    maxLength={500}
                  />
                </div>
              )}
              <div>
                <div style={LABEL}>ENVIRONMENT (KEY=VALUE PER LINE, NO SECRETS)</div>
                <textarea
                  style={{ ...FIELD, ...mono(400, 11.5), minHeight: 48, resize: 'vertical', ...disabledStyle }}
                  value={env}
                  disabled={!canEdit}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder="JIRA_SITE=your-org.atlassian.net"
                />
              </div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  fontSize: 11.5,
                  cursor: canEdit ? 'pointer' : 'default',
                }}
              >
                <input
                  type="checkbox"
                  checked={requiresAuth}
                  disabled={!canEdit}
                  onChange={(e) => setRequiresAuth(e.target.checked)}
                  style={{ marginTop: 2, accentColor: 'var(--agent)' }}
                />
                <span>
                  Requires a credential
                  <div style={{ fontSize: 10.5, color: 'var(--tx3)', lineHeight: 1.5 }}>
                    Runners inject <code style={mono(500, 10)}>{authEnv}</code> from their own keychain (desktop
                    Identity → MCP server auth) or environment. The value never touches the registry.
                  </div>
                </span>
              </label>
            </Section>
          ) : (
            <Section title="SKILL" hint="written into the task workdir as SKILL.md">
              <div>
                <div style={LABEL}>HARNESSES THAT LOAD IT</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {HARNESS_OPTIONS.map((h) => {
                    const on = harnesses.includes(h.id);
                    return (
                      <label
                        key={h.id}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 11.5,
                          color: on ? 'var(--tx)' : 'var(--tx3)',
                          cursor: canEdit ? 'pointer' : 'default',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!canEdit}
                          onChange={() => setHarnesses((hs) => (on ? hs.filter((x) => x !== h.id) : [...hs, h.id]))}
                          style={{ accentColor: 'var(--agent)' }}
                        />
                        {h.label}
                      </label>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--tx3)', marginTop: 4 }}>
                  Claude Code reads `.claude/skills/&lt;slug&gt;/SKILL.md`; other harnesses get it appended to their
                  instructions.
                </div>
              </div>
              <div>
                <div style={LABEL}>CONTENT (MARKDOWN)</div>
                <textarea
                  style={{
                    ...FIELD,
                    ...mono(400, 11.5),
                    minHeight: 260,
                    resize: 'vertical',
                    lineHeight: 1.5,
                    ...disabledStyle,
                  }}
                  value={content}
                  disabled={!canEdit}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={'# When to use\n\n# Steps\n\n# Rules'}
                  maxLength={60000}
                />
                <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', marginTop: 4, letterSpacing: '.06em' }}>
                  {content.length.toLocaleString()} / 60,000
                </div>
              </div>
            </Section>
          )}

          <Section title="STATUS">
            <select
              style={{ ...FIELD, ...disabledStyle }}
              value={status}
              disabled={!canEdit}
              onChange={(e) => setStatus(e.target.value as 'published' | 'retired')}
            >
              <option value="published">Published — attachable, delivered at claim time</option>
              <option value="retired">Retired — kept for reference, no longer delivered</option>
            </select>
            {editing.entry && (
              <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.06em' }}>
                LAST CHANGED BY {editing.entry.updatedBy.toUpperCase() || '—'}
              </div>
            )}
          </Section>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 18px',
            borderTop: '1px solid var(--line)',
            flex: 'none',
          }}
        >
          {editing.entry && canEdit && (
            <button
              className="hv-border"
              onClick={remove}
              style={{
                ...mono(500, 9),
                background: 'none',
                border: `1px solid ${confirmDelete ? 'var(--bad)' : 'var(--line2)'}`,
                color: confirmDelete ? 'var(--bad)' : 'var(--tx3)',
                borderRadius: 3,
                padding: '6px 10px',
                cursor: 'pointer',
                letterSpacing: '.07em',
              }}
            >
              {confirmDelete ? 'CONFIRM REMOVE' : 'REMOVE'}
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              className="hv-tx2"
              onClick={onClose}
              style={{
                ...mono(500, 10),
                background: 'none',
                border: '1px solid var(--line2)',
                color: 'var(--tx3)',
                borderRadius: 3,
                padding: '6px 12px',
                cursor: 'pointer',
                letterSpacing: '.06em',
              }}
            >
              {canEdit ? 'CANCEL' : 'CLOSE'}
            </button>
            {canEdit && (
              <button
                onClick={submit}
                disabled={busy}
                style={{
                  ...mono(500, 10),
                  background: 'var(--agent)',
                  border: '1px solid var(--agent)',
                  color: '#fff',
                  borderRadius: 3,
                  padding: '6px 14px',
                  cursor: busy ? 'wait' : 'pointer',
                  letterSpacing: '.06em',
                  opacity: busy ? 0.7 : 1,
                }}
              >
                {busy ? 'SAVING…' : creating ? 'PUBLISH' : 'SAVE'}
              </button>
            )}
          </div>
        </div>
      </motion.aside>
    </>
  );
}

export function RegistryView({
  projects,
  agents,
  canLead,
  canPublishShared,
  toast,
}: {
  projects: AgentsOverviewProject[];
  agents: ProjectAgent[];
  canLead: (engagementId: string) => boolean;
  canPublishShared: boolean;
  toast: (msg: string) => void;
}) {
  const [scope, setScope] = useState<Scope>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY) ?? 'shared';
    } catch {
      return 'shared';
    }
  });
  const [mcpServers, setMcpServers] = useState<RegistryMcpServer[]>([]);
  const [skills, setSkills] = useState<RegistrySkill[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Which scope the current lists belong to — empty states only render once
  // the selected scope has actually loaded, without a setState-in-effect reset.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const projectId = scope === 'shared' ? null : scope;
  const canEditScope = scope === 'shared' ? canPublishShared : canLead(scope);

  const load = useCallback(() => {
    return api
      .registry(projectId)
      .then((r) => {
        // A project scope shows shared entries too; keep only the scope's own here.
        setMcpServers(projectId ? r.mcpServers.filter((m) => m.engagementId === projectId) : r.mcpServers);
        setSkills(projectId ? r.skills.filter((s) => s.engagementId === projectId) : r.skills);
        setError(null);
        setLoadedFor(scope);
      })
      .catch((e: Error) => setError(e.message));
  }, [projectId, scope]);
  const loaded = loadedFor === scope;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_KEY, scope);
    } catch {
      // fine
    }
  }, [scope]);

  const usage = useMemo(() => {
    const mcp = new Map<number, number>();
    const sk = new Map<number, number>();
    for (const a of agents) {
      for (const id of a.mcpServers) mcp.set(id, (mcp.get(id) ?? 0) + 1);
      for (const id of a.skills) sk.set(id, (sk.get(id) ?? 0) + 1);
    }
    return { mcp, sk };
  }, [agents]);

  const canEditEntry = (engagementId: string | null) => (engagementId ? canLead(engagementId) : canPublishShared);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em' }}>SCOPE</span>
        <Chip
          active={scope === 'shared'}
          onClick={() => setScope('shared')}
          title="Shared entries are attachable from every project; admins publish them"
        >
          SHARED
        </Chip>
        {projects.map((p) => (
          <Chip
            key={p.id}
            active={scope === p.id}
            onClick={() => setScope(p.id)}
            title={`${p.name} — its leads publish here`}
          >
            {p.client.toUpperCase()}
          </Chip>
        ))}
        <span style={{ fontSize: 11.5, color: 'var(--tx3)', marginLeft: 6 }}>
          {scope === 'shared'
            ? 'Published for every project; admins maintain.'
            : 'Published for this project only; its leads maintain. Shared entries are attachable too.'}
        </span>
      </div>

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 12px',
            border: '1px solid var(--bad)',
            borderRadius: 4,
            color: 'var(--bad)',
            ...mono(400, 10.5),
          }}
        >
          COULDN’T LOAD THE REGISTRY: {error}
          <button
            onClick={() => void load()}
            style={{
              border: '1px solid var(--bad)',
              background: 'none',
              color: 'var(--bad)',
              borderRadius: 3,
              padding: '2px 9px',
              ...mono(500, 10),
              cursor: 'pointer',
              letterSpacing: '.06em',
            }}
          >
            RETRY
          </button>
        </div>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...mono(700, 11.5), letterSpacing: '.08em' }}>MCP SERVERS</span>
          <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em' }}>{mcpServers.length}</span>
          <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
            Tool servers an agent may reach; the console’s own server is always attached.
          </span>
          {canEditScope && (
            <button
              className="hv-border"
              onClick={() => setEditing({ kind: 'mcp', entry: null })}
              style={{
                ...mono(500, 9),
                marginLeft: 'auto',
                background: 'none',
                border: '1px solid var(--agent)',
                color: 'var(--agent)',
                borderRadius: 3,
                padding: '4px 9px',
                cursor: 'pointer',
                letterSpacing: '.08em',
              }}
            >
              + MCP SERVER
            </button>
          )}
        </div>
        {loaded && mcpServers.length === 0 ? (
          <div
            style={{
              border: '1px dashed var(--line2)',
              borderRadius: 6,
              padding: '18px 14px',
              ...mono(400, 9.5),
              color: 'var(--tx3)',
              letterSpacing: '.08em',
              textAlign: 'center',
            }}
          >
            {canEditScope ? 'NO MCP SERVERS IN THIS SCOPE — PUBLISH ONE' : 'NO MCP SERVERS IN THIS SCOPE'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            <AnimatePresence initial={false}>
              {mcpServers.map((m) => (
                <McpCard
                  key={m.id}
                  entry={m}
                  projects={projects}
                  usedBy={usage.mcp.get(m.id) ?? 0}
                  canEdit={canEditEntry(m.engagementId)}
                  onEdit={() => setEditing({ kind: 'mcp', entry: m })}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...mono(700, 11.5), letterSpacing: '.08em' }}>SKILLS</span>
          <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em' }}>{skills.length}</span>
          <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
            Reusable instructions (SKILL.md) an agent loads for its run.
          </span>
          {canEditScope && (
            <button
              className="hv-border"
              onClick={() => setEditing({ kind: 'skill', entry: null })}
              style={{
                ...mono(500, 9),
                marginLeft: 'auto',
                background: 'none',
                border: '1px solid var(--agent)',
                color: 'var(--agent)',
                borderRadius: 3,
                padding: '4px 9px',
                cursor: 'pointer',
                letterSpacing: '.08em',
              }}
            >
              + SKILL
            </button>
          )}
        </div>
        {loaded && skills.length === 0 ? (
          <div
            style={{
              border: '1px dashed var(--line2)',
              borderRadius: 6,
              padding: '18px 14px',
              ...mono(400, 9.5),
              color: 'var(--tx3)',
              letterSpacing: '.08em',
              textAlign: 'center',
            }}
          >
            {canEditScope ? 'NO SKILLS IN THIS SCOPE — PUBLISH ONE' : 'NO SKILLS IN THIS SCOPE'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            <AnimatePresence initial={false}>
              {skills.map((s) => (
                <SkillCard
                  key={s.id}
                  entry={s}
                  projects={projects}
                  usedBy={usage.sk.get(s.id) ?? 0}
                  canEdit={canEditEntry(s.engagementId)}
                  onEdit={() => setEditing({ kind: 'skill', entry: s })}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      <AnimatePresence>
        {editing && (
          <RegistryDrawer
            key={`${editing.kind}-${editing.entry?.id ?? 'new'}`}
            editing={editing}
            scope={scope}
            projects={projects}
            canEdit={canEditEntry(editing.entry ? editing.entry.engagementId : projectId)}
            toast={toast}
            onClose={() => setEditing(null)}
            onSaved={(message) => {
              toast(message);
              setEditing(null);
              void load();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
