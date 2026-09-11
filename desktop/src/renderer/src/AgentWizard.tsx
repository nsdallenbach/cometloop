import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { harnessBrand, providerBrand } from '../../../../shared/design/AgentLogos';

/**
 * New-agent / configure wizard (DAT-280): the one place a developer sets up
 * an agent on this machine. Five short steps, tiles over forms:
 *   1 Agent — pick the coding agent (logo grid)
 *   2 Model — harness default or a model from the console's catalog
 *   3 Projects — which projects its instances claim from
 *   4 Tools — MCP servers and skills from the registry
 *   5 Launch — instances, auto-start, and go
 * Editing an existing agent opens the same wizard at step 2.
 */

const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

const KIND_HARNESS: Record<AgentKind, string> = { claude: 'claude-code', codex: 'codex' };

/** Agents the wizard can offer; only the first two have runner adapters today. */
const AGENT_TILES: { kind: AgentKind | 'gemini' | 'copilot' | 'cursor'; harness: string; available: boolean }[] = [
  { kind: 'claude', harness: 'claude-code', available: true },
  { kind: 'codex', harness: 'codex', available: true },
  { kind: 'gemini', harness: 'gemini', available: false },
  { kind: 'copilot', harness: 'copilot', available: false },
  { kind: 'cursor', harness: 'cursor', available: false },
];

const STEPS = ['Agent', 'Model', 'Projects', 'Tools', 'Launch'] as const;
type Step = 0 | 1 | 2 | 3 | 4;

export interface WizardResult {
  kind: AgentKind;
  config: AgentKindConfig;
}

