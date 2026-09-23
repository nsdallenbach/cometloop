import express from 'express';
import { z } from 'zod';
import { callerOf, type Caller } from './roles';
import type { FilesVolume } from './context-files';
import { invokeModel } from './llm-health';

/**
 * Per-engagement Project Standards: a single markdown document the team
 * maintains (coding conventions, naming, testing, review process) plus
 * attached code example files stored in the app's UC volume under
 * standards/<engagementId>/. An AI refine endpoint reuses the serving
 * endpoint to propose a revised draft the user reviews before applying.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

type Serving = (alias: string) => { invoke(body: unknown): Promise<unknown> };

export const STANDARDS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.project_standards (
    engagement_id TEXT PRIMARY KEY REFERENCES app.engagements(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

const dirFor = (engagementId: string) => `standards/${engagementId}`;

function safeFilename(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || 'file';
}

/** Same ExecutionResult unwrapping as the planning endpoints in api.ts. */
function extractModelText(response: unknown): string {
  let payload = response;
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const wrapper = payload as { ok: boolean; data?: unknown; message?: string };
    if (!wrapper.ok) throw new Error(wrapper.message ?? 'model invocation failed');
    payload = wrapper.data;
  }
  const r = payload as { choices?: { message?: { content?: unknown } }[] };
  const content = r?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const part = c as { type?: string; text?: string };
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

/** The model is told not to fence the document, but strip a wrapper fence if it does anyway. */
function unwrapFence(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\n([\s\S]*)\n```$/.exec(t);
  return m ? m[1] : t;
}

const SaveBody = z.object({ content: z.string().max(500_000) });

const RefineBody = z.object({
  content: z.string().min(1).max(200_000),
  instructions: z.string().max(2_000).optional(),
});

export function setupStandardsRoutes(
  app: express.Application,
  q: Query,
  files: FilesVolume,
  serving: Serving,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
) {
  const engagementExists = async (id: string): Promise<boolean> =>
    (await q('SELECT 1 FROM app.engagements WHERE id = $1', [id])).rows.length > 0;

  app.get('/api/engagements/:id/standards', async (req, res) => {
    try {
      if (!(await engagementExists(req.params.id))) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const row = (await q('SELECT * FROM app.project_standards WHERE engagement_id = $1', [req.params.id])).rows[0];
      res.json(row ?? { engagement_id: req.params.id, content: '', updated_by: '', updated_at: null });
    } catch (err) {
      console.error('standards load failed:', err);
      res.status(500).json({ error: 'Failed to load standards' });
    }
  });

  // Standards are team-maintained: any authenticated member can save, like
  // context-file uploads. The author of the last save is recorded.
  app.put('/api/engagements/:id/standards', express.json({ limit: '2mb' }), async (req, res) => {
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    try {
      const engagementId = req.params.id;
      if (!(await engagementExists(engagementId))) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const who = await callerOf(req);
      const result = await q(
        `INSERT INTO app.project_standards (engagement_id, content, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (tenant_id, engagement_id) DO UPDATE SET content = $2, updated_by = $3, updated_at = NOW()
         RETURNING *`,
        [engagementId, parsed.data.content, who.email],
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error('standards save failed:', err);
      res.status(500).json({ error: 'Failed to save standards' });
    }
  });

  app.post('/api/engagements/:id/standards/refine', express.json({ limit: '2mb' }), async (req, res) => {
    const parsed = RefineBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A non-empty draft is required' });
      return;
    }
    try {
      if (!(await engagementExists(req.params.id))) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const { content, instructions } = parsed.data;
      const prompt = [
        'You maintain the engineering delivery standards document for a consulting engagement. Revise the draft standards document below.',
        instructions?.trim()
          ? `Editor's instructions for this revision:\n${instructions.trim()}`
          : 'No specific instructions were given: improve structure, clarity, consistency and completeness. Tighten wording, fix heading hierarchy, and fill obvious gaps in a standards document of this kind (conventions, naming, testing, review process, examples).',
        'Rules:',
        [
          '- Respond with ONLY the complete revised markdown document — no preamble, no commentary, and no code fence wrapping the document.',
          '- Preserve the intent and every project-specific fact in the draft; do not invent project-specific facts.',
          '- Keep fenced code examples unless the instructions say otherwise.',
        ].join('\n'),
        'Draft:',
        '---',
        content,
        '---',
      ].join('\n\n');
      const response = await invokeModel(serving, q, 'standards-refine', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
      }, { engagementId: req.params.id });
      const revised = unwrapFence(extractModelText(response));
      if (!revised) throw new Error('empty model response');
      res.json({ content: revised });
    } catch (err) {
      console.warn('standards refine failed:', (err as Error).message);
      res.status(502).json({ error: 'AI refine failed — the model endpoint is unavailable. Try again shortly.' });
    }
  });

  // ---- code example attachments ----

  app.get('/api/engagements/:id/standards/files', async (req, res) => {
    try {
      const engagementId = req.params.id;
      if (!(await engagementExists(engagementId))) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      let entries: Awaited<ReturnType<FilesVolume['list']>> = [];
      try {
        entries = await files.list(dirFor(engagementId));
      } catch {
        // The directory only exists after the first upload.
      }
      res.json({
        files: entries
          .filter((e) => !e.is_directory && e.name)
          .map((e) => ({
            name: String(e.name),
            size: e.file_size ?? 0,
            lastModified: e.last_modified ? new Date(e.last_modified).toISOString() : null,
            url: `/api/engagements/${encodeURIComponent(engagementId)}/standards/files/${encodeURIComponent(String(e.name))}`,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    } catch (err) {
      console.error('standards files list failed:', err);
      res.status(500).json({ error: 'Failed to list code examples' });
    }
  });

  app.post('/api/engagements/:id/standards/files', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
    try {
      const engagementId = req.params.id;
      if (!(await engagementExists(engagementId))) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const rawName = typeof req.query.filename === 'string' ? req.query.filename : '';
      if (!rawName) {
        res.status(400).json({ error: 'A filename query parameter is required' });
        return;
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'Empty upload' });
        return;
      }
      const filename = safeFilename(rawName);
      await files.upload(`${dirFor(engagementId)}/${filename}`, body, { overwrite: true });
      const who = await callerOf(req);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', $3, false)`,
        [engagementId, `${who.email} attached code example ${filename} to the project standards.`, filename],
      );
      res.status(201).json({ name: filename, size: body.length });
    } catch (err) {
      console.error('standards file upload failed:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  app.get('/api/engagements/:id/standards/files/:name', async (req, res) => {
    try {
      const filename = safeFilename(req.params.name);
      const dl = await files.download(`${dirFor(req.params.id)}/${filename}`);
      if (!dl.contents) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      const buf = Buffer.from(await new Response(dl.contents).arrayBuffer());
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buf);
    } catch (err) {
      console.warn('standards file download failed:', (err as Error).message);
      res.status(404).json({ error: 'File not found' });
    }
  });

  app.delete('/api/engagements/:id/standards/files/:name', async (req, res) => {
    try {
      const engagementId = req.params.id;
      if (!(await requireLead(req, res, engagementId))) return;
      const filename = safeFilename(req.params.name);
      await files.delete(`${dirFor(engagementId)}/${filename}`);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', $3, false)`,
        [engagementId, `Removed code example ${filename} from the project standards.`, filename],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('standards file delete failed:', err);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });
}
