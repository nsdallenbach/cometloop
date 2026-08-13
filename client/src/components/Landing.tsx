/* eslint-disable react/no-array-index-key -- static decorative lists, never reordered */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type CSSProperties, type RefObject } from 'react';
import { motion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { animate, stagger } from 'animejs';
import { mono } from '../util';

/* ------------------------------------------------------------------ helpers */

// The page scrolls inside its own container (the app shell is overflow:hidden),
// so every scroll trigger must observe against that element, not the window.
const ScrollRoot = createContext<RefObject<HTMLElement | null> | null>(null);

/** Reveal children on scroll-in with a spring rise; runs once. */
function Reveal({ children, delay = 0, y = 26, style }: { children: ReactNode; delay?: number; y?: number; style?: CSSProperties }) {
  const root = useContext(ScrollRoot);
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px', root: root ?? undefined }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      style={style}
    >
      {children}
    </motion.div>
  );
}

/** Count a number up from 0 → value the first time it scrolls into view (anime.js). */
function CountUp({ value, suffix = '', prefix = '', decimals = 0 }: { value: number; suffix?: string; prefix?: string; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const root = useContext(ScrollRoot);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obj = { n: 0 };
    let done = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !done) {
          done = true;
          animate(obj, {
            n: value,
            duration: 1600,
            ease: 'out(3)',
            onUpdate: () => {
              if (ref.current) ref.current.textContent = `${prefix}${obj.n.toFixed(decimals)}${suffix}`;
            },
          });
        }
      },
      { threshold: 0.4, root: root?.current ?? null },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value, suffix, prefix, decimals, root]);
  return <span ref={ref}>{`${prefix}0${suffix}`}</span>;
}

const chip = (bg: string, color: string): CSSProperties => ({
  ...mono(600, 9.5),
  background: bg,
  color,
  borderRadius: 3,
  padding: '2px 7px',
  letterSpacing: '.06em',
  whiteSpace: 'nowrap',
});

const glass: CSSProperties = {
  background: 'color-mix(in srgb, var(--bg2) 82%, transparent)',
  border: '1px solid var(--line2)',
  borderRadius: 12,
  backdropFilter: 'blur(10px)',
};

/* ------------------------------------------------------------------- pieces */

/** Floating gradient orbs + grid — the hero's living backdrop. */
function HeroBackdrop({ y }: { y: MotionValue<number> }) {
  return (
    <motion.div style={{ position: 'absolute', inset: 0, overflow: 'hidden', y }} aria-hidden>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)',
          backgroundSize: '46px 46px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 30%, #000 30%, transparent 75%)',
          opacity: 0.4,
        }}
      />
      {[
        { c: 'rgba(255,54,33,0.28)', size: 460, top: '-140px', left: '8%', dur: 13 },
        { c: 'rgba(122,143,245,0.30)', size: 520, top: '40px', right: '4%', dur: 17 },
        { c: 'rgba(55,181,122,0.18)', size: 380, top: '260px', left: '38%', dur: 15 },
      ].map((o, i) => (
        <motion.div
          key={i}
          animate={{ y: [0, -26, 0], x: [0, 16, 0], scale: [1, 1.08, 1] }}
          transition={{ duration: o.dur, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            top: o.top,
            left: o.left,
            right: o.right,
            width: o.size,
            height: o.size,
            background: o.c,
            borderRadius: '50%',
            filter: 'blur(90px)',
          }}
        />
      ))}
    </motion.div>
  );
}

const HERO_LINES = ['Tickets that', 'work themselves.'];

/** Hero headline: word-by-word stagger via anime.js on mount. */
function HeroHeadline() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    animate(ref.current.querySelectorAll('.wd'), {
      opacity: [0, 1],
      y: [28, 0],
      filter: ['blur(8px)', 'blur(0px)'],
      delay: stagger(70, { start: 150 }),
      duration: 800,
      ease: 'out(3)',
    });
  }, []);
  return (
    <h1
      ref={ref}
      style={{
        margin: 0,
        fontSize: 'clamp(40px, 6.5vw, 82px)',
        fontWeight: 700,
        lineHeight: 1.02,
        letterSpacing: '-0.03em',
      }}
    >
      {HERO_LINES.map((line, li) => (
        <span key={li} style={{ display: 'block' }}>
          {line.split(' ').map((w, wi) => (
            <span key={wi} className="wd" style={{ display: 'inline-block', opacity: 0, marginRight: '0.24em', ...(li === 1 ? { color: 'var(--acc)' } : {}) }}>
              {w}
            </span>
          ))}
        </span>
      ))}
    </h1>
  );
}

