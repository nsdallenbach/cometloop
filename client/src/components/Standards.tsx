import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ContextFile } from '../types';
import { mono } from '../util';
import { CODE_LANG, extOf, fencedBlock, lineDiff } from '../lib/standards-doc';
import { Markdown } from './Markdown';

/**
 * Project Standards tab: one markdown document per engagement with a
 * live-preview editor, a suggested starting template, AI-assisted refinement
 * (review the diff before applying) and attached code example files that can
 * be embedded as fenced code blocks.
 */

const TEMPLATE = `# Project Standards

Team standards for this engagement — how we write, test, review and ship work. Keep this current; agents working queued tickets read it as context.

## Coding conventions

- Language and framework versions the project is pinned to.
- Formatting is tool-enforced (linter/formatter); no style debates in review.
- Prefer small, focused modules; avoid one-letter identifiers outside loops.

## Naming

- Branches: \`<TICKET-KEY>-<short-slug>\` (e.g. \`ABC-101-load-dim-tables\`).
- Commits: start with the ticket key; imperative mood ("ABC-101: Add …").
- Database objects: snake_case; tables plural, columns singular.

## Testing

- Every change ships with tests that fail before the change and pass after.
- Unit tests for logic, integration tests for pipelines/endpoints touched.
- CI must be green before review is requested.

## Review process

- One approval required; two for schema or infra changes.
- Reviewers respond within one business day.
- Author merges after approval; squash-merge with the ticket key in the title.

## Delivery workflow

- Work is tracked on the board; pick from the top of the backlog.
- Anything blocked longer than a day is raised in the status feed.

## Code examples

Attach example files on the right, or embed the important ones here as fenced code blocks so reviewers and agents see them inline.
`;

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

const btn = (active = false): React.CSSProperties => ({
  border: 'none',
  background: active ? 'var(--bg3)' : 'transparent',
  color: active ? 'var(--tx)' : 'var(--tx2)',
  padding: '4px 11px',
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
});

const actionBtn: React.CSSProperties = {
  border: '1px solid var(--line2)',
  background: 'none',
  color: 'var(--tx)',
  borderRadius: 3,
  padding: '4px 12px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
};

