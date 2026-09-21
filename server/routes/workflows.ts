import { z } from 'zod';
import express from 'express';

/**
 * Workflows (DAT-288): the builder's drafts, stored centrally so the web, the
 * desktop and every user see the same workflows. A workflow is a name and a
 * graph — nodes (trigger / agent / condition / action) and directed edges.
 * Nothing here executes one; this is storage with the rules that keep a saved
 * graph well-formed: known node kinds, edges between real nodes, no loops.
 *
 * Saves are last-writer-wins with a guard: a save names the `updatedAt` it
 * was based on, and one based on a stale copy is refused (409) rather than
 * silently overwriting a colleague's change.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const WORKFLOWS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.workflows (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    graph JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    created_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export const NODE_KINDS = ['trigger', 'agent', 'condition', 'action'] as const;
export const MAX_NODES = 200;
export const MAX_EDGES = 400;

const NodeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(NODE_KINDS),
  title: z.string().max(120),
  detail: z.string().max(200),
  x: z.number().finite().min(0).max(100_000),
  y: z.number().finite().min(0).max(100_000),
});
const EdgeSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  label: z.string().max(40).optional(),
});
const GraphSchema = z.object({
  nodes: z.array(NodeSchema).max(MAX_NODES),
  edges: z.array(EdgeSchema).max(MAX_EDGES),
});
export type WorkflowGraph = z.infer<typeof GraphSchema>;

const NameSchema = z.string().trim().min(1).max(80);
const CreateBody = z.object({ name: NameSchema, graph: GraphSchema });
const SaveBody = z
  .object({ name: NameSchema.optional(), graph: GraphSchema.optional(), baseUpdatedAt: z.string().max(40).optional() })
  .refine((b) => b.name !== undefined || b.graph !== undefined, { message: 'Nothing to save' });

/**
 * What zod cannot say about a graph: node ids are unique, every edge joins two
 * real and different nodes, nothing feeds a trigger, no edge is repeated, and
 * the whole thing runs one way. Returns the first problem in plain words, or
 * null when the graph is sound.
 */
export function graphProblem(graph: WorkflowGraph): string | null {
  const kinds = new Map<string, string>();
  for (const n of graph.nodes) {
    if (kinds.has(n.id)) return `Two nodes share the id ${n.id}`;
    kinds.set(n.id, n.kind);
  }
  const seen = new Set<string>();
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!kinds.has(e.from) || !kinds.has(e.to)) return `A connection points at a node that is not in the workflow (${e.from} → ${e.to})`;
    if (e.from === e.to) return `${e.from} is connected to itself`;
    if (kinds.get(e.to) === 'trigger') return `Nothing can feed a trigger (${e.from} → ${e.to})`;
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) return `${e.from} → ${e.to} is connected twice`;
    seen.add(key);
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  // Depth-first search with the usual three colours: meeting a node that is
  // still on the stack means the path came back on itself.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'open') return true;
    state.set(id, 'open');
    for (const next of out.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 'done');
    return false;
  };
  for (const id of kinds.keys()) if (visit(id)) return 'The workflow loops back on itself — workflows run one way';
  return null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : str(v));

function graphFromRow(v: unknown): WorkflowGraph {
  let raw: unknown = v;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const parsed = GraphSchema.safeParse(raw);
  return parsed.success ? parsed.data : { nodes: [], edges: [] };
}

function workflowFromRow(r: Record<string, unknown>) {
  return { id: num(r.id), name: str(r.name), graph: graphFromRow(r.graph), updatedBy: str(r.updated_by), updatedAt: iso(r.updated_at), createdAt: iso(r.created_at) };
}