const STATES: { label: string; color: string; note: string }[] = [
  { label: 'BACKLOG', color: 'var(--tx3)', note: 'Waiting to be deployed' },
  { label: '◇ QUEUED', color: 'var(--agent)', note: '#1 in the agent queue' },
  { label: '◆ CLAIMED', color: 'var(--agent)', note: 'devbox-1 picked it up' },
  { label: '◆ WORKING', color: 'var(--agent)', note: 'Editing TicketDrawer.tsx…' },
  { label: '◆ READY FOR REVIEW', color: 'var(--warn)', note: 'PR opened · awaiting sign-off' },
  { label: '✓ DONE', color: 'var(--ok)', note: 'Merged · deployed' },
];

/** A ticket card that cycles the real board's agent states, forever. */
function LiveTicket() {
  const [i, setI] = useState(0);
  const root = useContext(ScrollRoot);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % STATES.length), 1900);
    return () => clearInterval(t);
  }, []);
  const s = STATES[i];
  const working = s.label.includes('WORKING') || s.label.includes('CLAIMED');
  const border = i === 5 ? 'var(--ok)' : i === 4 ? 'var(--warn)' : working ? 'var(--agent)' : 'var(--line2)';
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, rotateX: 8 }}
      whileInView={{ opacity: 1, scale: 1, rotateX: 0 }}
      viewport={{ once: true, root: root ?? undefined }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      style={{ ...glass, width: 300, maxWidth: '100%', padding: 16, border: `1px solid ${border}`, boxShadow: `0 20px 60px -20px ${border}`, transition: 'border-color .5s, box-shadow .5s' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)' }}>NAC-104</span>
        <motion.span
          key={s.label}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            ...mono(600, 9),
            marginLeft: 'auto',
            color: working ? '#fff' : s.color,
            background: working ? 'var(--agent)' : 'transparent',
            border: working ? 'none' : `1px solid ${s.color}`,
            borderRadius: 3,
            padding: '2px 6px',
            ...(working ? { animation: 'eec-pulse 2s infinite' } : {}),
          }}
        >
          {s.label}
        </motion.span>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, marginBottom: 10 }}>Add retry with backoff to the ingestion client</div>
      <motion.div key={s.note} initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ fontSize: 11.5, color: 'var(--tx2)', minHeight: 16 }}>
        {s.note}
      </motion.div>
      <div style={{ display: 'flex', gap: 4, marginTop: 12 }}>
        {STATES.map((_, j) => (
          <div key={j} style={{ flex: 1, height: 3, borderRadius: 2, background: j <= i ? border : 'var(--line)', transition: 'background .4s' }} />
        ))}
      </div>
    </motion.div>
  );
}

/** The autonomous delivery loop, drawn as an animated SVG ring of stages. */
function LoopDiagram() {
  const ref = useRef<SVGSVGElement>(null);
  const root = useContext(ScrollRoot);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0].isIntersecting) {
          animate(el.querySelectorAll('.loop-path'), { strokeDashoffset: [1000, 0], duration: 2200, ease: 'inOut(3)' });
          animate(el.querySelectorAll('.loop-node'), { opacity: [0, 1], scale: [0.4, 1], delay: stagger(180, { start: 400 }), duration: 600, ease: 'out(3)' });
          io.disconnect();
        }
      },
      { threshold: 0.3, root: root?.current ?? null },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  const nodes = [
    { x: 90, y: 40, label: 'QUEUE', c: 'var(--tx2)' },
    { x: 310, y: 40, label: 'CLAIM', c: 'var(--agent)' },
    { x: 420, y: 150, label: 'BUILD', c: 'var(--agent)' },
    { x: 310, y: 260, label: 'PR', c: 'var(--warn)' },
    { x: 90, y: 260, label: 'REVIEW', c: 'var(--warn)' },
    { x: -20, y: 150, label: 'DEPLOY', c: 'var(--ok)' },
  ];
  return (
    <svg ref={ref} viewBox="-70 0 560 300" style={{ width: '100%', maxWidth: 560 }}>
      <path
        className="loop-path"
        d="M90,40 H310 L420,150 L310,260 H90 L-20,150 Z"
        fill="none"
        stroke="url(#loopgrad)"
        strokeWidth={1.5}
        strokeDasharray={1000}
        strokeDashoffset={1000}
      />
      <defs>
        <linearGradient id="loopgrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--agent)" />
          <stop offset="100%" stopColor="var(--acc)" />
        </linearGradient>
      </defs>
      {nodes.map((n) => (
        <g key={n.label} className="loop-node" style={{ opacity: 0 }}>
          <circle cx={n.x} cy={n.y} r={5} fill={n.c} />
          <circle cx={n.x} cy={n.y} r={11} fill="none" stroke={n.c} strokeWidth={1} opacity={0.4} />
          <text x={n.x} y={n.y - 20} textAnchor="middle" style={{ ...mono(600, 10), fill: n.c, letterSpacing: '0.08em' }}>
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Two agents exchanging messages — the coordination channel, animated. */
function CoordShowcase() {
  const msgs = [
    { from: 'devbox-1', to: 'devbox-2', type: 'ASKS', color: 'var(--link)', text: 'Touching TicketDrawer.tsx on NAC-110?' },
    { from: 'devbox-2', to: 'devbox-1', type: 'REPLIES', color: 'var(--ok)', text: 'No — only the server. You’re clear.' },
    { from: 'devbox-1', to: null, type: 'CONFLICT', color: 'var(--warn)', text: 'Heads-up: NAC-104 and NAC-110 both merge this hour.' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {msgs.map((m, i) => (
        <Reveal key={i} delay={i * 0.18}>
          <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', ...glass, borderLeft: '3px solid var(--agent)', padding: '9px 12px', borderRadius: 8 }}>
            <span style={{ flex: 'none', width: 22, height: 22, borderRadius: '50%', background: 'var(--agentsoft)', border: '1px solid var(--agent)', display: 'grid', placeItems: 'center', ...mono(600, 10), color: 'var(--agent)' }}>◆</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3, flexWrap: 'wrap' }}>
                <span style={{ ...mono(600, 10.5), color: 'var(--agent)' }}>{m.from}</span>
                <span style={{ ...chip('#fff', '#000'), background: m.color, color: '#fff' }}>{m.type}</span>
                {m.to ? <span style={chip('var(--agentsoft)', 'var(--agent)')}>→ @{m.to}</span> : <span style={{ ...mono(500, 9), color: 'var(--tx3)', border: '1px solid var(--line2)', borderRadius: 3, padding: '0 5px' }}>BROADCAST</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.45 }}>{m.text}</div>
            </div>
          </div>
        </Reveal>
      ))}
    </div>
  );
}

/** Shared scroll-in trigger for the anime.js visuals: fires once, inside the page's own scroller. */
function useEnterOnce(ref: RefObject<Element | null>, run: (el: Element) => void, threshold = 0.35) {
  const root = useContext(ScrollRoot);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (e) => {
        if (e[0].isIntersecting) {
          run(el);
          io.disconnect();
        }
      },
      { threshold, root: root?.current ?? null },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run is a stable inline callback; re-observing on identity change would replay the animation
  }, [ref, root, threshold]);
}

