import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api';
import type {
  AgentAccessLevel,
  AgentAction,
  AgentSecurityCatalog,
  AgentSecuritySettings,
  ProjectAgent,
  RunnerLoadBalance,
} from '../types';
import { mono } from '../util';
import { FIELD, LABEL, relTime } from '../lib/agents';

/**
 * Panels shared by the Agents page's drawer and the map: the per-agent
 * security controls (DAT-212), runner load balancing (DAT-214), and the small
 * form primitives both use. Kept out of AgentsPage.tsx so the page reads as
 * layout and the panels as behavior.
 */

const ACCESS_LEVEL_LABEL: Record<AgentAccessLevel, string> = {
  restricted: 'RESTRICTED — no scopes',
  standard: 'STANDARD — delivery runner',
  elevated: 'ELEVATED — everything',
  custom: 'CUSTOM — picked per action',
};

/** 'claim_work' → 'Claim work', for when the catalog has not loaded yet. */
const humanizeAction = (id: string) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Only used when the catalog request fails — the labels and preset scopes come
 * from the server so the permission model has one home. The panel still needs
 * every action listed to stay usable, and the server normalizes presets on save
 * either way.
 */
const FALLBACK_ACTIONS: AgentAction[] = ['claim_work', 'git_credential', 'coordination', 'pr_review'];

/** Copy-to-clipboard value chip — used for the MCP URL the agent needs. */
export function CopyField({ label, value, toast }: { label: string; value: string; toast: (msg: string) => void }) {
  return (
    <div>
      <div style={LABEL}>{label}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          readOnly
          value={value}
          style={{ ...FIELD, ...mono(400, 11), flex: 1 }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          className="hv-border"
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(() => toast('Copied'))
              .catch(() => toast('Copy failed — select the text instead'));
          }}
          style={{
            ...mono(500, 9),
            background: 'none',
            border: '1px solid var(--line2)',
            color: 'var(--tx2)',
            borderRadius: 3,
            padding: '0 10px',
            cursor: 'pointer',
            letterSpacing: '.06em',
          }}
        >
          COPY
        </button>
      </div>
    </div>
  );
}

/**
 * Per-agent security controls (DAT-212): the enable switch and the permission
 * scope the backend enforces at action-execution time. Leads edit; everyone
 * else reads.
 *
 * Each agent's settings are addressed by its own record id, so editing one never
 * touches another. Observed runners whose stored row has not been written yet
 * (recordId null) render read-only rather than pretending to save.
 */