export function Standards({ engId, lead, toast }: { engId: string; lead: boolean; toast: (msg: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ updatedBy: string; updatedAt: string | null }>({ updatedBy: '', updatedAt: null });
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<'edit' | 'split' | 'preview'>('split');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [templateConfirm, setTemplateConfirm] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [refining, setRefining] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggestionView, setSuggestionView] = useState<'diff' | 'preview'>('diff');
  const [files, setFiles] = useState<ContextFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [inserting, setInserting] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textRef = useRef('');
  const dirtyRef = useRef(false);

  const load = () => {
    api
      .standards(engId)
      .then((d) => {
        setText(d.content);
        textRef.current = d.content;
        setMeta({ updatedBy: d.updatedBy, updatedAt: d.updatedAt });
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  };

  const loadFiles = () => {
    api
      .standardsFiles(engId)
      .then(setFiles)
      .catch(() => setFiles([]));
  };

  useEffect(() => {
    load();
    loadFiles();
    // Flush an unsaved draft when the tab unmounts (tab switch / navigation).
    return () => {
      clearTimeout(saveTimer.current);
      if (dirtyRef.current) void api.saveStandards(engId, textRef.current).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engId]);

  const save = (value: string) => {
    api
      .saveStandards(engId, value)
      .then((d) => {
        dirtyRef.current = textRef.current !== value ? dirtyRef.current : false;
        setMeta({ updatedBy: d.updatedBy, updatedAt: d.updatedAt });
        setSavedAt(new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }));
      })
      .catch(() => toast('Standards save failed'));
  };

  const setDraft = (value: string) => {
    setText(value);
    textRef.current = value;
    dirtyRef.current = true;
    setSavedAt(null);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(value), 1200);
  };

  const flushSave = () => {
    if (!dirtyRef.current) return;
    clearTimeout(saveTimer.current);
    save(textRef.current);
  };

  const applyTemplate = () => {
    setTemplateConfirm(false);
    setDraft(TEMPLATE);
    toast('Template loaded — edit it to fit this engagement');
  };

  const refine = () => {
    if (!textRef.current.trim()) {
      toast('Write or load a draft first — AI refine revises the current document');
      return;
    }
    setRefining(true);
    flushSave();
    api
      .refineStandards(engId, textRef.current, instructions)
      .then(({ content }) => {
        setSuggestion(content);
        setSuggestionView('diff');
      })
      .catch((e: Error) => toast(`AI refine failed — ${e.message}`))
      .finally(() => setRefining(false));
  };

  const applySuggestion = () => {
    if (suggestion === null) return;
    setDraft(suggestion);
    flushSave();
    setSuggestion(null);
    setInstructions('');
    toast('AI revision applied and saved');
  };

  const upload = (file: File) => {
    setUploading(true);
    api
      .uploadStandardsFile(engId, file)
      .then(() => {
        toast(`${file.name} attached to standards`);
        loadFiles();
      })
      .catch((e: Error) => toast(`Upload failed — ${e.message}`))
      .finally(() => setUploading(false));
  };

  const insertFile = (f: ContextFile) => {
    setInserting(f.name);
    fetch(f.url)
      .then((r) => {
        if (!r.ok) throw new Error('download failed');
        return r.text();
      })
      .then((code) => {
        const base = textRef.current.replace(/\s+$/, '');
        setDraft(`${base ? `${base}\n\n` : ''}${fencedBlock(f.name, code)}`);
        toast(`${f.name} embedded as a code block`);
      })
      .catch(() => toast(`Couldn't read ${f.name} for embedding`))
      .finally(() => setInserting(null));
  };

  const removeFile = (name: string) => {
    api
      .deleteStandardsFile(engId, name)
      .then(() => {
        setDeleteConfirm(null);
        toast(`${name} removed`);
        loadFiles();
      })
      .catch((e: Error) => toast(`Delete failed — ${e.message}`));
  };

  if (text === null) {
    return (
      <div className="tab-pane" style={{ flex: 1, padding: 40, textAlign: 'center', color: 'var(--tx3)', ...mono(400, 11) }}>
        {loadError ? (
          <>
            COULDN’T LOAD STANDARDS —{' '}
            <button
              onClick={load}
              style={{ border: 'none', background: 'none', color: 'var(--acc)', ...mono(500, 11), cursor: 'pointer', padding: 0 }}
            >
              RETRY
            </button>
          </>
        ) : (
          'LOADING STANDARDS…'
        )}
      </div>
    );
  }

  const diff = suggestion !== null ? lineDiff(text, suggestion) : null;

  return (
    <div
      className="tab-pane"
      style={{
        flex: 1,
        minHeight: 0,
        padding: '14px 22px 18px',
        display: 'grid',
        gridTemplateColumns: '1fr 360px',
        gap: 14,
        alignItems: 'stretch',
        overflow: 'hidden',
      }}
    >
      {/* document editor / preview */}
      <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' }}>
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>PROJECT STANDARDS</span>
          <div style={{ display: 'flex', border: '1px solid var(--line2)', borderRadius: 3, overflow: 'hidden' }}>
            <button onClick={() => setView('edit')} style={btn(view === 'edit')}>Edit</button>
            <button onClick={() => setView('split')} style={btn(view === 'split')}>Split</button>
            <button onClick={() => setView('preview')} style={btn(view === 'preview')}>Preview</button>
          </div>
          {!templateConfirm && (
            <button onClick={() => (text.trim() ? setTemplateConfirm(true) : applyTemplate())} style={actionBtn}>
              Start from template
            </button>
          )}
          {templateConfirm && (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--warn)' }}>Replace the current document?</span>
              <button
                onClick={applyTemplate}
                style={{ border: '1px solid var(--warn)', background: 'none', color: 'var(--warn)', borderRadius: 3, padding: '2px 8px', fontSize: 10.5, fontWeight: 600, cursor: 'pointer' }}
              >
                Replace
              </button>
              <button
                onClick={() => setTemplateConfirm(false)}
                style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '2px 8px', fontSize: 10.5, cursor: 'pointer' }}
              >
                Cancel
              </button>
            </span>
          )}
          <div style={{ flex: 1 }} />
          {savedAt && <span style={{ ...mono(400, 10), color: 'var(--ok)' }}>SAVED {savedAt}</span>}
          {meta.updatedAt && (
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }} title={meta.updatedAt}>
              LAST UPDATE {meta.updatedBy ? `${meta.updatedBy} · ` : ''}{fmtWhen(meta.updatedAt)}
            </span>
          )}
        </div>

        {suggestion !== null ? (
          /* AI revision review — replaces the editor until applied or discarded */
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: '1px solid var(--line)', background: 'var(--agentsoft)' }}>
              <span style={{ ...mono(500, 10), color: 'var(--agent)', letterSpacing: '.08em' }}>◆ AI SUGGESTED REVISION — REVIEW BEFORE APPLYING</span>
              <div style={{ display: 'flex', border: '1px solid var(--line2)', borderRadius: 3, overflow: 'hidden' }}>
                <button onClick={() => setSuggestionView('diff')} style={btn(suggestionView === 'diff')} disabled={!diff}>Changes</button>
                <button onClick={() => setSuggestionView('preview')} style={btn(suggestionView === 'preview')}>Preview</button>
              </div>
              <div style={{ flex: 1 }} />
              <button
                onClick={applySuggestion}
                style={{ border: '1px solid var(--ok)', background: 'none', color: 'var(--ok)', borderRadius: 3, padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
              >
                Apply revision
              </button>
              <button
                onClick={() => setSuggestion(null)}
                style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '4px 12px', fontSize: 11, cursor: 'pointer' }}
              >
                Discard
              </button>
            </div>
            {suggestionView === 'diff' && diff ? (
              <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: 1.5 }}>
                {diff.map((l, i) => (
                  <div
                    // eslint-disable-next-line react/no-array-index-key -- diff lines have no stable id and can repeat verbatim
                    key={i}
                    style={{
                      whiteSpace: 'pre-wrap',
                      color: l.type === 'add' ? 'var(--ok)' : l.type === 'del' ? 'var(--bad)' : 'var(--tx2)',
                      textDecoration: l.type === 'del' ? 'line-through' : 'none',
                      borderLeft: `2px solid ${l.type === 'add' ? 'var(--ok)' : l.type === 'del' ? 'var(--bad)' : 'transparent'}`,
                      paddingLeft: 8,
                    }}
                  >
                    {l.text || ' '}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
                <Markdown text={suggestion} />
              </div>
            )}
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: view === 'split' ? '1fr 1fr' : '1fr' }}>
            {view !== 'preview' && (
              <textarea
                value={text}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={flushSave}
                placeholder="Write your team's delivery standards in markdown — or start from the template."
                spellCheck={false}
                style={{
                  border: 'none',
                  borderRight: view === 'split' ? '1px solid var(--line)' : 'none',
                  outline: 'none',
                  background: 'var(--bg)',
                  color: 'var(--tx)',
                  padding: '12px 14px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  lineHeight: 1.6,
                  resize: 'none',
                  minHeight: 0,
                }}
              />
            )}
            {view !== 'edit' && (
              <div style={{ minHeight: 0, overflow: 'auto', padding: '12px 16px' }}>
                {text.trim() ? (
                  <Markdown text={text} />
                ) : (
                  <div style={{ padding: '18px 0', fontSize: 12, color: 'var(--tx3)' }}>
                    Nothing here yet — the preview renders your markdown as you type.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* right rail: AI refine + code examples */}
      <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
        <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ ...mono(500, 10), background: 'var(--agentsoft)', color: 'var(--agent)', borderRadius: 2, padding: '2px 7px', letterSpacing: '.06em' }}>◆ AI REFINE</span>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>Revise the current draft</span>
          </div>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Optional instructions — e.g. “tighten the testing section and add a rollback policy”"
            rows={3}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'var(--bg)',
              border: '1px solid var(--line2)',
              borderRadius: 3,
              color: 'var(--tx)',
              padding: '8px 10px',
              fontSize: 12,
              lineHeight: 1.5,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>You review every change before it lands.</span>
            <div style={{ flex: 1 }} />
            <button
              onClick={refine}
              disabled={refining || suggestion !== null}
              style={{
                border: '1px solid var(--agent)',
                background: 'none',
                color: 'var(--agent)',
                borderRadius: 3,
                padding: '5px 14px',
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
                opacity: refining || suggestion !== null ? 0.5 : 1,
              }}
            >
              {refining ? 'Refining…' : 'Refine with AI'}
            </button>
          </div>
        </div>

        <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
            <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>CODE EXAMPLES</span>
            <div style={{ flex: 1 }} />
            <input
              ref={inputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = '';
              }}
            />
            <button onClick={() => inputRef.current?.click()} disabled={uploading} style={{ ...actionBtn, opacity: uploading ? 0.5 : 1 }}>
              {uploading ? 'Uploading…' : 'Upload file'}
            </button>
          </div>
          {files === null && <div style={{ padding: '14px', fontSize: 12, color: 'var(--tx3)', textAlign: 'center' }}>Loading…</div>}
          {files && files.length === 0 && (
            <div style={{ padding: '16px 14px', fontSize: 11.5, color: 'var(--tx3)', textAlign: 'center', lineHeight: 1.5 }}>
              No code examples yet — upload reference files, then embed them into the document as fenced code blocks.
            </div>
          )}
          {files?.map((f) => (
            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--line)' }}>
              <a href={f.url} className="hv-agent" style={{ fontSize: 12, color: 'var(--tx)', textDecoration: 'none', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.name}
              </a>
              <span style={{ ...mono(400, 9), color: 'var(--tx3)', flex: 'none' }}>{fmtSize(f.size)}</span>
              <div style={{ flex: 1 }} />
              {extOf(f.name) in CODE_LANG && suggestion === null && (
                <button
                  onClick={() => insertFile(f)}
                  disabled={inserting !== null}
                  title="Embed this file into the document as a fenced code block"
                  style={{ border: 'none', background: 'none', color: 'var(--agent)', ...mono(500, 9), cursor: 'pointer', letterSpacing: '.06em', opacity: inserting !== null ? 0.5 : 1 }}
                >
                  {inserting === f.name ? 'INSERTING…' : 'INSERT'}
                </button>
              )}
              {lead && deleteConfirm !== f.name && (
                <button
                  className="hv-bad"
                  onClick={() => setDeleteConfirm(f.name)}
                  style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 9), cursor: 'pointer', letterSpacing: '.06em' }}
                >
                  REMOVE
                </button>
              )}
              {lead && deleteConfirm === f.name && (
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <button
                    onClick={() => removeFile(f.name)}
                    style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '2px 8px', fontSize: 10.5, fontWeight: 600, cursor: 'pointer' }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(null)}
                    style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '2px 8px', fontSize: 10.5, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