const VELOCITY_WEEKS = [34, 41, 38, 55, 49, 68, 62, 84];

/** Weekly delivery bars — the Analytics velocity headline, in miniature. */
function VelocityBars() {
  const ref = useRef<HTMLDivElement>(null);
  useEnterOnce(ref, (el) => {
    animate(el.querySelectorAll('.vbar'), { scaleY: [0, 1], delay: stagger(80, { start: 120 }), duration: 700, ease: 'out(3)' });
  });
  return (
    <div ref={ref} style={{ ...glass, padding: 18, borderRadius: 12, width: '100%', maxWidth: 400 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>DELIVERED · TICKETS PER WEEK</span>
        <span style={{ ...chip('transparent', 'var(--ok)'), marginLeft: 'auto', border: '1px solid var(--ok)' }}>▲ WEEK OVER WEEK</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 104, marginTop: 14 }}>
        {VELOCITY_WEEKS.map((h, i) => {
          const last = i === VELOCITY_WEEKS.length - 1;
          return (
            <div
              key={i}
              className="vbar"
              style={{
                flex: 1,
                height: `${h}%`,
                borderRadius: '3px 3px 0 0',
                background: last ? 'var(--acc)' : 'var(--agentsoft)',
                border: `1px solid ${last ? 'var(--acc)' : 'var(--agent)'}`,
                transform: 'scaleY(0)',
                transformOrigin: 'bottom',
              }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        {[
          { label: 'IDEA → DONE', v: 31, s: 'h' },
          { label: 'IN REVIEW', v: 6, s: 'h' },
        ].map((k) => (
          <div key={k.label}>
            <div style={{ ...mono(700, 18), color: 'var(--tx)' }}>
              <CountUp value={k.v} suffix={k.s} />
            </div>
            <div style={{ ...mono(500, 9.5), color: 'var(--tx3)', letterSpacing: '.08em', marginTop: 2 }}>{k.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Widths are the hours to scale (6h = full track), so the gap between what a
// developer would have spent and what the run actually cost is the picture.
const ESTIMATE_ROWS = [
  { label: 'HUMAN EST', w: 100, c: 'var(--tx3)', v: '6h' },
  { label: 'AGENT EST', w: 7, c: 'var(--agent)', v: '0.4h' },
  { label: 'ACTUAL', w: 9, c: 'var(--ok)', v: '0.5h' },
];

/** Estimate vs actual, drawn as tracks that fill on scroll-in. */
function EstimateTracks() {
  const ref = useRef<HTMLDivElement>(null);
  useEnterOnce(ref, (el) => {
    animate(el.querySelectorAll('.etrack'), { scaleX: [0, 1], delay: stagger(130, { start: 150 }), duration: 800, ease: 'out(3)' });
  });
  return (
    <div ref={ref} style={{ ...glass, padding: 18, borderRadius: 12, width: '100%', maxWidth: 400 }}>
      <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginBottom: 14 }}>NAC-104 · HOURS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {ESTIMATE_ROWS.map((r) => (
          <div key={r.label}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
              <span style={{ ...mono(500, 9.5), color: 'var(--tx3)', letterSpacing: '.08em' }}>{r.label}</span>
              <span style={{ ...mono(600, 11), color: r.c, marginLeft: 'auto' }}>{r.v}</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden' }}>
              <div className="etrack" style={{ width: `${r.w}%`, height: '100%', borderRadius: 3, background: r.c, transform: 'scaleX(0)', transformOrigin: 'left' }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 14, lineHeight: 1.45 }}>
        Calibrated per engagement from the tickets that already closed.
      </div>
    </div>
  );
}

const REVIEW_STEPS = [
  { when: 'PR OPENED', color: 'var(--agent)', text: 'The reviewer agent reads the diff and posts its findings on the PR.' },
  { when: '+24H', color: 'var(--warn)', text: 'Still unreviewed — the engagement lead gets pinged in the notification centre.' },
  { when: '+48H', color: 'var(--bad)', text: 'The console comments on the PR and flags the ticket on the board.' },
];

/** The review SLA, as a vertical clock — same reveal cadence as the coordination feed. */
function ReviewClock() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 400 }}>
      {REVIEW_STEPS.map((s, i) => (
        <Reveal key={s.when} delay={i * 0.18}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', ...glass, borderLeft: `3px solid ${s.color}`, padding: '10px 12px', borderRadius: 8 }}>
            <span style={{ ...chip('transparent', s.color), border: `1px solid ${s.color}`, flex: 'none', marginTop: 1 }}>{s.when}</span>
            <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.45, minWidth: 0 }}>{s.text}</div>
          </div>
        </Reveal>
      ))}
      <Reveal delay={0.54}>
        <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em', paddingLeft: 2 }}>
          REVIEW · MERGE · DISMISS — ANY OF THEM STOPS THE CLOCK
        </div>
      </Reveal>
    </div>
  );
}

const HARNESSES = [
  { env: 'claude', label: 'Claude Code', cmd: 'claude -p --output-format stream-json', c: 'var(--acc)' },
  { env: 'codex', label: 'OpenAI Codex', cmd: 'codex exec --json', c: 'var(--agent)' },
  { env: 'generic', label: 'Any CLI agent', cmd: '$AGENT_BIN $AGENT_ARGS < prompt', c: 'var(--ok)' },
];

/** The runner swapping coding agents — one env var, same delivery loop. */
function HarnessSwitch() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % HARNESSES.length), 2400);
    return () => clearInterval(t);
  }, []);
  const h = HARNESSES[i];
  return (
    <div style={{ ...glass, padding: 18, borderRadius: 12, width: '100%', maxWidth: 400, fontFamily: "'DM Mono', monospace", fontSize: 11.5 }}>
      <div style={{ color: 'var(--tx3)' }}>
        $ HARNESS=
        <motion.span key={h.env} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} style={{ color: h.c, fontWeight: 600 }}>
          {h.env}
        </motion.span>{' '}
        node runner.mjs
      </div>
      <motion.div key={`${h.env}-cmd`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} style={{ color: 'var(--tx2)', marginTop: 8, minHeight: 32 }}>
        <div style={{ color: 'var(--ok)' }}>✓ {h.label} attached</div>
        <div style={{ marginTop: 4 }}>&gt; {h.cmd}</div>
      </motion.div>
      <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 10, color: 'var(--tx3)' }}>
        wait → claim → work → PR → complete
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 10 }}>
        {HARNESSES.map((x, j) => (
          <div key={x.env} style={{ flex: 1, height: 3, borderRadius: 2, background: j === i ? h.c : 'var(--line)', transition: 'background .4s' }} />
        ))}
      </div>
    </div>
  );
}