export function AgentWizard({
  kinds,
  initialKind,
  onClose,
  onApply,
}: {
  kinds: AgentsState['kinds'];
  /** Existing agent to reconfigure; undefined = new agent (starts at step 1). */
  initialKind?: AgentKind;
  onClose: () => void;
  onApply: (result: WizardResult) => Promise<void> | void;
}) {
  const editing = Boolean(initialKind);
  const [step, setStep] = useState<Step>(editing ? 1 : 0);
  const [kind, setKind] = useState<AgentKind | null>(initialKind ?? null);
  const base = kind ? kinds[kind] : null;
  const [model, setModel] = useState<string>(base?.model ?? '');
  const [customModel, setCustomModel] = useState(false);
  const [projects, setProjects] = useState<string[]>(base?.projects ?? []);
  const [mcpServers, setMcp] = useState<string[]>(base?.mcpServers ?? []);
  const [skills, setSkills] = useState<string[]>(base?.skills ?? []);
  const [instances, setInstances] = useState<number>(base ? Math.max(1, base.instances) : 1);
  const [autoStart, setAutoStart] = useState<boolean>(base?.autoStart ?? true);
  const [busy, setBusy] = useState(false);

  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [models, setModels] = useState<Record<string, { id: string; label: string; provider: string; default?: boolean }[]>>({});
  const [registry, setRegistry] = useState<RegistryView | null>(null);
  const [warn, setWarn] = useState('');

  useEffect(() => {
    void window.desktopBridge.listEngagements().then((r) => (r.ok ? setEngagements(r.engagements) : setWarn(r.error)));
    void window.desktopBridge.consoleModels().then((r) => {
      if (r.ok) setModels(r.models.harnessModels as typeof models);
    });
  }, []);

  // When a new agent is picked, seed its draft from whatever this machine
  // already has for that type (a reconfigure through the "new" path).
  const pickKind = (k: AgentKind) => {
    setKind(k);
    const b = kinds[k];
    setModel(b.model ?? '');
    setProjects(b.projects);
    setMcp(b.mcpServers);
    setSkills(b.skills);
    setInstances(Math.max(1, b.instances));
    setAutoStart(b.autoStart);
  };

  const scopeKey = projects.join(',');
  useEffect(() => {
    if (step < 3) return;
    let stale = false;
    void window.desktopBridge.consoleRegistry(scopeKey ? scopeKey.split(',') : []).then((r) => {
      if (stale) return;
      if (r.ok) setRegistry(r.registry);
      else setWarn(r.error);
    });
    return () => {
      stale = true;
    };
  }, [scopeKey, step]);

  const harnessId = kind ? KIND_HARNESS[kind] : null;
  const brand = harnessId ? harnessBrand(harnessId) : null;
  const modelOptions = useMemo(() => (harnessId ? (models[harnessId] ?? []) : []), [models, harnessId]);
  const showCustom = customModel || (model !== '' && !modelOptions.some((m) => m.id === model));
  const canNext = step === 0 ? kind !== null : true;
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const apply = async () => {
    if (!kind) return;
    setBusy(true);
    try {
      await onApply({
        kind,
        config: { instances, autoStart, projects, model: model.trim() || null, mcpServers, skills },
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 50, display: 'grid', placeItems: 'center' }}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={editing ? 'Configure agent' : 'New agent'}
        style={{
          width: 780,
          maxWidth: 'calc(100vw - 48px)',
          height: 560,
          maxHeight: 'calc(100vh - 48px)',
          background: 'var(--bg2)',
          border: '1px solid var(--line2)',
          borderRadius: 12,
          boxShadow: '0 24px 80px rgba(0,0,0,.55)',
          display: 'grid',
          gridTemplateColumns: '176px 1fr',
          overflow: 'hidden',
        }}
      >
        {/* Step rail */}
        <div style={{ background: 'var(--bg)', borderRight: '1px solid var(--line)', padding: '22px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ ...mono(600, 10), letterSpacing: '.12em', color: 'var(--tx3)', marginBottom: 12 }}>{editing ? 'CONFIGURE' : 'NEW AGENT'}</div>
          {STEPS.map((label, i) => {
            const active = i === step;
            const done = i < step;
            const reachable = editing ? i >= 1 : i <= step || (kind !== null && i <= 4);
            return (
              <button
                key={label}
                className="no-drag"
                disabled={!reachable || (i === 0 && editing)}
                onClick={() => setStep(i as Step)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: active ? 'var(--bg3)' : 'transparent',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 10px',
                  color: active ? 'var(--tx)' : done ? 'var(--tx2)' : 'var(--tx3)',
                  cursor: reachable ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  textAlign: 'left',
                  opacity: i === 0 && editing ? 0.45 : 1,
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    ...mono(600, 9.5),
                    background: done ? 'var(--agent)' : active ? 'var(--tx)' : 'var(--line2)',
                    color: done || active ? 'var(--bg)' : 'var(--tx2)',
                    flex: 'none',
                  }}
                >
                  {done ? '✓' : i + 1}
                </span>
                {label}
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          {brand && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: '1px solid var(--line)' }}>
              <span style={{ display: 'inline-flex' }}>{brand.mark(20)}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--tx2)' }}>{brand.label}</span>
            </div>
          )}
        </div>

        {/* Step body */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px 26px 10px' }}>
            {step === 0 && (
              <StepFrame title="Choose an agent" hint="The coding agent this machine will run for tickets.">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  {AGENT_TILES.map((t) => {
                    const b = harnessBrand(t.harness);
                    const k = t.kind as AgentKind;
                    const info = t.available ? kinds[k] : null;
                    const selected = kind === t.kind;
                    const installed = info?.installed ?? false;
                    return (
                      <Tile
                        key={t.kind}
                        selected={selected}
                        disabled={!t.available}
                        onClick={() => t.available && pickKind(k)}
                        tall
                      >
                        <span style={{ display: 'inline-flex', height: 44, alignItems: 'center' }}>{b?.mark(40)}</span>
                        <div style={{ fontSize: 14, fontWeight: 700, marginTop: 10 }}>{b?.label ?? t.kind}</div>
                        <Pill tone={!t.available ? 'muted' : installed ? 'ok' : 'warn'}>
                          {!t.available ? 'SOON' : installed ? (info?.version ? info.version.replace(/^[^0-9]*/, 'v') : 'INSTALLED') : 'NOT ON PATH'}
                        </Pill>
                        {info && info.instances > 0 && (
                          <div style={{ ...mono(400, 9), color: 'var(--tx3)', marginTop: 6, letterSpacing: '.06em' }}>
                            {info.instances} CONFIGURED
                          </div>
                        )}
                      </Tile>
                    );
                  })}
                </div>
              </StepFrame>
            )}

            {step === 1 && (
              <StepFrame title="Model" hint={`What ${brand?.label ?? 'the agent'} runs. Default keeps the harness's own choice.`}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                  <Tile
                    selected={!showCustom && model === ''}
                    onClick={() => {
                      setCustomModel(false);
                      setModel('');
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700 }}>Harness default</div>
                    <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 3 }}>whatever the CLI is set to</div>
                  </Tile>
                  {modelOptions.map((m) => {
                    const pb = providerBrand(m.provider);
                    return (
                      <Tile
                        key={m.id}
                        selected={!showCustom && model === m.id}
                        onClick={() => {
                          setCustomModel(false);
                          setModel(m.id);
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {pb && <span style={{ display: 'inline-flex' }}>{pb.mark(16)}</span>}
                          <span style={{ fontSize: 13, fontWeight: 700 }}>{m.label}</span>
                          {m.default && <Pill tone="muted">DEFAULT</Pill>}
                        </div>
                        <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginTop: 4 }}>{m.id}</div>
                      </Tile>
                    );
                  })}
                  <Tile
                    selected={showCustom}
                    onClick={() => {
                      setCustomModel(true);
                      if (modelOptions.some((m) => m.id === model)) setModel('');
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700 }}>Other</div>
                    {showCustom ? (
                      <input
                        autoFocus
                        className="no-drag"
                        value={model}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder={kind === 'codex' ? 'gpt-5.3-codex' : 'claude-opus-5'}
                        style={{ ...field, ...mono(400, 11.5), marginTop: 6 }}
                      />
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 3 }}>type a model id</div>
                    )}
                  </Tile>
                </div>
              </StepFrame>
            )}

            {step === 2 && (
              <StepFrame title="Projects" hint="Which projects this agent picks work from.">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                  <Tile selected={projects.length === 0} onClick={() => setProjects([])}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>Any project</div>
                    <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 3 }}>shared pool + routed to you</div>
                  </Tile>
                  {engagements.map((p) => (
                    <Tile key={p.id} selected={projects.includes(p.id)} onClick={() => toggle(projects, setProjects, p.id)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.health === 'ok' ? 'var(--ok)' : p.health === 'risk' ? 'var(--warn)' : 'var(--bad)' }} />
                        <span style={{ ...mono(700, 11), letterSpacing: '.06em' }}>{p.client.toUpperCase()}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--tx2)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                    </Tile>
                  ))}
                </div>
              </StepFrame>
            )}

            {step === 3 && (
              <StepFrame title="Tools & skills" hint="From the registry. Servers needing a key use Identity → MCP server auth.">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
                  <div>
                    <Caption>MCP SERVERS</Caption>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <Tile selected locked>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700 }}>Delivery Console</span>
                          <Pill tone="ok">ALWAYS</Pill>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 3 }}>tickets · progress · flags</div>
                      </Tile>
                      {(registry?.mcpServers ?? []).map((m) => (
                        <Tile key={`${m.scope}/${m.slug}`} selected={mcpServers.includes(m.slug)} onClick={() => toggle(mcpServers, setMcp, m.slug)}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 700 }}>{m.name}</span>
                            {m.requiresAuth && <span title={`needs ${m.authEnv}`}>⚿</span>}
                            <Pill tone={m.scope === 'shared' ? 'agent' : 'muted'}>{m.scope === 'shared' ? 'SHARED' : 'PROJECT'}</Pill>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 3 }}>{m.description || `${m.slug} · ${m.transport}`}</div>
                        </Tile>
                      ))}
                      {registry && registry.mcpServers.length === 0 && <Empty>No servers published yet</Empty>}
                    </div>
                  </div>
                  <div>
                    <Caption>SKILLS</Caption>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {(registry?.skills ?? []).map((k) => {
                        const fits = !harnessId || k.harnesses.includes(harnessId);
                        return (
                          <Tile key={`${k.scope}/${k.slug}`} selected={skills.includes(k.slug)} muted={!fits} onClick={() => toggle(skills, setSkills, k.slug)}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 13, fontWeight: 700 }}>{k.name}</span>
                              {k.harnesses.map((h) => {
                                const hb = harnessBrand(h);
                                return hb ? (
                                  <span key={h} title={hb.label} style={{ display: 'inline-flex' }}>
                                    {hb.mark(12)}
                                  </span>
                                ) : null;
                              })}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 3 }}>{k.description || k.slug}</div>
                          </Tile>
                        );
                      })}
                      {registry && registry.skills.length === 0 && <Empty>No skills published yet</Empty>}
                    </div>
                  </div>
                </div>
              </StepFrame>
            )}

            {step === 4 && (
              <StepFrame title={editing ? 'Save' : 'Launch'} hint="Instances run in parallel, each with its own claim loop.">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'start' }}>
                  <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10, padding: 16, display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ display: 'inline-flex', width: 44, height: 44, borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--line2)', alignItems: 'center', justifyContent: 'center' }}>{brand?.mark(26)}</span>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 700 }}>{brand?.label}</div>
                        <div style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{model || 'harness default model'}</div>
                      </div>
                    </div>
                    <Row label="PROJECTS">{projects.length ? projects.map((p) => engagements.find((e) => e.id === p)?.client ?? p).join(' · ') : 'Any'}</Row>
                    <Row label="MCP">{mcpServers.length ? `Delivery Console + ${mcpServers.length}` : 'Delivery Console'}</Row>
                    <Row label="SKILLS">{skills.length ? String(skills.length) : 'None'}</Row>
                  </div>
                  <div style={{ display: 'grid', gap: 14 }}>
                    <div>
                      <Caption>INSTANCES</Caption>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[1, 2, 3, 4].map((n) => (
                          <button
                            key={n}
                            className="no-drag"
                            onClick={() => setInstances(n)}
                            style={{
                              width: 40,
                              height: 36,
                              borderRadius: 8,
                              border: `1px solid ${instances === n ? 'var(--agent)' : 'var(--line2)'}`,
                              background: instances === n ? 'var(--agentsoft, rgba(122,143,245,.13))' : 'var(--bg)',
                              color: 'var(--tx)',
                              ...mono(600, 13),
                              cursor: 'pointer',
                            }}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <Switch on={autoStart} onToggle={() => setAutoStart((v) => !v)} />
                      <span style={{ fontSize: 12.5 }}>Start with the app</span>
                    </label>
                    {kind && !kinds[kind].installed && (
                      <div style={{ fontSize: 11.5, color: 'var(--warn)' }}>{brand?.label} is not on PATH on this machine — instances will fail to start until it is installed.</div>
                    )}
                  </div>
                </div>
              </StepFrame>
            )}
            {warn && <div style={{ fontSize: 11.5, color: 'var(--bad)', marginTop: 12 }}>{warn}</div>}
          </div>

          {/* Footer */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 26px 16px', borderTop: '1px solid var(--line)' }}>
            <button className="no-drag" onClick={onClose} style={ghostBtn}>
              Cancel
            </button>
            <div style={{ flex: 1 }} />
            {step > (editing ? 1 : 0) && (
              <button className="no-drag" onClick={() => setStep((s) => (s - 1) as Step)} style={ghostBtn}>
                Back
              </button>
            )}
            {step < 4 ? (
              <button className="no-drag hv-lift" disabled={!canNext} onClick={() => setStep((s) => (s + 1) as Step)} style={{ ...primaryBtn, opacity: canNext ? 1 : 0.5 }}>
                Next
              </button>
            ) : (
              <button className="no-drag hv-lift" disabled={busy || !kind} onClick={() => void apply()} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                {busy ? 'Saving…' : editing ? 'Save' : 'Launch'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- small visual primitives ----------

function StepFrame({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--tx3)', marginTop: 3, marginBottom: 16 }}>{hint}</div>}
      {children}
    </div>
  );
}

function Tile({
  selected,
  disabled,
  locked,
  muted,
  tall,
  onClick,
  children,
}: {
  selected?: boolean;
  disabled?: boolean;
  locked?: boolean;
  muted?: boolean;
  tall?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={disabled || locked ? 'no-drag' : 'no-drag hv-lift'}
      disabled={disabled}
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: selected ? 'var(--agentsoft, rgba(122,143,245,.13))' : 'var(--bg)',
        border: `1px solid ${selected ? 'var(--agent)' : 'var(--line2)'}`,
        borderRadius: 10,
        padding: tall ? '18px 14px 14px' : '12px 14px',
        minHeight: tall ? 150 : undefined,
        display: 'flex',
        flexDirection: 'column',
        alignItems: tall ? 'center' : 'stretch',
        justifyContent: tall ? 'center' : 'flex-start',
        color: 'var(--tx)',
        cursor: disabled ? 'not-allowed' : locked ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : muted ? 0.55 : 1,
        fontFamily: 'inherit',
        position: 'relative',
      }}
    >
      {selected && !locked && (
        <span style={{ position: 'absolute', top: 8, right: 10, width: 16, height: 16, borderRadius: '50%', background: 'var(--agent)', color: 'var(--bg)', display: 'grid', placeItems: 'center', ...mono(700, 9) }}>✓</span>
      )}
      {children}
    </button>
  );
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'muted' | 'agent'; children: ReactNode }) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'agent' ? 'var(--agent)' : 'var(--tx3)';
  return (
    <span style={{ ...mono(500, 8.5), letterSpacing: '.08em', color, border: `1px solid ${color}`, borderRadius: 3, padding: '1px 6px', marginTop: 6, display: 'inline-block' }}>
      {children}
    </span>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <div style={{ ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.1em', marginBottom: 8 }}>{children}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11.5, color: 'var(--tx3)', border: '1px dashed var(--line2)', borderRadius: 8, padding: '12px 14px' }}>{children}</div>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ ...mono(500, 8.5), color: 'var(--tx3)', letterSpacing: '.1em', width: 64, flex: 'none' }}>{label}</span>
      <span style={{ fontSize: 12.5 }}>{children}</span>
    </div>
  );
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <span
      className="no-drag"
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      style={{ width: 34, height: 18, borderRadius: 9, background: on ? 'var(--agent)' : 'var(--line2)', position: 'relative', display: 'inline-block', transition: 'background .15s' }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
    </span>
  );
}

const field: CSSProperties = {
  width: '100%',
  background: 'var(--bg2)',
  border: '1px solid var(--line2)',
  borderRadius: 6,
  color: 'var(--tx)',
  fontSize: 12,
  padding: '6px 8px',
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