export function SecurityPanel({
  agent,
  canEdit,
  catalog,
  onSaved,
  toast,
}: {
  agent: ProjectAgent;
  canEdit: boolean;
  catalog: AgentSecurityCatalog | null;
  onSaved: (settings: AgentSecuritySettings) => void;
  toast: (msg: string) => void;
}) {
  // Seeded once per agent: the panel is keyed by agent id, so selecting a
  // different agent remounts it with that agent's settings. No sync effect —
  // a save updates the draft directly, and the page's 15s poll must never
  // clobber an edit in progress.
  const [draft, setDraft] = useState<AgentSecuritySettings>(agent.security);
  const [busy, setBusy] = useState(false);

  const editable = canEdit && agent.recordId !== null;
  const actions: { id: AgentAction; label: string }[] =
    catalog?.actions ?? FALLBACK_ACTIONS.map((id) => ({ id, label: humanizeAction(id) }));
  const dirty =
    draft.enabled !== agent.security.enabled ||
    draft.accessLevel !== agent.security.accessLevel ||
    draft.allowedActions.join(',') !== agent.security.allowedActions.join(',');

  /** Presets rewrite the scope list; ticking an individual action means custom. */
  const pickLevel = (level: AgentAccessLevel) =>
    setDraft((d) => ({
      ...d,
      accessLevel: level,
      allowedActions: level === 'custom' ? d.allowedActions : (catalog?.presets[level] ?? d.allowedActions),
    }));

  const toggleAction = (id: AgentAction) =>
    setDraft((d) => ({
      ...d,
      accessLevel: 'custom',
      allowedActions: d.allowedActions.includes(id)
        ? d.allowedActions.filter((a) => a !== id)
        : [...d.allowedActions, id],
    }));

  const save = () => {
    if (agent.recordId === null) return;
    setBusy(true);
    api
      .updateAgentSecurity(agent.engagementId, agent.recordId, {
        enabled: draft.enabled,
        accessLevel: draft.accessLevel,
        allowedActions: draft.allowedActions,
      })
      .then((saved) => {
        setBusy(false);
        setDraft(saved);
        onSaved(saved);
        toast(`Security settings saved for ${agent.name}`);
      })
      .catch((e: Error) => {
        setBusy(false);
        setDraft(agent.security);
        toast(`Could not save security settings — ${e.message}`);
      });
  };

  return (
    <div style={{ border: '1px solid var(--line2)', borderRadius: 4, padding: '10px 11px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ ...mono(600, 9.5), letterSpacing: '.1em', color: 'var(--tx2)' }}>SECURITY</span>
        <span
          style={{
            ...mono(500, 8.5),
            letterSpacing: '.08em',
            color: draft.enabled ? 'var(--ok)' : 'var(--bad)',
            border: `1px solid ${draft.enabled ? 'var(--ok)' : 'var(--bad)'}`,
            borderRadius: 3,
            padding: '1px 6px',
          }}
        >
          {draft.enabled ? 'ENABLED' : 'DISABLED'}
        </span>
        {editable && (
          <button
            className="hv-border"
            onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
            style={{
              ...mono(500, 8.5),
              marginLeft: 'auto',
              background: 'none',
              border: `1px solid ${draft.enabled ? 'var(--bad)' : 'var(--ok)'}`,
              color: draft.enabled ? 'var(--bad)' : 'var(--ok)',
              borderRadius: 3,
              padding: '2px 8px',
              cursor: 'pointer',
              letterSpacing: '.07em',
            }}
          >
            {draft.enabled ? 'DISABLE AGENT' : 'ENABLE AGENT'}
          </button>
        )}
      </div>

      {editable ? (
        <div style={{ marginBottom: 8 }}>
          <div style={LABEL}>ACCESS LEVEL</div>
          <select
            style={FIELD}
            value={draft.accessLevel}
            onChange={(e) => pickLevel(e.target.value as AgentAccessLevel)}
          >
            {(catalog?.accessLevels ?? (['restricted', 'standard', 'elevated', 'custom'] as AgentAccessLevel[])).map(
              (l) => (
                <option key={l} value={l}>
                  {ACCESS_LEVEL_LABEL[l] ?? l}
                </option>
              )
            )}
          </select>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 8 }}>
          <span style={{ ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.08em', width: 118, flex: 'none' }}>
            ACCESS LEVEL
          </span>
          <span style={{ fontSize: 12.5 }}>{ACCESS_LEVEL_LABEL[draft.accessLevel] ?? draft.accessLevel}</span>
        </div>
      )}

      <div style={LABEL}>PERMISSION SCOPE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {actions.map((a) => {
          const granted = draft.allowedActions.includes(a.id);
          return (
            <label
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 7,
                fontSize: 11.5,
                color: granted ? 'var(--tx)' : 'var(--tx3)',
                cursor: editable ? 'pointer' : 'default',
              }}
            >
              <input
                type="checkbox"
                checked={granted}
                disabled={!editable}
                onChange={() => toggleAction(a.id)}
                style={{ marginTop: 2, accentColor: 'var(--agent)' }}
              />
              <span>
                {a.label}
                <span style={{ ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.06em', marginLeft: 6 }}>
                  {a.id}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <div style={{ fontSize: 10.5, color: 'var(--tx3)', lineHeight: 1.5, marginTop: 8 }}>
        Enforced when the agent acts, not when it is configured: a blocked action is rejected with the reason and logged
        to the feed. Closing out a task the agent already holds is always allowed, so disabling one never strands a
        ticket mid-run — cancel the run on the board for that.
      </div>

      {draft.updatedBy && (
        <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.06em', marginTop: 6 }}>
          LAST CHANGED BY {draft.updatedBy.toUpperCase()}
          {draft.updatedAt ? ` · ${relTime(draft.updatedAt).toUpperCase()}` : ''}
        </div>
      )}

      {canEdit && agent.recordId === null && (
        <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 6 }}>
          This runner has no stored record yet — its settings become editable after the next agent sync.
        </div>
      )}

      {editable && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          {dirty && (
            <button
              className="hv-tx2"
              onClick={() => setDraft(agent.security)}
              style={{
                ...mono(500, 9),
                background: 'none',
                border: '1px solid var(--line2)',
                color: 'var(--tx3)',
                borderRadius: 3,
                padding: '4px 10px',
                cursor: 'pointer',
                letterSpacing: '.07em',
              }}
            >
              RESET
            </button>
          )}
          <button
            onClick={save}
            disabled={busy || !dirty}
            style={{
              ...mono(500, 9),
              background: dirty ? 'var(--agent)' : 'none',
              border: `1px solid ${dirty ? 'var(--agent)' : 'var(--line2)'}`,
              color: dirty ? '#fff' : 'var(--tx3)',
              borderRadius: 3,
              padding: '4px 12px',
              cursor: busy ? 'wait' : dirty ? 'pointer' : 'default',
              letterSpacing: '.07em',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? 'SAVING…' : 'SAVE SECURITY'}
          </button>
        </div>
      )}
    </div>
  );
}

export function LoadBalancingModal({
  agent,
  canEdit,
  onClose,
  toast,
}: {
  agent: ProjectAgent;
  canEdit: boolean;
  onClose: () => void;
  toast: (message: string) => void;
}) {
  const modelType = agent.harness ?? '';
  const [runners, setRunners] = useState<RunnerLoadBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    api
      .runnerLoadBalancing(agent.engagementId, modelType)
      .then((data) => setRunners(data.runners))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    return () => window.removeEventListener('keydown', onKey);
  }, [agent.engagementId, modelType, onClose]);
  const update = (name: string, values: Partial<RunnerLoadBalance>) =>
    setRunners((rows) => rows.map((r) => (r.name === name ? { ...r, ...values } : r)));
  const totalWeight = runners.reduce((sum, runner) => sum + runner.weight, 0);
  const save = () => {
    if (runners.some((r) => !Number.isInteger(r.weight) || r.weight < 0 || r.weight > 100))
      return setError('Weights must be whole numbers from 0 to 100.');
    if (totalWeight === 0) return setError('At least one runner must have a positive weight.');
    if (runners.some((r) => r.cap !== null && (!Number.isInteger(r.cap) || r.cap < 1 || r.cap > 100)))
      return setError('Caps must be blank or a whole number from 1 to 100.');
    setBusy(true);
    setError(null);
    api
      .saveRunnerLoadBalancing(
        agent.engagementId,
        modelType,
        runners.map(({ name, weight, cap }) => ({ name, weight, cap }))
      )
      .then(() => {
        toast(`Load balancing saved for ${modelType}`);
        onClose();
      })
      .catch((e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 54 }} />
      <motion.div
        initial={{ opacity: 0, transform: 'translate(-50%,-48%) scale(.97)' }}
        animate={{ opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }}
        role="dialog"
        aria-label={`Load balancing for ${agent.name}`}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          width: 520,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 50px)',
          overflowY: 'auto',
          background: 'var(--bg2)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: 18,
          zIndex: 55,
          boxShadow: '0 12px 40px rgba(0,0,0,.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'start', gap: 10 }}>
          <div>
            <div style={{ ...mono(600, 11), letterSpacing: '.1em' }}>RUNNER LOAD BALANCING</div>
            <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 3 }}>
              {agent.name} · {modelType}. Weights are relative; caps limit concurrent tasks per runner.
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: 'auto',
              border: 0,
              background: 'none',
              color: 'var(--tx3)',
              cursor: 'pointer',
              fontSize: 18,
            }}
          >
            ×
          </button>
        </div>
        {loading ? (
          <div style={{ color: 'var(--tx3)', fontSize: 12, padding: '24px 0' }}>Loading available runners…</div>
        ) : runners.length === 0 ? (
          <div style={{ color: 'var(--tx3)', fontSize: 12, padding: '24px 0' }}>
            No live or idle runners are currently available for this model type.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
            {runners.map((runner) => (
              <div
                key={runner.name}
                style={{ border: '1px solid var(--line2)', borderRadius: 4, padding: '10px 11px' }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                  <span style={{ ...mono(600, 10.5), flex: 1 }}>{runner.name}</span>
                  <span
                    style={{
                      ...mono(400, 8.5),
                      color: runner.status === 'active' ? 'var(--ok)' : 'var(--tx3)',
                      letterSpacing: '.07em',
                    }}
                  >
                    {runner.status.toUpperCase()} · {runner.activeTasks} ACTIVE
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 64px 86px', gap: 8, alignItems: 'center' }}>
                  <input
                    aria-label={`${runner.name} weight slider`}
                    type="range"
                    min={0}
                    max={100}
                    value={runner.weight}
                    disabled={!canEdit}
                    onChange={(e) => update(runner.name, { weight: Number(e.target.value) })}
                  />
                  <input
                    aria-label={`${runner.name} weight`}
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={runner.weight}
                    disabled={!canEdit}
                    onChange={(e) => update(runner.name, { weight: Number(e.target.value) })}
                    style={{ ...FIELD, padding: '5px 6px' }}
                  />
                  <input
                    aria-label={`${runner.name} concurrency cap`}
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={runner.cap ?? ''}
                    disabled={!canEdit}
                    placeholder="No cap"
                    onChange={(e) =>
                      update(runner.name, { cap: e.target.value === '' ? null : Number(e.target.value) })
                    }
                    style={{ ...FIELD, padding: '5px 6px' }}
                  />
                </div>
                <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', marginTop: 5 }}>
                  {totalWeight > 0
                    ? `${Math.round((runner.weight / totalWeight) * 100)}% TARGET SHARE`
                    : '0% TARGET SHARE'}
                </div>
              </div>
            ))}
          </div>
        )}
        {error && (
          <div role="alert" style={{ color: 'var(--bad)', fontSize: 11.5, marginTop: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            onClick={onClose}
            style={{
              ...mono(500, 9.5),
              background: 'none',
              border: '1px solid var(--line2)',
              color: 'var(--tx3)',
              borderRadius: 3,
              padding: '6px 11px',
              cursor: 'pointer',
            }}
          >
            CANCEL
          </button>
          {canEdit && (
            <button
              onClick={save}
              disabled={busy || loading || runners.length === 0}
              style={{
                ...mono(500, 9.5),
                background: 'var(--agent)',
                border: '1px solid var(--agent)',
                color: '#fff',
                borderRadius: 3,
                padding: '6px 12px',
                cursor: busy ? 'wait' : 'pointer',
                opacity: busy || loading || runners.length === 0 ? 0.6 : 1,
              }}
            >
              {busy ? 'SAVING…' : 'SAVE'}
            </button>
          )}
        </div>
      </motion.div>
    </>
  );
}