/** The agent map: runners and serving endpoints wired to the console. */
function FleetMap() {
  const ref = useRef<SVGSVGElement>(null);
  useEnterOnce(
    ref,
    (el) => {
      animate(el.querySelectorAll('.fm-link'), { strokeDashoffset: [220, 0], duration: 1400, ease: 'inOut(3)' });
      animate(el.querySelectorAll('.fm-node'), { opacity: [0, 1], scale: [0.5, 1], delay: stagger(120, { start: 300 }), duration: 600, ease: 'out(3)' });
    },
    0.3,
  );
  const left = [
    { y: 34, label: 'devbox-1', c: 'var(--agent)' },
    { y: 100, label: 'devbox-2', c: 'var(--agent)' },
    { y: 166, label: 'codex-1', c: 'var(--agent)' },
  ];
  const right = [
    { y: 60, label: 'claude-sonnet-5', c: 'var(--acc)' },
    { y: 140, label: 'pr-reviewer', c: 'var(--warn)' },
  ];
  return (
    <svg ref={ref} viewBox="0 0 420 210" style={{ width: '100%', maxWidth: 420 }}>
      {[...left.map((n) => ({ from: [96, n.y], to: [188, 100] })), ...right.map((n) => ({ from: [232, 100], to: [312, n.y] }))].map((l, i) => (
        <path
          key={i}
          className="fm-link"
          d={`M${l.from[0]},${l.from[1]} C${(l.from[0] + l.to[0]) / 2},${l.from[1]} ${(l.from[0] + l.to[0]) / 2},${l.to[1]} ${l.to[0]},${l.to[1]}`}
          fill="none"
          stroke="var(--line2)"
          strokeWidth={1}
          strokeDasharray={220}
          strokeDashoffset={220}
        />
      ))}
      <g className="fm-node" style={{ opacity: 0 }}>
        <rect x={188} y={82} width={44} height={36} rx={6} fill="var(--bg2)" stroke="var(--acc)" strokeWidth={1} />
        <text x={210} y={104} textAnchor="middle" style={{ ...mono(600, 9), fill: 'var(--acc)', letterSpacing: '.06em' }}>
          CONSOLE
        </text>
      </g>
      {left.map((n) => (
        <g key={n.label} className="fm-node" style={{ opacity: 0 }}>
          <circle cx={78} cy={n.y} r={6} fill={n.c} />
          <circle cx={78} cy={n.y} r={12} fill="none" stroke={n.c} strokeWidth={1} opacity={0.4} />
          <text x={62} y={n.y + 3.5} textAnchor="end" style={{ ...mono(500, 9.5), fill: 'var(--tx2)' }}>
            {n.label}
          </text>
        </g>
      ))}
      {right.map((n) => (
        <g key={n.label} className="fm-node" style={{ opacity: 0 }}>
          <rect x={312} y={n.y - 9} width={18} height={18} rx={4} fill="none" stroke={n.c} strokeWidth={1.2} />
          <circle cx={321} cy={n.y} r={3.5} fill={n.c} />
          <text x={338} y={n.y + 3.5} style={{ ...mono(500, 9.5), fill: 'var(--tx2)' }}>
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ feature data */

interface Feature {
  kicker: string;
  title: string;
  body: string;
  points: string[];
  accent: string;
  visual: ReactNode;
}

/* ------------------------------------------------------------------- page */

export function Landing({ theme, onEnter }: { theme: 'dark' | 'light'; onEnter: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ container: scrollRef });
  const heroY = useTransform(scrollYProgress, [0, 0.25], [0, 120]);

  const features: Feature[] = [
    {
      kicker: 'PLAN',
      title: 'One sentence in. A delivery plan out.',
      body: 'Type a request into the chatbox and the planning model on Databricks turns it into a real ticket — Context, Approach, Dependencies, and testable acceptance criteria — with your words kept verbatim underneath.',
      points: [
        'Databricks model serving',
        'Markdown descriptions & comments',
        'Mermaid diagrams drawn into the plan, in console colors',
        'Comments re-plan the ticket before an agent starts',
      ],
      accent: 'var(--acc)',
      visual: (
        <div style={{ ...glass, padding: 18, borderRadius: 12, width: '100%', maxWidth: 400 }}>
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginBottom: 8 }}>YOU TYPE</div>
          <div style={{ fontSize: 13, color: 'var(--tx2)', marginBottom: 14, fontStyle: 'italic' }}>“ticket creation should estimate the timeframe based on actual LLM hours”</div>
          <div style={{ ...mono(400, 10), color: 'var(--agent)', marginBottom: 6 }}>◆ THE CONSOLE PLANS</div>
          {['## Context', '## Approach', '## Dependencies', '✓ 4 acceptance criteria'].map((t, i) => (
            <motion.div key={t} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.12 }} style={{ ...mono(500, 11), color: i === 3 ? 'var(--ok)' : 'var(--tx)', padding: '3px 0' }}>
              {t}
            </motion.div>
          ))}
        </div>
      ),
    },
    {
      kicker: 'ESTIMATES',
      title: 'Two clocks on every ticket.',
      body: 'Nothing reaches the board without an estimate. The planning agent sizes the work twice — the hours an agent will take, and the hours it would have cost a developer — and the console keeps score against what actually happened, calibrating the next estimate from this engagement’s own closed tickets.',
      points: ['Agent and human hours, required on every create path', 'Calibration learned per engagement from actuals', 'Human dev time saved, measured not claimed', 'Content-based backfill for tickets written before the rule'],
      accent: 'var(--ok)',
      visual: <EstimateTracks />,
    },
    {
      kicker: 'DEPLOY TO AGENT',
      title: 'Drag a ticket. Walk away.',
      body: 'The board has a Deploy-to-Agent lane. Drop a ticket in and an autonomous runner claims it, works it with Claude Code, and reports back live — while you watch the card move through every state on its own.',
      points: ['Atomic claiming across a runner fleet', 'Live progress, tool calls & heartbeats on the card', 'Drag to reprioritize · drag out to recall', 'Spring-animated board (Motion layout)'],
      accent: 'var(--agent)',
      visual: <LiveTicket />,
    },
    {
      kicker: 'BRING YOUR OWN AGENT',
      title: 'Claude Code today. Whatever ships next, tomorrow.',
      body: 'The runner core — wait, claim, work, PR, complete — is harness-agnostic. A harness adapter is one entry describing how to launch a coding agent, how to read its output into the live feed, and how to wire the MCP server into its workdir. Claude Code and Codex ship in the box; a generic adapter takes anything else.',
      points: ['One env var swaps the coding agent', 'Streaming output normalised into one tool-call feed', 'MCP wired per harness, or not at all', 'Adding a harness changes no runner logic'],
      accent: 'var(--acc)',
      visual: <HarnessSwitch />,
    },
    {
      kicker: 'AUTONOMOUS DELIVERY',
      title: 'From queue to production, hands-off.',
      body: 'Runners long-poll for work, clone the repo with a short-lived credential, hand the ticket to Claude Code, open a PR, and settle the ticket in Review. You merge; CI deploys; the ticket moves to Done — automatically.',
      points: ['~2s pickup latency, outbound-only', 'Server-rendered prompts ship with deploys', 'PRs auto-link to tickets by key', 'One merge = one deploy'],
      accent: 'var(--ok)',
      visual: (
        <div style={{ display: 'grid', placeItems: 'center', width: '100%' }}>
          <LoopDiagram />
        </div>
      ),
    },
    {
      kicker: 'REVIEW ON A CLOCK',
      title: 'A PR nobody reads is a PR nobody ships.',
      body: 'Agents stop at the pull request — humans merge, always. So the console guards the gap: a reviewer agent registered in Agent Bricks reads the diff and comments first, and an SLA watch escalates anything left sitting. Merge conflicts get the same treatment — trivial ones auto-resolve, anything overlapping another ticket’s open PR is escalated to the people who own it.',
      points: ['Agent Bricks PR reviewer on the gate', '24h lead ping · 48h PR comment and board flag', 'Escalates exactly once, and a dismissal resets the clock', 'Conflict reports name the overlapping PRs and tickets'],
      accent: 'var(--warn)',
      visual: <ReviewClock />,
    },
    {
      kicker: 'AGENTS THAT TALK',
      title: 'A fleet that coordinates itself.',
      body: 'Multiple runners share a Lakebase-backed channel. They announce branches, warn about conflicts, ask each other questions and hand work off — and every message is mirrored onto the tickets and the status feed, styled so you can follow along.',
      points: ['Identity-verified — no spoofing', 'Branch-takeover protection', 'Mirrored to tickets & the feed', 'Six message types with SLAs'],
      accent: 'var(--agent)',
      visual: <CoordShowcase />,
    },
    {
      kicker: 'THE FLEET, MAPPED',
      title: 'Every agent on one architecture diagram.',
      body: 'The Agents page draws the whole delivery estate — runners observed from real task history, model-serving endpoints and Agent Bricks agents registered against the project, and the console in the middle. Click any node for what it is, what it has worked, and when it was last seen.',
      points: ['Runners derived from actual claims, not a config file', 'Serving endpoints and Agent Bricks agents as first-class nodes', 'Spacing that scales with the size of the fleet', 'Click-through detail on every node'],
      accent: 'var(--agent)',
      visual: (
        <div style={{ display: 'grid', placeItems: 'center', width: '100%' }}>
          <FleetMap />
        </div>
      ),
    },
    {
      kicker: 'MEASURED DELIVERY',
      title: 'Velocity, in hours you can defend.',
      body: 'Analytics leads with org velocity: idea → done, cycle time, how long work waits in review, and the human dev time the agents gave back. Underneath sit the delivered chart, backlog trajectory, and a commit-activity graph over the last 26 weeks — all built from the event trail, not from anyone’s memory.',
      points: ['Lead, cycle and decision time with week-over-week movement', 'Where work waits, stage by stage', 'Agent hours derived from real activity', '26-week commit activity graph'],
      accent: 'var(--ok)',
      visual: <VelocityBars />,
    },
    {
      kicker: 'SECURE BY DESIGN',
      title: 'No secrets sitting around.',
      body: 'Repository access runs through a GitHub App: the console holds one private key and mints short-lived installation tokens on demand. Runners never store credentials — they’re vended per task and expire within the hour.',
      points: ['Zero long-lived tokens at rest', 'Per-task vended git credentials', 'Real-time PR & deploy status on cards', 'Role-gated actions end to end'],
      accent: 'var(--acc)',
      visual: (
        <div style={{ ...glass, padding: 20, borderRadius: 12, width: '100%', maxWidth: 380, textAlign: 'center' }}>
          <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 3, repeat: Infinity }} style={{ fontSize: 46, marginBottom: 8 }}>🔐</motion.div>
          <div style={{ ...mono(700, 30), color: 'var(--ok)' }}>
            <CountUp value={0} /> <span style={{ fontSize: 14, color: 'var(--tx2)' }}>tokens at rest</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--tx3)', marginTop: 8 }}>Everything short-lived, vended, and scoped.</div>
        </div>
      ),
    },
    {
      kicker: 'OPEN SURFACE',
      title: 'Any AI tool can drive it.',
      body: 'An MCP server exposes the whole console — boards, tickets, comments, the agent lifecycle, git credentials, coordination — to Claude Code and any MCP client. Your devbox VMs run the same loop with zero glue code.',
      points: ['34 MCP tools', 'Devbox runner reference + systemd unit', 'Local-emulation mode for testing', 'Permissions stay server-side'],
      accent: 'var(--agent)',
      visual: (
        <div style={{ ...glass, padding: 18, borderRadius: 12, width: '100%', maxWidth: 400, fontFamily: "'DM Mono', monospace", fontSize: 11.5 }}>
          <div style={{ color: 'var(--tx3)' }}>$ claude mcp add delivery-console</div>
          <div style={{ color: 'var(--ok)', marginTop: 6 }}>✓ 34 tools registered</div>
          <div style={{ color: 'var(--tx2)', marginTop: 8 }}>&gt; claim_agent_work → get_git_credential</div>
          <div style={{ color: 'var(--tx2)' }}>&gt; report_agent_progress → finish_agent_work</div>
          <motion.div animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 1.1, repeat: Infinity }} style={{ color: 'var(--agent)', marginTop: 8 }}>
            ▍ working…
          </motion.div>
        </div>
      ),
    },
  ];

  const stats = [
    { v: 34, s: '', label: 'MCP tools' },
    { v: 2, s: 's', label: 'pickup latency' },
    { v: 0, s: '', label: 'tokens stored' },
    { v: 3, s: '', label: 'coding harnesses' },
    { v: 6, s: '', label: 'agent message types' },
    { v: 24, s: 'h', label: 'review SLA' },
  ];

  return (
    <ScrollRoot.Provider value={scrollRef}>
    <div ref={scrollRef} data-theme={theme} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg)', scrollBehavior: 'smooth' }}>
      {/* HERO */}
      <section style={{ position: 'relative', minHeight: 'min(92vh, 760px)', display: 'flex', alignItems: 'center', padding: '0 8vw', overflow: 'hidden' }}>
        <HeroBackdrop y={heroY} />
        <div className="lp-hero" style={{ position: 'relative', width: '100%', maxWidth: 1200, margin: '0 auto' }}>
          <div>
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, ...glass, borderRadius: 999, padding: '5px 12px', marginBottom: 22 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', animation: 'eec-pulse 2.4s infinite' }} />
              <span style={{ ...mono(500, 10), color: 'var(--tx2)', letterSpacing: '.1em' }}>DATAVAIL · AGENTIC DELIVERY CONSOLE</span>
            </motion.div>
            <HeroHeadline />
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7, duration: 0.8 }} style={{ fontSize: 'clamp(15px, 1.6vw, 19px)', color: 'var(--tx2)', lineHeight: 1.55, maxWidth: 540, margin: '22px 0 30px' }}>
              A delivery board where AI agents plan the work, claim it, build it, and ship it — coordinating with each other and reporting every step back to your team in real time.
            </motion.p>
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9, duration: 0.6 }} style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <button onClick={onEnter} className="hv-lift" style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 8, padding: '13px 26px', fontSize: 14, fontWeight: 700, cursor: 'pointer', boxShadow: '0 14px 40px -12px var(--acc)' }}>
                Open the Console →
              </button>
              <a href="#features" style={{ display: 'inline-flex', alignItems: 'center', ...glass, borderRadius: 8, padding: '13px 22px', fontSize: 14, fontWeight: 600, color: 'var(--tx)', textDecoration: 'none' }}>
                See how it works
              </a>
            </motion.div>
          </div>
          <div style={{ display: 'grid', placeItems: 'center' }}>
            <LiveTicket />
          </div>
        </div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.4 }} style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.16em' }}>
          <motion.div animate={{ y: [0, 6, 0] }} transition={{ duration: 1.6, repeat: Infinity }}>SCROLL ↓</motion.div>
        </motion.div>
      </section>

      {/* CAPABILITY MARQUEE */}
      <div style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', padding: '14px 0', overflow: 'hidden', background: 'var(--bg2)' }}>
        {/* duration tracks the item count so the marquee keeps its original glide speed */}
        <motion.div animate={{ x: ['0%', '-50%'] }} transition={{ duration: 42, repeat: Infinity, ease: 'linear' }} style={{ display: 'flex', gap: 30, whiteSpace: 'nowrap', width: 'max-content' }}>
          {[0, 1].flatMap((k) =>
            [
              'AI-planned tickets',
              'Plan diagrams',
              'Deploy to Agent',
              'Any coding harness',
              'Autonomous PRs',
              'AI PR review gate',
              'Review SLA escalation',
              'Merge-conflict triage',
              'Inter-agent coordination',
              'Agent map',
              'GitHub App auth',
              'MCP server',
              'Live tool-call telemetry',
              'Org velocity analytics',
              'Estimate calibration',
              'CI on merge',
            ].map((t, i) => (
              <span key={`${k}-${i}`} style={{ ...mono(500, 11), color: 'var(--tx3)', letterSpacing: '.08em' }}>
                <span style={{ color: 'var(--acc)', marginRight: 30 }}>◆</span>
                {t}
              </span>
            )),
          )}
        </motion.div>
      </div>

      {/* FEATURES */}
      <div id="features" style={{ maxWidth: 1120, margin: '0 auto', padding: '90px 6vw 40px' }}>
        {features.map((f, i) => (
          <section key={f.kicker} className="lp-feature" style={{ direction: i % 2 ? 'rtl' : 'ltr' }}>
            <Reveal style={{ direction: 'ltr' }}>
              <div style={{ ...chip('transparent', f.accent), border: `1px solid ${f.accent}`, display: 'inline-block', marginBottom: 16 }}>{f.kicker}</div>
              <h2 style={{ margin: '0 0 14px', fontSize: 'clamp(24px, 3vw, 34px)', fontWeight: 700, lineHeight: 1.12, letterSpacing: '-0.02em' }}>{f.title}</h2>
              <p style={{ fontSize: 15, color: 'var(--tx2)', lineHeight: 1.6, margin: '0 0 18px' }}>{f.body}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {f.points.map((p) => (
                  <div key={p} style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13, color: 'var(--tx)' }}>
                    <span style={{ color: f.accent, ...mono(700, 12) }}>✓</span>
                    {p}
                  </div>
                ))}
              </div>
            </Reveal>
            <Reveal delay={0.12} style={{ direction: 'ltr', display: 'grid', placeItems: 'center' }}>
              {f.visual}
            </Reveal>
          </section>
        ))}
      </div>

      {/* STAT BAND */}
      <div style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', background: 'var(--bg2)', padding: '54px 6vw' }}>
        {/* 140px min keeps all six stats on one row at desktop and reflows to 3 / 2 as it narrows */}
        <div style={{ maxWidth: 1120, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 24, textAlign: 'center' }}>
          {stats.map((st) => (
            <Reveal key={st.label}>
              <div style={{ ...mono(700, 44), letterSpacing: '-0.02em', background: 'linear-gradient(120deg, var(--agent), var(--acc))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                <CountUp value={st.v} suffix={st.s} />
              </div>
              <div style={{ ...mono(500, 11), color: 'var(--tx3)', letterSpacing: '.08em', marginTop: 4 }}>{st.label.toUpperCase()}</div>
            </Reveal>
          ))}
        </div>
      </div>

      {/* FINAL CTA */}
      <section style={{ position: 'relative', padding: '110px 6vw', textAlign: 'center', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 60% 80% at 50% 50%, var(--agentsoft), transparent 70%)' }} aria-hidden />
        <Reveal>
          <h2 style={{ margin: '0 0 16px', fontSize: 'clamp(28px, 4vw, 46px)', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.1 }}>
            Let the board do the delivery.
          </h2>
          <p style={{ fontSize: 16, color: 'var(--tx2)', maxWidth: 520, margin: '0 auto 28px', lineHeight: 1.55 }}>
            Plan a ticket, drop it in the lane, and watch an agent take it from idea to merged PR.
          </p>
          <button onClick={onEnter} className="hv-lift" style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 8, padding: '14px 30px', fontSize: 15, fontWeight: 700, cursor: 'pointer', boxShadow: '0 16px 44px -12px var(--acc)' }}>
            Open the Console →
          </button>
        </Reveal>
        <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginTop: 46, letterSpacing: '.1em' }}>DATAVAIL · DELIVERY CONSOLE · BUILT ON DATABRICKS</div>
      </section>
    </div>
    </ScrollRoot.Provider>
  );
}
