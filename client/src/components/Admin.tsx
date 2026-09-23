import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import type { AdminData } from '../types';
import { HEALTH_COLOR, initials, mono } from '../util';
import { ModelProviders } from './ModelProviders';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  ...mono(500, 10),
  letterSpacing: '.08em',
  color: 'var(--tx3)',
  borderBottom: '1px solid var(--line)',
  padding: 'var(--rowpad)',
};
const tdBase: React.CSSProperties = { borderBottom: '1px solid var(--line)', padding: 'var(--rowpad)' };

export function Admin({
  goPortfolio,
  toast,
  onChanged,
}: {
  goPortfolio: () => void;
  toast: (msg: string) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<AdminData | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; status: number } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [memberConfirm, setMemberConfirm] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [leadDrafts, setLeadDrafts] = useState<Record<string, string>>({});
  const [leadSaved, setLeadSaved] = useState<Record<string, string>>({});
  const [busyEng, setBusyEng] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = () => {
    api
      .admin()
      .then((d) => {
        setData(d);
        setLoadError(null);
        const drafts: Record<string, string> = {};
        for (const e of d.engagements) {
          drafts[e.id] = d.leads
            .filter((l) => l.engagementId === e.id)
            .map((l) => l.email)
            .join(', ');
        }
        setLeadDrafts(drafts);
        setLeadSaved(drafts);
      })
      .catch((e: Error) => setLoadError({ message: e.message, status: e instanceof ApiError ? e.status : -1 }));
  };

  const saveLeads = (engId: string) => {
    const raw = leadDrafts[engId] ?? '';
    if (raw.trim() === (leadSaved[engId] ?? '').trim()) return;
    const emails = raw
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const invalid = emails.filter((e) => !EMAIL_RE.test(e));
    if (invalid.length > 0) {
      toast(`Not a valid email: ${invalid[0]} — leads not saved`);
      return;
    }
    api
      .setLeads(engId, emails)
      .then(() => {
        setLeadSaved((s) => ({ ...s, [engId]: raw }));
        toast(emails.length > 0 ? `Leads updated for ${engId}` : `Leads cleared for ${engId}`);
      })
      .catch((e: Error) => {
        // Keep the typed draft so the admin can correct it instead of losing it.
        toast(`Lead update failed: ${e.message}`);
      });
  };

  const deleteMember = (id: number, name: string) => {
    if (deleting) return;
    setDeleting(true);
    api
      .deleteMember(id)
      .then(() => {
        toast(`${name} removed from the bench`);
        reload();
        onChanged();
      })
      .catch(() => toast('Remove failed'))
      .finally(() => {
        setDeleting(false);
        setMemberConfirm(null);
      });
  };

  useEffect(reload, []);

  const assigned = (engId: string, memberId: number) =>
    data?.assignments.some((a) => a.engagementId === engId && a.memberId === memberId) ?? false;

  const toggleMember = (engId: string, memberId: number) => {
    if (!data || busyEng === engId) return;
    const current = data.assignments.filter((a) => a.engagementId === engId).map((a) => a.memberId);
    const next = current.includes(memberId) ? current.filter((m) => m !== memberId) : [...current, memberId];
    setBusyEng(engId);
    setData({
      ...data,
      assignments: [
        ...data.assignments.filter((a) => a.engagementId !== engId),
        ...next.map((m) => ({ engagementId: engId, memberId: m })),
      ],
    });
    api
      .setMembers(engId, next)
      .then(() => onChanged())
      .catch(() => {
        toast('Assignment save failed');
        reload();
      })
      .finally(() => setBusyEng(null));
  };

  const doDelete = (engId: string, name: string) => {
    if (deleting) return;
    setDeleting(true);
    api
      .deleteEngagement(engId)
      .then(() => {
        toast(`${name} deleted`);
        reload();
        onChanged();
      })
      .catch(() => toast('Delete failed'))
      .finally(() => {
        setDeleting(false);
        setConfirmId(null);
      });
  };

  const addMember = () => {
    if (!newName.trim() || !EMAIL_RE.test(newEmail.trim()) || !newRole.trim() || saving) return;
    setSaving(true);
    api
      .addMember(newName.trim(), newEmail.trim(), newRole.trim())
      .then(() => {
        toast(`${newName.trim()} added to the bench`);
        setNewName('');
        setNewEmail('');
        setNewRole('');
        reload();
      })
      .catch(() => toast('Add member failed'))
      .finally(() => setSaving(false));
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--bg)',
    border: '1px solid var(--line2)',
    borderRadius: 3,
    color: 'var(--tx)',
    padding: '7px 9px',
    fontSize: 12.5,
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 40px' }}>
      <button
        className="hv-tx2"
        onClick={goPortfolio}
        style={{ background: 'none', border: 'none', color: 'var(--tx3)', ...mono(400, 11), cursor: 'pointer', padding: 0, marginBottom: 14 }}
      >
        ← PORTFOLIO
      </button>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>Admin</h1>
        <span style={{ ...mono(400, 11), color: 'var(--tx3)' }}>STAFFING · PROJECT LIFECYCLE · MODEL PROVIDERS</span>
      </div>

      {data && <ModelProviders toast={toast} />}

      {!data && !loadError && <div style={{ color: 'var(--tx3)', ...mono(400, 11) }}>LOADING…</div>}
      {loadError && loadError.status === 403 && (
        <div style={{ border: '1px solid var(--bad)', borderRadius: 4, background: 'var(--bg2)', padding: '16px 20px', maxWidth: 520 }}>
          <div style={{ ...mono(500, 10), color: 'var(--bad)', letterSpacing: '.06em', marginBottom: 6 }}>ACCESS DENIED</div>
          <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.5 }}>
            Admin tools require membership in the <span className="mono">eec-admins</span> workspace group.
          </div>
        </div>
      )}
      {loadError && loadError.status !== 403 && (
        <div style={{ border: '1px solid var(--bad)', borderRadius: 4, background: 'var(--bg2)', padding: '16px 20px', maxWidth: 520 }}>
          <div style={{ ...mono(500, 10), color: 'var(--bad)', letterSpacing: '.06em', marginBottom: 6 }}>COULDN’T LOAD ADMIN DATA</div>
          <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.5, marginBottom: 10 }}>{loadError.message}</div>
          <button
            onClick={reload}
            style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '5px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 14, alignItems: 'start' }}>
          {/* projects × members matrix */}
          <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
              TEAM ASSIGNMENT — CLICK A PERSON TO TOGGLE THEM ON A PROJECT
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>PROJECT</th>
                  <th style={thStyle}>TEAM</th>
                  <th style={{ ...thStyle, width: 90, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {data.engagements.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...tdBase, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: HEALTH_COLOR[e.health], flex: 'none' }} />
                        <div>
                          <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>{e.client}</div>
                          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{e.name}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
                        <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.06em' }}>LEADS</span>
                        <input
                          value={leadDrafts[e.id] ?? ''}
                          onChange={(ev) => setLeadDrafts((d) => ({ ...d, [e.id]: ev.target.value }))}
                          onBlur={() => saveLeads(e.id)}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
                          }}
                          placeholder="lead@datavail.com"
                          style={{
                            width: 220,
                            background: 'var(--bg)',
                            border: '1px solid var(--line2)',
                            borderRadius: 3,
                            color: 'var(--tx2)',
                            padding: '3px 7px',
                            fontSize: 11,
                          }}
                        />
                      </div>
                    </td>
                    <td style={tdBase}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {data.members.map((m) => {
                          const on = assigned(e.id, m.id);
                          return (
                            <button
                              key={m.id}
                              className="hv-border"
                              onClick={() => toggleMember(e.id, m.id)}
                              disabled={busyEng === e.id}
                              title={`${m.name} — ${m.role}`}
                              style={{
                                opacity: busyEng === e.id ? 0.6 : 1,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                border: `1px solid ${on ? 'var(--tx3)' : 'var(--line)'}`,
                                background: on ? 'var(--bg3)' : 'transparent',
                                color: on ? 'var(--tx)' : 'var(--tx3)',
                                borderRadius: 3,
                                padding: '3px 8px 3px 4px',
                                fontSize: 11.5,
                                cursor: 'pointer',
                              }}
                            >
                              <span
                                style={{
                                  width: 18,
                                  height: 18,
                                  borderRadius: '50%',
                                  background: on ? 'var(--accsoft)' : 'var(--bg3)',
                                  border: '1px solid var(--line2)',
                                  display: 'grid',
                                  placeItems: 'center',
                                  ...mono(500, 8),
                                  color: on ? 'var(--acc)' : 'var(--tx3)',
                                }}
                              >
                                {initials(m.name)}
                              </span>
                              {m.name}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td style={{ ...tdBase, textAlign: 'right', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                      {confirmId === e.id ? (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button
                            onClick={() => doDelete(e.id, e.name)}
                            disabled={deleting}
                            style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: deleting ? 0.5 : 1 }}
                          >
                            {deleting ? 'Deleting…' : 'Confirm'}
                          </button>
                          <button
                            onClick={() => setConfirmId(null)}
                            style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="hv-bad"
                          onClick={() => setConfirmId(e.id)}
                          style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 10), cursor: 'pointer', letterSpacing: '.06em' }}
                        >
                          DELETE
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* bench + add member */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '14px 16px' }}>
              <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 10 }}>ADD TEAM MEMBER</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" style={inputStyle} />
                <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Workspace email" type="email" style={inputStyle} />
                <input value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="Role — e.g. Data Engineer" style={inputStyle} />
                <button
                  className="hv-bright"
                  onClick={addMember}
                  disabled={!newName.trim() || !EMAIL_RE.test(newEmail.trim()) || !newRole.trim() || saving}
                  style={{
                    background: 'var(--acc)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 3,
                    padding: '7px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: !newName.trim() || !EMAIL_RE.test(newEmail.trim()) || !newRole.trim() || saving ? 0.45 : 1,
                  }}
                >
                  {saving ? 'Adding…' : 'Add to bench'}
                </button>
              </div>
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
                BENCH · {data.members.length} PEOPLE
              </div>
              {data.members.map((m) => {
                const nProjects = data.assignments.filter((a) => a.memberId === m.id).length;
                const loadColor = m.load > 90 ? 'var(--bad)' : m.load > 75 ? 'var(--warn)' : 'var(--ok)';
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'var(--rowpad)', borderBottom: '1px solid var(--line)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{m.name}</div>
                      <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginBottom: 3 }}>{m.role}</div>
                      <input
                        key={m.email ?? ''}
                        defaultValue={m.email ?? ''}
                        placeholder="Workspace email — required for runner access"
                        type="email"
                        onBlur={(event) => {
                          const email = event.currentTarget.value.trim();
                          if (email === (m.email ?? '')) return;
                          if (!EMAIL_RE.test(email)) {
                            toast('Enter a valid workspace email');
                            event.currentTarget.value = m.email ?? '';
                            return;
                          }
                          void api.updateMemberEmail(m.id, email).then(reload).catch((e: Error) => toast(`Email update failed — ${e.message}`));
                        }}
                        style={{ ...inputStyle, padding: '3px 6px', fontSize: 10.5, width: 240 }}
                      />
                    </div>
                    <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
                      {nProjects} {nProjects === 1 ? 'PROJECT' : 'PROJECTS'}
                    </span>
                    <span style={{ ...mono(400, 10), color: loadColor }}>{m.load}%</span>
                    {memberConfirm === m.id ? (
                      <span style={{ display: 'inline-flex', gap: 5 }}>
                        <button
                          onClick={() => deleteMember(m.id, m.name)}
                          disabled={deleting}
                          style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '2px 7px', fontSize: 10.5, fontWeight: 600, cursor: 'pointer', opacity: deleting ? 0.5 : 1 }}
                        >
                          {deleting ? '…' : 'Remove'}
                        </button>
                        <button
                          onClick={() => setMemberConfirm(null)}
                          style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '2px 7px', fontSize: 10.5, cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        className="hv-bad"
                        title={`Remove ${m.name} from the bench`}
                        onClick={() => setMemberConfirm(m.id)}
                        style={{ border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 14, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
