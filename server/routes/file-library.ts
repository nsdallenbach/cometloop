import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { callerOf, type Caller } from './roles';
import type { FilesVolume } from './context-files';

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const FILE_LIBRARY_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.file_folders (
    id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES app.file_folders(id) ON DELETE RESTRICT, name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (engagement_id, parent_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS app.file_entries (
    id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL REFERENCES app.file_folders(id) ON DELETE RESTRICT, filename TEXT NOT NULL,
    size BIGINT NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/octet-stream', sha256 TEXT NOT NULL,
    uploader TEXT NOT NULL, storage_path TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app.file_rules (
    id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    name TEXT NOT NULL, folder_id TEXT NOT NULL REFERENCES app.file_folders(id) ON DELETE CASCADE,
    file_pattern TEXT NOT NULL DEFAULT '*', action_type TEXT NOT NULL,
    target_ticket TEXT REFERENCES app.tickets(key) ON DELETE SET NULL, enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app.file_rule_runs (
    id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES app.file_rules(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL, result_ticket TEXT REFERENCES app.tickets(key) ON DELETE SET NULL,
    action_type TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(rule_id, file_id)
  )`,
  `ALTER TABLE app.ticket_attachments ADD COLUMN IF NOT EXISTS folder_id TEXT REFERENCES app.file_folders(id) ON DELETE SET NULL`,
];

const FolderBody = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: z.string().uuid().nullable().optional(),
});
const RuleBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    folderId: z.string().uuid(),
    filePattern: z.string().trim().min(1).max(200),
    actionType: z.enum(['create_ticket', 'refine_ticket']),
    targetTicket: z.string().trim().max(40).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.actionType === 'refine_ticket' && !v.targetTicket)
      ctx.addIssue({ code: 'custom', path: ['targetTicket'], message: 'Target ticket required' });
  });

const cleanName = (raw: string) =>
  raw
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim() || 'file';
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const folderDto = (r: Record<string, unknown>) => ({
  id: text(r.id),
  name: text(r.name),
  parentId: r.parent_id == null ? null : text(r.parent_id),
});
const ruleDto = (r: Record<string, unknown>) => ({
  id: text(r.id),
  name: text(r.name),
  folderId: text(r.folder_id),
  filePattern: text(r.file_pattern),
  actionType: text(r.action_type),
  targetTicket: r.target_ticket == null ? null : text(r.target_ticket),
  enabled: r.enabled === true || r.enabled === 't',
});

async function ensureDefaults(q: Query, engagementId: string) {
  let row = (
    await q(
      `SELECT * FROM app.file_folders WHERE engagement_id=$1 AND parent_id IS NULL AND lower(name)=lower('Meeting transcripts')`,
      [engagementId]
    )
  ).rows[0];
  if (!row)
    row = (
      await q(
        `INSERT INTO app.file_folders(id,engagement_id,name) VALUES($1,$2,'Meeting transcripts') ON CONFLICT DO NOTHING RETURNING *`,
        [randomUUID(), engagementId]
      )
    ).rows[0];
  if (!row)
    row = (
      await q(
        `SELECT * FROM app.file_folders WHERE engagement_id=$1 AND parent_id IS NULL AND lower(name)=lower('Meeting transcripts')`,
        [engagementId]
      )
    ).rows[0];
  if (!row) return;
  await q(
    `INSERT INTO app.file_rules(id,engagement_id,name,folder_id,file_pattern,action_type)
    SELECT $1,$2,'Review meeting transcript against board and SOW',$3,'*','create_ticket'
    WHERE NOT EXISTS (SELECT 1 FROM app.file_rules WHERE engagement_id=$2 AND name='Review meeting transcript against board and SOW')`,
    [randomUUID(), engagementId, text(row.id)]
  );
}

export function filePatternMatches(pattern: string, filename: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(filename);
}

async function nextTicketKey(q: Query, engagementId: string) {
  const eng = (await q('SELECT client FROM app.engagements WHERE id=$1', [engagementId])).rows[0];
  const keys = (await q('SELECT key FROM app.tickets WHERE engagement_id=$1', [engagementId])).rows.map((r) =>
    text(r.key)
  );
  const prefix =
    keys[0]?.split('-')[0] ??
    (text(eng?.client)
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 3)
      .toUpperCase() ||
      'ENG');
  return `${prefix}-${Math.max(100, ...keys.map((k) => Number(k.match(/-(\d+)$/)?.[1] ?? 0))) + 1}`;
}

async function runRules(
  q: Query,
  engagementId: string,
  folderId: string,
  fileId: string,
  filename: string,
  refineTicket?: (key: string, feedback: string) => Promise<void>
) {
  const rules = (
    await q('SELECT * FROM app.file_rules WHERE engagement_id=$1 AND folder_id=$2 AND enabled=true', [
      engagementId,
      folderId,
    ])
  ).rows;
  const fired: { ruleId: string; actionType: string; ticketKey: string }[] = [];
  for (const rule of rules) {
    if (!filePatternMatches(text(rule.file_pattern), filename)) continue;
    let ticketKey = text(rule.target_ticket);
    if (text(rule.action_type) === 'create_ticket') {
      ticketKey = await nextTicketKey(q, engagementId);
      const description = `Review the uploaded meeting transcript \`${filename}\` from the Files tab. Compare its action items and decisions against existing tickets on this board and the engagement SOW. Create or refine the necessary delivery work, assign actionable items to appropriate developers, and explicitly flag possible scope creep for human review.\n\n## Source file\nFiles → Meeting transcripts → ${filename}`;
      await q(
        `INSERT INTO app.tickets(key,engagement_id,title,status,assignee,est,workstream,agent,sources,description,ac,blocked,est_hours,human_est_hours)
        VALUES($1,$2,$3,'backlog','—','1h','Transcript review',false,$4,$5,$6,false,1,4)`,
        [
          ticketKey,
          engagementId,
          `Review transcript: ${filename}`,
          JSON.stringify([{ type: 'FILE', label: filename }]),
          description,
          JSON.stringify([
            'Transcript is compared with current board tickets and the SOW',
            'New action items are captured or linked to existing tickets',
            'Potential scope creep is clearly flagged for human review',
          ]),
        ]
      );
      await q(
        `INSERT INTO app.feed_items(engagement_id,actor,text,time_label,source,reversible) VALUES($1,'AGENT',$2,'JUST NOW',$3,false)`,
        [engagementId, `File rule created ticket ${ticketKey} from ${filename}.`, filename]
      );
    } else if (ticketKey) {
      const feedback = `Please refine this ticket using uploaded file **${filename}** (Files browser). Compare it with the SOW and board, preserve relevant decisions, and flag scope creep.`;
      await q(`INSERT INTO app.ticket_comments(ticket_key,author,body) VALUES($1,'Files automation',$2)`, [
        ticketKey,
        feedback,
      ]);
      if (refineTicket) await refineTicket(ticketKey, feedback);
      await q(`UPDATE app.tickets SET updated_at=NOW() WHERE key=$1`, [ticketKey]);
      await q(
        `INSERT INTO app.feed_items(engagement_id,actor,text,time_label,source,reversible) VALUES($1,'AGENT',$2,'JUST NOW',$3,false)`,
        [engagementId, `File rule queued refinement context on ${ticketKey} from ${filename}.`, filename]
      );
    } else continue;
    await q(
      `INSERT INTO app.file_rule_runs(id,rule_id,file_id,result_ticket,action_type) VALUES($1,$2,$3,$4,$5) ON CONFLICT(rule_id,file_id) DO NOTHING`,
      [randomUUID(), text(rule.id), fileId, ticketKey, text(rule.action_type)]
    );
    fired.push({ ruleId: text(rule.id), actionType: text(rule.action_type), ticketKey });
  }
  return fired;
}

export const runFileRules = runRules;

export function setupFileLibraryRoutes(
  app: express.Application,
  q: Query,
  files: FilesVolume,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
  refineTicket?: (key: string, feedback: string) => Promise<void>
) {
  const exists = async (id: string) => (await q('SELECT 1 FROM app.engagements WHERE id=$1', [id])).rows.length > 0;
  app.get('/api/engagements/:id/files', async (req, res) => {
    try {
      if (!(await exists(req.params.id))) return void res.status(404).json({ error: 'Engagement not found' });
      await ensureDefaults(q, req.params.id);
      const folders = (
        await q('SELECT * FROM app.file_folders WHERE engagement_id=$1 ORDER BY name', [req.params.id])
      ).rows.map(folderDto);
      const entries = (
        await q(
          `SELECT f.id,f.filename,f.size,f.created_at,f.folder_id,NULL::text ticket_key FROM app.file_entries f WHERE f.engagement_id=$1
        UNION ALL SELECT a.id,a.filename,a.size,a.created_at,a.folder_id,a.ticket_key FROM app.ticket_attachments a JOIN app.tickets t ON t.key=a.ticket_key WHERE t.engagement_id=$1 AND a.folder_id IS NOT NULL ORDER BY created_at DESC`,
          [req.params.id]
        )
      ).rows.map((r) => ({
        id: text(r.id),
        filename: text(r.filename),
        size: Number(r.size) || 0,
        folderId: text(r.folder_id),
        ticketKey: r.ticket_key == null ? null : text(r.ticket_key),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : text(r.created_at),
        url: r.ticket_key
          ? `/api/tickets/${encodeURIComponent(text(r.ticket_key))}/attachments/${encodeURIComponent(text(r.id))}`
          : `/api/engagements/${encodeURIComponent(req.params.id)}/files/${encodeURIComponent(text(r.id))}`,
      }));
      const rules = (
        await q('SELECT * FROM app.file_rules WHERE engagement_id=$1 ORDER BY created_at', [req.params.id])
      ).rows.map(ruleDto);
      res.json({ folders, files: entries, rules });
    } catch (err) {
      console.error('file library list failed:', err);
      res.status(500).json({ error: 'Failed to list files' });
    }
  });
  app.post('/api/engagements/:id/folders', express.json(), async (req, res) => {
    const parsed = FolderBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid folder' });
    try {
      if (!(await requireLead(req, res, req.params.id))) return;
      const row = (
        await q('INSERT INTO app.file_folders(id,engagement_id,parent_id,name) VALUES($1,$2,$3,$4) RETURNING *', [
          randomUUID(),
          req.params.id,
          parsed.data.parentId ?? null,
          parsed.data.name,
        ])
      ).rows[0];
      res.status(201).json(folderDto(row));
    } catch {
      res.status(409).json({ error: 'Folder name already exists at this level' });
    }
  });
  app.patch('/api/engagements/:id/folders/:folderId', express.json(), async (req, res) => {
    const parsed = FolderBody.pick({ name: true }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid folder name' });
    if (!(await requireLead(req, res, req.params.id))) return;
    const rows = (
      await q('UPDATE app.file_folders SET name=$3 WHERE id=$1 AND engagement_id=$2 RETURNING *', [
        req.params.folderId,
        req.params.id,
        parsed.data.name,
      ])
    ).rows;
    if (!rows[0]) return void res.status(404).json({ error: 'Folder not found' });
    res.json(folderDto(rows[0]));
  });
  app.delete('/api/engagements/:id/folders/:folderId', async (req, res) => {
    if (!(await requireLead(req, res, req.params.id))) return;
    try {
      const rows = (
        await q('DELETE FROM app.file_folders WHERE id=$1 AND engagement_id=$2 RETURNING id', [
          req.params.folderId,
          req.params.id,
        ])
      ).rows;
      if (!rows[0]) return void res.status(404).json({ error: 'Folder not found' });
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Move or delete files, child folders, and rules first' });
    }
  });
  app.post('/api/engagements/:id/files', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    try {
      const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : '';
      const filename = cleanName(typeof req.query.filename === 'string' ? req.query.filename : '');
      const body = req.body as Buffer;
      if (!folderId || !Buffer.isBuffer(body) || body.length === 0)
        return void res.status(400).json({ error: 'Folder and non-empty file required' });
      const folder = (
        await q('SELECT 1 FROM app.file_folders WHERE id=$1 AND engagement_id=$2', [folderId, req.params.id])
      ).rows[0];
      if (!folder) return void res.status(404).json({ error: 'Folder not found' });
      const id = randomUUID();
      const path = `files/${req.params.id}/${folderId}/${id}-${filename}`;
      await files.upload(path, body, { overwrite: false });
      const who = await callerOf(req);
      await q(
        `INSERT INTO app.file_entries(id,engagement_id,folder_id,filename,size,content_type,sha256,uploader,storage_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          req.params.id,
          folderId,
          filename,
          body.length,
          req.headers['content-type'] ?? 'application/octet-stream',
          createHash('sha256').update(body).digest('hex'),
          who.email,
          path,
        ]
      );
      const fired = await runRules(q, req.params.id, folderId, id, filename, refineTicket);
      res.status(201).json({ id, filename, size: body.length, folderId, fired });
    } catch (err) {
      console.error('file upload failed:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });
  app.get('/api/engagements/:id/files/:fileId', async (req, res) => {
    try {
      const row = (
        await q('SELECT * FROM app.file_entries WHERE id=$1 AND engagement_id=$2', [req.params.fileId, req.params.id])
      ).rows[0];
      if (!row) return void res.status(404).json({ error: 'File not found' });
      const dl = await files.download(text(row.storage_path));
      if (!dl.contents) return void res.status(404).json({ error: 'File content missing' });
      const buf = Buffer.from(await new Response(dl.contents).arrayBuffer());
      res.setHeader('Content-Type', text(row.content_type) || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${text(row.filename)}"`);
      res.send(buf);
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  });
  app.delete('/api/engagements/:id/files/:fileId', async (req, res) => {
    if (!(await requireLead(req, res, req.params.id))) return;
    const row = (
      await q('DELETE FROM app.file_entries WHERE id=$1 AND engagement_id=$2 RETURNING storage_path', [
        req.params.fileId,
        req.params.id,
      ])
    ).rows[0];
    if (!row) return void res.status(404).json({ error: 'File not found' });
    try {
      await files.delete(text(row.storage_path));
    } catch (err) {
      console.warn('[files] volume delete failed:', (err as Error).message);
    }
    res.json({ ok: true });
  });
  app.post('/api/engagements/:id/file-rules', express.json(), async (req, res) => {
    const parsed = RuleBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid rule configuration' });
    if (!(await requireLead(req, res, req.params.id))) return;
    try {
      const d = parsed.data;
      const row = (
        await q(
          `INSERT INTO app.file_rules(id,engagement_id,name,folder_id,file_pattern,action_type,target_ticket,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            randomUUID(),
            req.params.id,
            d.name,
            d.folderId,
            d.filePattern,
            d.actionType,
            d.targetTicket ?? null,
            d.enabled ?? true,
          ]
        )
      ).rows[0];
      res.status(201).json(ruleDto(row));
    } catch {
      res.status(400).json({ error: 'Folder or target ticket is invalid' });
    }
  });
  app.delete('/api/engagements/:id/file-rules/:ruleId', async (req, res) => {
    if (!(await requireLead(req, res, req.params.id))) return;
    await q('DELETE FROM app.file_rules WHERE id=$1 AND engagement_id=$2', [req.params.ruleId, req.params.id]);
    res.json({ ok: true });
  });
}
