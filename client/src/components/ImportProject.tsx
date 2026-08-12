import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { buildImportPrompt } from '../lib/import-prompt';
import { mono } from '../util';

/**
 * Modal shown from the Portfolio next to "New engagement": a ready-made,
 * copy-paste prompt that instructs a human or AI agent how to gather an
 * existing project's context and bring it into the console via the
 * "Describe the project" path of the New engagement flow. Client/name
 * fields personalize the prompt; blank fields keep <PLACEHOLDERS>.
 */
export function ImportProjectModal({ onClose, toast }: { onClose: () => void; toast: (msg: string) => void }) {
  const [client, setClient] = useState('');
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);

  const prompt = buildImportPrompt(client, name);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      } else {
        // Older browsers / non-secure contexts.
        const ta = document.createElement('textarea');
        ta.value = prompt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      toast('Import prompt copied to clipboard');
    } catch {
      toast('Copy failed — select the text and copy manually');
    }
  };

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box' as const,
    background: 'var(--bg)',
    border: '1px solid var(--line2)',
    borderRadius: 3,
    color: 'var(--tx)',
    padding: '7px 10px',
    fontSize: 12.5,
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 40 }}
      />
      <motion.div
        initial={{ opacity: 0, transform: 'translate(-50%,-50%) scale(0.97) translateY(6px)' }}
        animate={{ opacity: 1, transform: 'translate(-50%,-50%) scale(1) translateY(0px)' }}
        exit={{ opacity: 0, transform: 'translate(-50%,-50%) scale(0.98) translateY(4px)' }}
        transition={{ type: 'spring', visualDuration: 0.25, bounce: 0.15 }}
        role="dialog"
        aria-label="Import an existing project"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          width: 640,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 60px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg2)',
          border: '1px solid var(--line)',
          borderRadius: 4,
          zIndex: 41,
          boxShadow: '0 12px 40px rgba(0,0,0,.45)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '13px 18px', borderBottom: '1px solid var(--line)', flex: 'none' }}>
          <span style={{ ...mono(500, 11), letterSpacing: '.1em', color: 'var(--tx2)' }}>IMPORT PROJECT</span>
          <button
            className="hv-tx"
            onClick={onClose}
            aria-label="Close"
            style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 16, cursor: 'pointer', padding: '2px 6px' }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: 18, overflow: 'auto' }}>
          <p style={{ margin: '0 0 14px', color: 'var(--tx2)', fontSize: 12.5, lineHeight: 1.5 }}>
            Copy this prompt and run it wherever the existing project lives (an AI agent in the repo, or a teammate who knows the
            project). It walks through gathering the project’s context and turning it into a brief the New engagement flow ingests.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={{ display: 'block', ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>
                CLIENT <span style={{ opacity: 0.7 }}>(OPTIONAL)</span>
              </label>
              <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client name" style={inputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>
                PROJECT NAME <span style={{ opacity: 0.7 }}>(OPTIONAL)</span>
              </label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Data Platform Modernization" style={inputStyle} />
            </div>
          </div>
          <pre
            style={{
              margin: 0,
              maxHeight: 320,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 3,
              padding: '12px 14px',
              fontFamily: "'DM Mono', monospace",
              fontSize: 11,
              lineHeight: 1.55,
              color: 'var(--tx2)',
            }}
          >
            {prompt}
          </pre>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', borderTop: '1px solid var(--line)', flex: 'none' }}>
          <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{prompt.length} CHARS</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '7px 14px', fontSize: 12, cursor: 'pointer' }}
          >
            Close
          </button>
          <button
            className="hv-bright"
            onClick={() => void copy()}
            style={{
              background: copied ? 'var(--ok)' : 'var(--acc)',
              color: '#fff',
              border: 'none',
              borderRadius: 3,
              padding: '7px 16px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              minWidth: 150,
            }}
          >
            {copied ? '✓ Copied' : 'Copy to clipboard'}
          </button>
        </div>
      </motion.div>
    </>
  );
}
