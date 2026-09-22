import express from 'express';
import { callerOf, type Caller } from './roles';

/**
 * Per-engagement context files, stored in the app's UC volume under
 * context/<engagementId>/. Team members upload reference material (specs,
 * runbooks, schemas, briefs); devbox agents read the same files through the
 * download endpoint as task context when working queued tickets.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface FilesVolume {
  upload(filePath: string, contents: Buffer, options?: { overwrite?: boolean }): Promise<void>;
  download(filePath: string): Promise<{ contents?: ReadableStream }>;
  list(directoryPath?: string): Promise<{ name?: string; path?: string; is_directory?: boolean; file_size?: number; last_modified?: number }[]>;
  delete(filePath: string): Promise<void>;
}

export interface ContextFileEntry {
  name: string;
  size: number;
  lastModified: string | null;
  url: string;
}

const dirFor = (engagementId: string) => `context/${engagementId}`;

function safeFilename(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  return cleaned || 'file';
}

export async function listContextFiles(files: FilesVolume, engagementId: string): Promise<ContextFileEntry[]> {
  try {
    const entries = await files.list(dirFor(engagementId));
    return entries
      .filter((e) => !e.is_directory && e.name)
      .map((e) => ({
        name: String(e.name),
        size: e.file_size ?? 0,
        lastModified: e.last_modified ? new Date(e.last_modified).toISOString() : null,
        url: `/api/engagements/${encodeURIComponent(engagementId)}/context-files/${encodeURIComponent(String(e.name))}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // The directory only exists after the first upload.
    return [];
  }
}

export function setupContextFileRoutes(
  app: express.Application,
  q: Query,
  files: FilesVolume,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
) {
  const engagementExists = async (id: string): Promise<boolean> =>
    (await q('SELECT 1 FROM app.engagements WHERE id = $1', [id])).rows.length > 0;

  app.get('/api/engagements/:id/context-files', async (req, res) => {
    try {
      if (!(await engagementExists(req.params.id))) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      res.json({ files: await listContextFiles(files, req.params.id) });
    } catch (err) {
      console.error('context list failed:', err);
      res.status(500).json({ error: 'Failed to list context files' });
    }
  });

  // Uploads are open to any authenticated team member; deletion is lead-gated.
  app.post('/api/engagements/:id/context-files', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
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
        [engagementId, `${who.email} uploaded context file ${filename} (${Math.ceil(body.length / 1024)} KB).`, filename],
      );
      res.status(201).json({ name: filename, size: body.length });
    } catch (err) {
      console.error('context upload failed:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  app.get('/api/engagements/:id/context-files/:name', async (req, res) => {
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
      console.warn('context download failed:', (err as Error).message);
      res.status(404).json({ error: 'File not found' });
    }
  });

  app.delete('/api/engagements/:id/context-files/:name', async (req, res) => {
    try {
      const engagementId = req.params.id;
      if (!(await requireLead(req, res, engagementId))) return;
      const filename = safeFilename(req.params.name);
      await files.delete(`${dirFor(engagementId)}/${filename}`);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', $3, false)`,
        [engagementId, `Removed context file ${filename}.`, filename],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('context delete failed:', err);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });
}
