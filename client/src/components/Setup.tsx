import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Phase, Proposal } from '../types';
import { fmtD, mono, pct } from '../util';

const PARSE_LABELS = [
  'Reading the source material',
  'Extracting deliverables and scope',
  'Deriving phase schedule and milestones',
  'Drafting initial ticket set',
];

type PlanMode = 'sow' | 'brief';

export function Setup({
  goPortfolio,
  toast,
  onCreated,
}: {
  goPortfolio: () => void;
  toast: (msg: string) => void;
  onCreated: (id: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [client, setClient] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<PlanMode>('sow');
  const [brief, setBrief] = useState('');
  const [sowFile, setSowFile] = useState<{ path: string; filename: string; size: number } | null>(null);
  const [parseStage, setParseStage] = useState(-1);
  const [parsed, setParsed] = useState(false);
  const [summary, setSummary] = useState('');
  const [phases, setPhases] = useState<Phase[]>([]);
  const [milestones, setMilestones] = useState<{ label: string; d: string }[]>([]);
  const [extractedChars, setExtractedChars] = useState(0);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [creating, setCreating] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stageTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => clearInterval(stageTimer.current), []);

  const basicsOk = client.trim().length > 0 && name.trim().length > 0;
  const briefOk = brief.trim().length >= 30;
  const parsing = parseStage >= 0 && !parsed;

  const runParse = async (input: { path?: string; description?: string }) => {
    setParseError(null);
    setParsed(false);
    setParseStage(0);
    clearInterval(stageTimer.current);
    stageTimer.current = setInterval(() => setParseStage((s) => Math.min(s + 1, PARSE_LABELS.length - 1)), 4000);
    try {
      const plan = await api.parsePlan(input, client.trim(), name.trim());
      clearInterval(stageTimer.current);
      setParseStage(PARSE_LABELS.length);
      setPhases(plan.phases);
      setMilestones(plan.milestones);
      setExtractedChars(plan.extractedChars);
      setProposals(plan.proposals.map((p) => ({ ...p, dec: 'pending' as const })));
      setSummary(
        plan.summary ??
          (plan.phases.length > 0
            ? `Schedule derived: ${fmtD(plan.phases[0].s)} → ${fmtD(plan.phases[plan.phases.length - 1].e)}.`
            : 'Plan derived from the provided material.'),
      );
      setParsed(true);
    } catch (e) {
      clearInterval(stageTimer.current);
      setParseStage(-1);
      setParseError((e as Error).message);
    }
  };

  const handleFile = async (file: File) => {
    setParseError(null);
    setParseStage(0);
    try {
      const uploaded = await api.uploadSow(file);
      setSowFile(uploaded);
      await runParse({ path: uploaded.path });
    } catch (e) {
      setParseStage(-1);
      setParseError(`Upload failed — ${(e as Error).message}`);
    }
  };

  const resetPlan = () => {
    setParsed(false);
    setParseStage(-1);
    setParseError(null);
    setSowFile(null);
    setPhases([]);
    setMilestones([]);
    setProposals([]);
  };

  const nAcc = proposals.filter((p) => p.dec === 'acc').length;

  const createEngagement = async () => {
    if (nAcc === 0 || creating) return;
    setCreating(true);
    try {
      const accepted = proposals.filter((p) => p.dec === 'acc').map(({ title, phase, est, source }) => ({ title, phase, est, source }));
      const { id } = await api.createEngagement({
        client: client.trim(),
        name: name.trim(),
        ...(mode === 'sow' && sowFile ? { sowFile: sowFile.filename } : {}),
        phases,
        milestones,
        proposals: accepted,
      });
      toast(`Engagement created — ${accepted.length} tickets seeded from the ${mode === 'sow' ? 'SOW' : 'brief'}`);
      onCreated(id);
    } catch (e) {
      toast(`Create failed: ${(e as Error).message}`);
      setCreating(false);
    }
  };

  const pS = phases[0]?.s;
  const pE = phases[phases.length - 1]?.e;

  const steps = [
    { n: 1, label: 'Engagement basics' },
    { n: 2, label: 'Plan input' },
    { n: 3, label: 'Review plan' },
  ];

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box' as const,
    background: 'var(--bg2)',
    border: '1px solid var(--line2)',
    borderRadius: 3,
    color: 'var(--tx)',
    padding: '8px 10px',
    fontSize: 13,
  };

  const backBtn = (to: number) => (
    <button
      onClick={() => setStep(to)}
      style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '8px 16px', fontSize: 12.5, cursor: 'pointer' }}
    >
      Back
    </button>
  );

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '26px 24px 60px' }}>
        <button
          className="hv-tx2"
          onClick={goPortfolio}
          style={{ background: 'none', border: 'none', color: 'var(--tx3)', ...mono(400, 11), cursor: 'pointer', padding: 0, marginBottom: 14 }}
        >
          ← PORTFOLIO
        </button>
        <h1 style={{ margin: '0 0 4px', fontSize: 19, fontWeight: 600 }}>New engagement</h1>
        <p style={{ margin: '0 0 22px', color: 'var(--tx2)', fontSize: 12.5 }}>
          Name it, then upload the signed SOW or describe the project — the agent derives phases, dates and the initial ticket set either way.
        </p>
        <div style={{ display: 'flex', gap: 0, marginBottom: 26, border: '1px solid var(--line)', borderRadius: 4, overflow: 'hidden' }}>
          {steps.map((st) => (
            <div
              key={st.n}
              style={{
                flex: 1,
                padding: '10px 14px',
                background: st.n === step ? 'var(--bg3)' : 'var(--bg2)',
                borderRight: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                gap: 9,
              }}
            >
              <span style={{ ...mono(500, 11), color: st.n === step ? 'var(--acc)' : 'var(--tx3)' }}>0{st.n}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: st.n === step ? 'var(--tx)' : 'var(--tx2)' }}>{st.label}</span>
              {st.n < step && <span style={{ marginLeft: 'auto', color: 'var(--ok)', ...mono(500, 11) }}>✓</span>}
            </div>
          ))}
        </div>

        {step === 1 && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
              <div>
                <label style={{ display: 'block', ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>CLIENT</label>
                <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client name" style={inputStyle} />
              </div>
              <div>
                <label style={{ display: 'block', ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>
                  ENGAGEMENT NAME
                </label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Data Platform Modernization" style={inputStyle} />
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginBottom: 22, lineHeight: 1.5 }}>
              Context sources (git repository, documents) connect from the workspace’s Sources tab once the engagement exists.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => basicsOk && setStep(2)}
                disabled={!basicsOk}
                style={{
                  background: 'var(--acc)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 3,
                  padding: '8px 18px',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  opacity: basicsOk ? 1 : 0.45,
                }}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            {!parsing && !parsed && (
              <div style={{ display: 'flex', gap: 0, marginBottom: 16, border: '1px solid var(--line2)', borderRadius: 3, overflow: 'hidden', width: 'fit-content' }}>
                {(
                  [
                    ['sow', 'Upload SOW'],
                    ['brief', 'Describe the project'],
                  ] as [PlanMode, string][]
                ).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => {
                      setMode(m);
                      setParseError(null);
                    }}
                    style={{
                      border: 'none',
                      borderLeft: m === 'brief' ? '1px solid var(--line2)' : 'none',
                      padding: '7px 16px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      background: mode === m ? 'var(--bg3)' : 'transparent',
                      color: mode === m ? 'var(--tx)' : 'var(--tx2)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {parseError && (
              <div style={{ border: '1px solid var(--bad)', borderRadius: 4, background: 'var(--bg2)', padding: '18px 22px', marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ ...mono(500, 10), background: 'var(--accsoft)', color: 'var(--bad)', borderRadius: 2, padding: '2px 7px', letterSpacing: '.06em' }}>
                    ◆ PLAN GENERATION FAILED
                  </span>
                  {mode === 'sow' && sowFile && <span style={{ ...mono(400, 11), color: 'var(--tx2)' }}>{sowFile.filename}</span>}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.5, marginBottom: 12 }}>{parseError}</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  {mode === 'sow' && sowFile && (
                    <button
                      onClick={() => void runParse({ path: sowFile.path })}
                      style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Try again
                    </button>
                  )}
                  {mode === 'brief' && briefOk && (
                    <button
                      onClick={() => void runParse({ description: brief.trim() })}
                      style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Try again
                    </button>
                  )}
                  <button
                    onClick={resetPlan}
                    style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '6px 14px', fontSize: 12, cursor: 'pointer' }}
                  >
                    Start over
                  </button>
                </div>
              </div>
            )}

            {mode === 'sow' && parseStage === -1 && !parseError && (
              <div
                className="hv-border-bg"
                onClick={() => fileInput.current?.click()}
                style={{ border: '1px dashed var(--line2)', borderRadius: 4, padding: '44px 20px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg2)' }}
              >
                <div style={{ ...mono(500, 11), color: 'var(--tx3)', letterSpacing: '.1em', marginBottom: 8 }}>[ SOW / SOP DOCUMENT ]</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Upload the signed SOW</div>
                <div style={{ fontSize: 12, color: 'var(--tx2)' }}>
                  PDF, Word or text. The agent extracts phases, dates, deliverables and drafts the initial ticket set.
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,.md"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                  }}
                />
              </div>
            )}

            {mode === 'brief' && parseStage === -1 && !parseError && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '18px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Describe the engagement</div>
                <div style={{ fontSize: 12, color: 'var(--tx2)', marginBottom: 10, lineHeight: 1.5 }}>
                  Scope, key deliverables, rough timeline, team shape — anything you’d put in a kickoff email. The agent turns it into
                  phases, milestones and draft tickets you review next.
                </div>
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={9}
                  placeholder={`e.g. Migrate the client's on-prem SQL Server estate (~40 databases) to Azure SQL MI over roughly six months starting September. Includes assessment, landing zone, two migration waves, validation and hypercare. Team of four. Weekly status to the client's IT director.`}
                  style={{ ...inputStyle, background: 'var(--bg)', resize: 'vertical', lineHeight: 1.55 }}
                />
                <div style={{ display: 'flex', alignItems: 'center', marginTop: 10 }}>
                  <span style={{ ...mono(400, 10), color: briefOk ? 'var(--tx3)' : 'var(--warn)' }}>
                    {briefOk ? `${brief.trim().length} CHARS` : 'ADD A FEW MORE SENTENCES (MIN 30 CHARS)'}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => briefOk && void runParse({ description: brief.trim() })}
                    disabled={!briefOk}
                    style={{
                      background: 'var(--acc)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 3,
                      padding: '8px 18px',
                      fontSize: 12.5,
                      fontWeight: 600,
                      cursor: 'pointer',
                      opacity: briefOk ? 1 : 0.45,
                    }}
                  >
                    Generate plan
                  </button>
                </div>
              </div>
            )}

            {parsing && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '22px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                  <span style={{ ...mono(500, 11), color: 'var(--tx2)' }}>
                    {mode === 'sow' ? (sowFile?.filename ?? 'Uploading…') : 'Project brief'}
                  </span>
                  {mode === 'sow' && sowFile && (
                    <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{(sowFile.size / 1024 / 1024).toFixed(1)} MB</span>
                  )}
                </div>
                {PARSE_LABELS.map((l, i) => (
                  <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 12.5, color: i < parseStage ? 'var(--ok)' : i === parseStage ? 'var(--tx)' : 'var(--tx3)' }}>
                    <span style={{ ...mono(500, 11), width: 14 }}>{i < parseStage ? '✓' : i === parseStage ? '▸' : '·'}</span>
                    {l}
                  </div>
                ))}
              </div>
            )}

            {parsed && (
              <>
                <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '20px 24px', marginBottom: 18 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <span style={{ ...mono(500, 10), background: 'var(--agentsoft)', color: 'var(--agent)', borderRadius: 2, padding: '2px 7px', letterSpacing: '.06em' }}>◆ AGENT</span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {mode === 'sow' ? `Extracted from ${sowFile?.filename}` : 'Derived from your project brief'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
                    {[
                      { v: String(phases.length), k: 'PHASES' },
                      { v: String(milestones.length), k: 'MILESTONES' },
                      { v: String(proposals.length), k: 'DRAFT TICKETS' },
                      {
                        v: extractedChars > 0 ? `${(extractedChars / 1000).toFixed(1)}K` : '—',
                        k: mode === 'sow' ? (extractedChars > 0 ? 'CHARS EXTRACTED' : 'BODY NOT READABLE') : 'BRIEF CHARS',
                      },
                    ].map((st) => (
                      <div key={st.k} style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '11px 13px', background: 'var(--bg)' }}>
                        <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.02em' }}>{st.v}</div>
                        <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em', marginTop: 2 }}>{st.k}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 14, fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>{summary}</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button
                    onClick={resetPlan}
                    style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '8px 16px', fontSize: 12.5, cursor: 'pointer' }}
                  >
                    Start over
                  </button>
                  <button
                    className="hv-bright"
                    onClick={() => setStep(3)}
                    style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '8px 18px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                  >
                    Review proposed plan
                  </button>
                </div>
              </>
            )}

            {!parsing && !parsed && (
              <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 16 }}>{backBtn(1)}</div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Proposed plan</span>
              <span style={{ ...mono(400, 11), color: 'var(--tx3)' }}>
                {nAcc} OF {proposals.length} ACCEPTED
              </span>
              <div style={{ flex: 1 }} />
              <button
                className="hv-bg"
                onClick={() => setProposals((ps) => ps.map((p) => (p.dec === 'dis' ? p : { ...p, dec: 'acc' })))}
                style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '5px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
              >
                Accept all
              </button>
            </div>
            {pS && pE && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '16px 18px', marginBottom: 14 }}>
                <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 10 }}>
                  DERIVED ROADMAP · {fmtD(pS)} – {fmtD(pE)}
                </div>
                {phases.map((p, i) => {
                  const l = pct(pS, pE, p.s);
                  const w = pct(pS, pE, p.e) - l;
                  return (
                    <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 7 }}>
                      <span style={{ width: 150, fontSize: 11.5, color: 'var(--tx2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                      <div style={{ flex: 1, height: 14, position: 'relative', background: 'var(--bg)', borderRadius: 2 }}>
                        <div style={{ position: 'absolute', top: 2, bottom: 2, left: `${l}%`, width: `${w}%`, background: i === 0 ? 'var(--acc)' : 'var(--line2)', borderRadius: 2 }} />
                      </div>
                      <span style={{ ...mono(400, 10), color: 'var(--tx3)', width: 110, textAlign: 'right' }}>
                        {fmtD(p.s)} – {fmtD(p.e)}
                      </span>
                    </div>
                  );
                })}
                {milestones.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                    <span style={{ width: 150, ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>MILESTONES</span>
                    <div style={{ flex: 1, height: 48, position: 'relative' }}>
                      {milestones.map((ms, i) => {
                        const p = Math.max(1, Math.min(99, pct(pS, pE, ms.d)));
                        const nearRight = p > 90;
                        const nearLeft = p < 5;
                        return (
                          <div
                            key={ms.label + ms.d}
                            title={`${ms.label} · ${fmtD(ms.d)}`}
                            style={{
                              position: 'absolute',
                              left: `${p}%`,
                              top: i % 2 === 0 ? 0 : 24,
                              transform: nearRight ? 'translateX(-100%)' : nearLeft ? 'none' : 'translateX(-50%)',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: nearRight ? 'flex-end' : nearLeft ? 'flex-start' : 'center',
                              gap: 3,
                            }}
                          >
                            <div style={{ width: 8, height: 8, flex: 'none', transform: 'rotate(45deg)', background: 'var(--bg2)', border: '1.5px solid var(--tx3)' }} />
                            <div style={{ ...mono(400, 9), color: 'var(--tx3)', whiteSpace: 'nowrap' }}>{fmtD(ms.d)}</div>
                          </div>
                        );
                      })}
                    </div>
                    <span style={{ width: 110 }} />
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: 4, overflow: 'hidden', marginBottom: 18 }}>
              {proposals.map((p, i) => (
                <div
                  key={`${p.source}|${p.title}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'var(--rowpad)', background: 'var(--bg2)', borderBottom: '1px solid var(--line)', opacity: p.dec === 'dis' ? 0.45 : 1 }}
                >
                  <span style={{ ...mono(500, 10), background: 'var(--agentsoft)', color: 'var(--agent)', borderRadius: 2, padding: '2px 6px' }}>◆</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, textDecoration: p.dec === 'dis' ? 'line-through' : 'none' }}>{p.title}</div>
                    <div style={{ display: 'flex', gap: 8, ...mono(400, 10), color: 'var(--tx3)', marginTop: 2 }}>
                      <span>{p.phase}</span>
                      <span>·</span>
                      <span>{p.est}</span>
                      <span>·</span>
                      <span style={{ color: 'var(--agent)' }}>{p.source}</span>
                    </div>
                  </div>
                  {p.dec === 'pending' && (
                    <>
                      <button
                        onClick={() => setProposals((ps) => ps.map((x, xi) => (xi === i ? { ...x, dec: 'acc' } : x)))}
                        style={{ border: '1px solid var(--ok)', background: 'none', color: 'var(--ok)', borderRadius: 3, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => setProposals((ps) => ps.map((x, xi) => (xi === i ? { ...x, dec: 'dis' } : x)))}
                        style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                  {p.dec === 'acc' && (
                    <button
                      onClick={() => setProposals((ps) => ps.map((x, xi) => (xi === i ? { ...x, dec: 'pending' } : x)))}
                      title="Click to undo"
                      style={{ border: 'none', background: 'none', ...mono(500, 10), color: 'var(--ok)', cursor: 'pointer', padding: 0 }}
                    >
                      ✓ ACCEPTED
                    </button>
                  )}
                  {p.dec === 'dis' && (
                    <button
                      onClick={() => setProposals((ps) => ps.map((x, xi) => (xi === i ? { ...x, dec: 'pending' } : x)))}
                      title="Click to undo"
                      style={{ border: 'none', background: 'none', ...mono(500, 10), color: 'var(--tx3)', cursor: 'pointer', padding: 0 }}
                    >
                      DISMISSED
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              {backBtn(2)}
              <button
                onClick={() => void createEngagement()}
                disabled={nAcc === 0 || creating}
                style={{
                  background: 'var(--acc)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 3,
                  padding: '8px 18px',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  opacity: nAcc === 0 || creating ? 0.45 : 1,
                }}
              >
                {creating ? 'Creating…' : 'Create engagement'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
