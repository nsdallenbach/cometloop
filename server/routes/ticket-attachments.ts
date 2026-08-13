import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { resolveIdentity, type Identity } from './roles';
import type { FilesVolume } from './context-files';
import { runFileRules } from './file-library';

/**
 * Per-ticket file attachments (screenshots, logs, documents). Bytes live in
 * the app's UC volume under attachments/<ticketKey>/; metadata lives in
 * app.ticket_attachments so listings survive volume latency and carry
 * uploader/checksum info. Uploads are open to any authenticated team member
 * (like context files); deletion is lead-gated.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const ATTACHMENT_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.ticket_attachments (
    id TEXT PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    size BIGINT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    sha256 TEXT NOT NULL,
    uploader TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS ticket_attachments_ticket_idx ON app.ticket_attachments (ticket_key)`,
];

export const MAX_ATTACHMENT_BYTES = 25_000_000; // 25 MB — matches the volume's 50 MB ceiling with headroom

// Executable/script formats have no place on a delivery ticket; everything
// else (images, logs, archives, office docs) is allowed.
export const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'dll',
  'so',
  'dylib',
  'msi',
  'bat',
  'cmd',
  'com',
  'scr',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'jse',
  'wsf',
  'wsh',
  'jar',
  'app',
  'apk',
  'deb',
  'rpm',
]);

export function sanitizeAttachmentName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'file';
}

/** Returns a human-readable rejection reason, or null when the upload is acceptable. */
export function attachmentRejection(filename: string, size: number): string | null {
  if (size <= 0) return 'Empty upload';
  if (size > MAX_ATTACHMENT_BYTES) {
    return `File is ${Math.ceil(size / 1_000_000)} MB — attachments are limited to ${MAX_ATTACHMENT_BYTES / 1_000_000} MB`;
  }
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (BLOCKED_EXTENSIONS.has(ext)) return `.${ext} files are not allowed as ticket attachments`;
  return null;
}

export interface TicketAttachmentRow {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  sha256: string;
  uploader: string;
  createdAt: string | null;
  url: string;
}

const toEntry = (r: Record<string, unknown>): TicketAttachmentRow => ({
  id: String(r.id),
  filename: String(r.filename),
  size: Number(r.size),
  contentType: String(r.content_type),
  sha256: String(r.sha256),
  uploader: String(r.uploader),
  createdAt:
    r.created_at instanceof Date
      ? r.created_at.toISOString()
      : typeof r.created_at === 'string'
        ? new Date(r.created_at).toISOString()
        : null,
  url: `/api/tickets/${encodeURIComponent(String(r.ticket_key))}/attachments/${encodeURIComponent(String(r.id))}`,
});

export async function listTicketAttachments(q: Query, ticketKey: string): Promise<TicketAttachmentRow[]> {
  const { rows } = await q('SELECT * FROM app.ticket_attachments WHERE ticket_key = $1 ORDER BY created_at, id', [
    ticketKey,
  ]);
  return rows.map(toEntry);
}

/**
 * Remove all attachment bytes for the given tickets from the volume. Metadata
 * rows cascade with the ticket; call this before deleting tickets so the
 * storage paths are still readable.
 */
export async function deleteAttachmentFiles(q: Query, files: FilesVolume, ticketKeys: string[]): Promise<void> {
  if (ticketKeys.length === 0) return;
  const { rows } = await q('SELECT storage_path FROM app.ticket_attachments WHERE ticket_key = ANY($1)', [ticketKeys]);
  for (const r of rows) {
    try {
      await files.delete(String(r.storage_path));
    } catch (err) {
      console.warn('[attachments] volume cleanup failed:', (err as Error).message);
    }
  }
}

