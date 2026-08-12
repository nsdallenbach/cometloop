import type express from 'express';
import { executeScopingTool, scopingToolDefs } from './scoping-tools';

/**
 * MCP endpoint (DAT-173): the delivery console's board tools served over the
 * MCP Streamable HTTP transport at POST /api/mcp. Because the console is a
 * Databricks App, this endpoint lives behind the workspace OAuth proxy — that
 * is what "registered in Databricks" means here: any workspace principal with
 * access to the app (model serving agents included) can list and call the
 * tools with a workspace token, no extra gateway. See
 * docs/mcp-databricks-registration.md for connecting agents to it.
 *
 * The transport is implemented directly (stateless JSON-RPC over POST) rather
 * than via the MCP SDK: four methods, no sessions, no server-initiated
 * streams — and no new runtime dependency in the app bundle. The stdio server
 * in mcp/ remains for desktop/devbox clients; both surface the same tool
 * contracts from scoping-tools.ts.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** Newest protocol revision this endpoint speaks; older clients get their own version echoed. */
const PROTOCOL_VERSION = '2025-06-18';
const KNOWN_VERSIONS = [PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function requestAuthor(req: express.Request): string {
  const h = req.headers['x-forwarded-preferred-username'] ?? req.headers['x-forwarded-email'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && v.trim() ? v.trim() : 'MCP client';
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (which get no response body). Exported for tests.
 */
export async function handleMcpMessage(q: Query, msg: JsonRpcRequest, author: string): Promise<Record<string, unknown> | null> {
  const method = typeof msg.method === 'string' ? msg.method : '';
  const hasId = msg.id !== undefined && msg.id !== null;
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  if (!hasId) return null; // notifications (e.g. notifications/initialized) need no reply

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcResult(msg.id, {
        protocolVersion: KNOWN_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'delivery-console', version: '1.0.0' },
        instructions:
          'Delivery Console board tools: search_tickets and get_ticket to read a board, link_tickets to record relationships, consolidate_tickets to merge duplicates. Engagement ids come from search_tickets calls; ticket keys look like DAT-42.',
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, {
        tools: scopingToolDefs().map((d) => ({ name: d.name, description: d.description, inputSchema: d.parameters })),
      });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const result = await executeScopingTool({ q, author, feedActor: 'YOU' }, name, args);
      return rpcResult(msg.id, {
        content: [{ type: 'text', text: JSON.stringify(result.ok ? result.data : { error: result.error }, null, 2) }],
        ...(result.ok ? {} : { isError: true }),
      });
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${method || '(none)'}`);
  }
}

export function setupMcpRoutes(app: express.Application, q: Query) {
  app.post('/api/mcp', async (req, res) => {
    try {
      const body: unknown = req.body;
      const author = requestAuthor(req);
      if (Array.isArray(body)) {
        const responses = (await Promise.all(body.map((m: JsonRpcRequest) => handleMcpMessage(q, m ?? {}, author)))).filter(
          (r): r is Record<string, unknown> => r !== null,
        );
        if (responses.length === 0) res.status(202).end();
        else res.json(responses);
        return;
      }
      if (!body || typeof body !== 'object') {
        res.status(400).json(rpcError(null, -32700, 'Parse error: expected a JSON-RPC message'));
        return;
      }
      const response = await handleMcpMessage(q, body as JsonRpcRequest, author);
      if (response === null) res.status(202).end();
      else res.json(response);
    } catch (err) {
      console.error('mcp request failed:', err);
      res.status(500).json(rpcError(null, -32603, 'Internal error'));
    }
  });

  // Stateless transport: no server-initiated SSE stream, no sessions to delete.
  app.get('/api/mcp', (_req, res) => {
    res.status(405).json(rpcError(null, -32000, 'This MCP endpoint is stateless — POST JSON-RPC messages to /api/mcp'));
  });
  app.delete('/api/mcp', (_req, res) => {
    res.status(405).json(rpcError(null, -32000, 'This MCP endpoint is stateless — no session to delete'));
  });
}