function requestAuthor(req: express.Request): string {
  const h = req.headers['x-forwarded-preferred-username'] ?? req.headers['x-forwarded-email'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && v.trim() ? v.trim() : 'You';
}

const idOf = (req: express.Request): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function setupWorkflowRoutes(app: express.Application, q: Query) {
  // The picker: every workflow, most recently touched first, without the graphs.
  app.get('/api/workflows', async (_req, res) => {
    try {
      const rows = (
        await q(`SELECT id, name, updated_by, updated_at, jsonb_array_length(COALESCE(graph->'nodes', '[]'::jsonb)) AS nodes FROM app.workflows ORDER BY updated_at DESC, id DESC`)
      ).rows;
      res.json(rows.map((r) => ({ id: num(r.id), name: str(r.name), nodes: num(r.nodes), updatedBy: str(r.updated_by), updatedAt: iso(r.updated_at) })));
    } catch (err) {
      console.error('workflows list failed:', err);
      res.status(500).json({ error: 'Failed to load workflows' });
    }
  });

  app.get('/api/workflows/:id', async (req, res) => {
    try {
      const id = idOf(req);
      const row = id === null ? undefined : (await q('SELECT * FROM app.workflows WHERE id = $1', [id])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      res.json(workflowFromRow(row));
    } catch (err) {
      console.error('workflow load failed:', err);
      res.status(500).json({ error: 'Failed to load the workflow' });
    }
  });

  app.post('/api/workflows', async (req, res) => {
    try {
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const problem = graphProblem(parsed.data.graph);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
      const who = requestAuthor(req);
      const row = (
        await q(`INSERT INTO app.workflows (name, graph, created_by, updated_by) VALUES ($1,$2,$3,$3) RETURNING *`, [parsed.data.name, JSON.stringify(parsed.data.graph), who])
      ).rows[0];
      console.log(`[workflows] ${who} created "${parsed.data.name}" (${parsed.data.graph.nodes.length} nodes)`);
      res.json(workflowFromRow(row));
    } catch (err) {
      console.error('workflow create failed:', err);
      res.status(500).json({ error: 'Failed to create the workflow' });
    }
  });

  app.put('/api/workflows/:id', async (req, res) => {
    try {
      const id = idOf(req);
      const parsed = SaveBody.safeParse(req.body);
      if (id === null || !parsed.success) {
        res.status(400).json({ error: id === null ? 'Bad workflow id' : parsed.error?.issues.map((i) => i.message).join('; ') });
        return;
      }
      if (parsed.data.graph) {
        const problem = graphProblem(parsed.data.graph);
        if (problem) {
          res.status(400).json({ error: problem });
          return;
        }
      }
      const current = (await q('SELECT updated_at, updated_by FROM app.workflows WHERE id = $1', [id])).rows[0];
      if (!current) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      if (parsed.data.baseUpdatedAt && iso(current.updated_at) !== parsed.data.baseUpdatedAt) {
        res.status(409).json({ error: `This workflow was saved elsewhere while you were editing (last by ${str(current.updated_by) || 'someone'}) — reloaded the latest version` });
        return;
      }
      const row = (
        await q(
          `UPDATE app.workflows SET name = COALESCE($2, name), graph = COALESCE($3::jsonb, graph), updated_by = $4, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [id, parsed.data.name ?? null, parsed.data.graph ? JSON.stringify(parsed.data.graph) : null, requestAuthor(req)],
        )
      ).rows[0];
      res.json(workflowFromRow(row));
    } catch (err) {
      console.error('workflow save failed:', err);
      res.status(500).json({ error: 'Failed to save the workflow' });
    }
  });

  app.delete('/api/workflows/:id', async (req, res) => {
    try {
      const id = idOf(req);
      const removed = id === null ? undefined : (await q('DELETE FROM app.workflows WHERE id = $1 RETURNING name', [id])).rows[0];
      if (!removed) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      console.log(`[workflows] ${requestAuthor(req)} deleted "${str(removed.name)}"`);
      res.json({ ok: true });
    } catch (err) {
      console.error('workflow delete failed:', err);
      res.status(500).json({ error: 'Failed to delete the workflow' });
    }
  });
}