export function setupTicketAttachmentRoutes(
  app: express.Application,
  q: Query,
  files: FilesVolume,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Identity | null>,
  refineTicket?: (key: string, feedback: string) => Promise<void>
) {
  const ticketRow = async (key: string): Promise<{ engagement_id: string } | null> => {
    const { rows } = await q('SELECT engagement_id FROM app.tickets WHERE key = $1', [key]);
    return rows.length > 0 ? { engagement_id: String(rows[0].engagement_id) } : null;
  };

  app.get('/api/tickets/:key/attachments', async (req, res) => {
    try {
      if (!(await ticketRow(req.params.key))) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      res.json({ attachments: await listTicketAttachments(q, req.params.key) });
    } catch (err) {
      console.error('attachment list failed:', err);
      res.status(500).json({ error: 'Failed to list attachments' });
    }
  });

  // Parser limit sits above MAX_ATTACHMENT_BYTES so the size check in
  // attachmentRejection can answer with a clear JSON error instead of the
  // body parser's default 413 page.
  app.post(
    '/api/tickets/:key/attachments',
    express.raw({ type: '*/*', limit: MAX_ATTACHMENT_BYTES + 1_000_000 }),
    async (req, res) => {
      try {
        const key = req.params.key;
        const ticket = await ticketRow(key);
        if (!ticket) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        const rawName = typeof req.query.filename === 'string' ? req.query.filename : '';
        if (!rawName) {
          res.status(400).json({ error: 'A filename query parameter is required' });
          return;
        }
        const body = req.body as Buffer;
        const filename = sanitizeAttachmentName(rawName);
        const rejection = attachmentRejection(filename, Buffer.isBuffer(body) ? body.length : 0);
        if (rejection) {
          res.status(rejection.startsWith('File is') ? 413 : 400).json({ error: rejection });
          return;
        }
        const contentType =
          typeof req.headers['x-attachment-content-type'] === 'string' &&
          req.headers['x-attachment-content-type'].trim()
            ? req.headers['x-attachment-content-type'].trim().slice(0, 120)
            : 'application/octet-stream';
        const requestedFolder = typeof req.query.folderId === 'string' ? req.query.folderId : '';
        let folderId: string | null = null;
        if (requestedFolder) {
          const valid = (
            await q('SELECT id FROM app.file_folders WHERE id=$1 AND engagement_id=$2', [
              requestedFolder,
              ticket.engagement_id,
            ])
          ).rows[0];
          if (!valid) {
            res.status(400).json({ error: 'Folder does not belong to this ticket engagement' });
            return;
          }
          folderId = requestedFolder;
        }
        const id = randomUUID();
        const storagePath = folderId
          ? `files/${ticket.engagement_id}/${folderId}/${id}-${filename}`
          : `attachments/${key}/${id}-${filename}`;
        await files.upload(storagePath, body, { overwrite: false });
        const who = await resolveIdentity(req);
        const inserted = await q(
          `INSERT INTO app.ticket_attachments (id, ticket_key, filename, size, content_type, sha256, uploader, storage_path, folder_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            id,
            key,
            filename,
            body.length,
            contentType,
            createHash('sha256').update(body).digest('hex'),
            who.email,
            storagePath,
            folderId,
          ]
        );
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', $3, false)`,
          [
            ticket.engagement_id,
            `${who.email} attached ${filename} (${Math.ceil(body.length / 1024)} KB) to ${key}.`,
            filename,
          ]
        );
        if (folderId) await runFileRules(q, ticket.engagement_id, folderId, id, filename, refineTicket);
        res.status(201).json(toEntry(inserted.rows[0]));
      } catch (err) {
        console.error('attachment upload failed:', err);
        res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  app.get('/api/tickets/:key/attachments/:id', async (req, res) => {
    try {
      const { rows } = await q('SELECT * FROM app.ticket_attachments WHERE id = $1 AND ticket_key = $2', [
        req.params.id,
        req.params.key,
      ]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      const meta = rows[0];
      const dl = await files.download(String(meta.storage_path));
      if (!dl.contents) {
        res.status(404).json({ error: 'Attachment content missing from storage' });
        return;
      }
      const buf = Buffer.from(await new Response(dl.contents).arrayBuffer());
      res.setHeader('Content-Type', String(meta.content_type) || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${String(meta.filename)}"`);
      res.setHeader('X-Content-Sha256', String(meta.sha256));
      res.send(buf);
    } catch (err) {
      console.warn('attachment download failed:', (err as Error).message);
      res.status(404).json({ error: 'Attachment not found' });
    }
  });

  app.delete('/api/tickets/:key/attachments/:id', async (req, res) => {
    try {
      const key = req.params.key;
      const ticket = await ticketRow(key);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      if (!(await requireLead(req, res, ticket.engagement_id))) return;
      const { rows } = await q('SELECT * FROM app.ticket_attachments WHERE id = $1 AND ticket_key = $2', [
        req.params.id,
        key,
      ]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }
      const meta = rows[0];
      try {
        await files.delete(String(meta.storage_path));
      } catch (err) {
        // A missing volume file should not strand the metadata row.
        console.warn('[attachments] volume delete failed:', (err as Error).message);
      }
      await q('DELETE FROM app.ticket_attachments WHERE id = $1', [req.params.id]);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', $3, false)`,
        [ticket.engagement_id, `Removed attachment ${String(meta.filename)} from ${key}.`, String(meta.filename)]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('attachment delete failed:', err);
      res.status(500).json({ error: 'Failed to delete attachment' });
    }
  });
}
