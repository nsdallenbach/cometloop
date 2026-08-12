import { z } from 'zod';
import type express from 'express';
import type { FilesVolume } from './context-files';

/**
 * Tool-call telemetry from agent runs. Runners parse Claude Code's stream-json
 * output and batch-post each tool_use event here; the console shows the feed
 * live in the ticket drawer (deliberately NOT as ticket comments — a run makes
 * hundreds of calls) and, when the run finishes, archives the full log as
 * NDJSON to the agent_telemetry UC volume for offline analysis.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const TOOL_CALL_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.agent_tool_calls (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL REFERENCES app.agent_tasks(id) ON DELETE CASCADE,
    ticket_key TEXT NOT NULL,
    engagement_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    tool TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    called_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS agent_tool_calls_task ON app.agent_tool_calls (task_id, id)`,
];

const ToolCallsBody = z.object({
  agent: z.string().min(1).max(80),
  calls: z
    .array(
      z.object({
        tool: z.string().min(1).max(120),
        detail: z.string().max(600).optional(),
        ts: z.string().max(40).optional(),
      }),
    )
    .min(1)
    .max(200),
});

/** Keep one runaway run from filling the table; the drawer only shows a tail anyway. */
const MAX_CALLS_PER_TASK = 10_000;

const txt = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Volume path for one task's archived log: one NDJSON file per run. */
export function archivePath(task: Record<string, unknown>): string {
  return `tool-calls/${txt(task.engagement_id)}/${txt(task.ticket_key)}/task-${txt(task.id)}.ndjson`;
}

/** Serialize stored tool-call rows as NDJSON for the telemetry volume. */
export function toNdjson(task: Record<string, unknown>, rows: Record<string, unknown>[]): string {
  return (
    rows
      .map((r) =>
        JSON.stringify({
          task_id: Number(task.id),
          ticket_key: txt(task.ticket_key),
          engagement_id: txt(task.engagement_id),
          agent: txt(r.agent),
          tool: txt(r.tool),
          detail: txt(r.detail),
          called_at: r.called_at instanceof Date ? r.called_at.toISOString() : txt(r.called_at),
        }),
      )
      .join('\n') + '\n'
  );
}

/**
 * Archive a finished (or cancelled) run's tool-call log to the telemetry
 * volume. Best-effort: the rows stay in Postgres regardless, so a failed
 * upload only costs the offline copy. No-op when the volume isn't provisioned.
 */
export async function archiveToolCalls(q: Query, telemetry: FilesVolume | null, taskId: number): Promise<void> {
  if (!telemetry) return;
  try {
    const task = (await q('SELECT id, ticket_key, engagement_id FROM app.agent_tasks WHERE id = $1', [taskId])).rows[0];
    if (!task) return;
    const rows = (await q('SELECT agent, tool, detail, called_at FROM app.agent_tool_calls WHERE task_id = $1 ORDER BY id', [taskId])).rows;
    if (rows.length === 0) return;
    const path = archivePath(task);
    await telemetry.upload(path, Buffer.from(toNdjson(task, rows), 'utf8'), { overwrite: true });
    console.log(`[agent] archived ${rows.length} tool call(s) for task ${taskId} → ${path}`);
  } catch (err) {
    console.warn(`[agent] tool-call archive failed for task ${taskId}:`, (err as Error).message);
  }
}

export function setupToolCallRoutes(app: express.Application, q: Query) {
  /**
   * Runner side: append a batch of tool-call events to the active run.
   * Doubles as a liveness signal, so long tool-heavy stretches without a
   * progress note don't trip the board's STALLED detector.
   */
  app.post('/api/agent/work/:id/tool-calls', async (req, res) => {
    const parsed = ToolCallsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent and calls (1-200 events) are required' });
      return;
    }
    try {
      const task = (
        await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])
      ).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active task with this id' });
        return;
      }
      if (String(task.agent) !== parsed.data.agent) {
        res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
        return;
      }
      const stored = (await q('SELECT COUNT(*)::int AS n FROM app.agent_tool_calls WHERE task_id = $1', [task.id])).rows[0];
      const room = MAX_CALLS_PER_TASK - Number(stored?.n ?? 0);
      const calls = parsed.data.calls.slice(0, Math.max(0, room));
      for (const c of calls) {
        const ts = c.ts && !isNaN(Date.parse(c.ts)) ? new Date(c.ts) : new Date();
        await q(
          `INSERT INTO app.agent_tool_calls (task_id, ticket_key, engagement_id, agent, tool, detail, called_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [task.id, String(task.ticket_key), String(task.engagement_id), parsed.data.agent, c.tool, c.detail?.trim() ?? '', ts],
        );
      }
      await q(`UPDATE app.agent_tasks SET last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`, [task.id]);
      res.json({ ok: true, stored: calls.length, dropped: parsed.data.calls.length - calls.length });
    } catch (err) {
      console.error('tool-call ingest failed:', err);
      res.status(500).json({ error: 'Failed to record tool calls' });
    }
  });

  /**
   * Console side: the ticket drawer polls this while a run is active. Returns
   * the latest run's feed for the ticket; `after=<id>` makes the poll
   * incremental so a long run doesn't re-ship its whole history every tick.
   */
  app.get('/api/tickets/:key/tool-calls', async (req, res) => {
    try {
      const task = (
        await q(`SELECT id, state FROM app.agent_tasks WHERE ticket_key = $1 ORDER BY id DESC LIMIT 1`, [req.params.key])
      ).rows[0];
      if (!task) {
        res.json({ task_id: null, state: null, calls: [] });
        return;
      }
      const after = Number(req.query.after);
      const params: unknown[] = [task.id];
      let where = 'task_id = $1';
      if (Number.isFinite(after) && after > 0) {
        params.push(after);
        where += ` AND id > $${params.length}`;
      }
      const calls = (
        await q(`SELECT id, agent, tool, detail, called_at FROM app.agent_tool_calls WHERE ${where} ORDER BY id LIMIT 1000`, params)
      ).rows;
      res.json({ task_id: Number(task.id), state: String(task.state), calls });
    } catch (err) {
      console.error('tool-call read failed:', err);
      res.status(500).json({ error: 'Failed to load tool calls' });
    }
  });
}
