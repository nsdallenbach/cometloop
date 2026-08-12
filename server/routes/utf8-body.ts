import type express from 'express';

/**
 * Strict UTF-8 ingestion with legacy-codepage recovery (DAT-198).
 *
 * Root cause of the board's mojibake: AppKit mounts a global express.json()
 * before app extensions run, and body-parser silently decodes invalid UTF-8
 * bytes to U+FFFD. Clients that encode JSON bodies in the OS legacy codepage
 * (observed: Windows-1252 from PowerShell tooling — em dash becomes byte
 * 0x97, the arrow becomes '?') therefore corrupt every non-ASCII character
 * at parse time, before any route or zod validator ever sees the text.
 * Postgres and the React client are UTF-8-clean; the damage is done at the
 * HTTP boundary.
 *
 * The fix decodes explicitly at that boundary: read the raw bytes, try
 * strict UTF-8 (TextDecoder fatal mode — the well-formed fast path), and
 * fall back to Windows-1252 when the bytes are not valid UTF-8. Every byte
 * is defined in Windows-1252, so the fallback is lossless and recovers the
 * characters the client actually meant (0x97 is an em dash again). The
 * middleware is spliced ahead of AppKit's parser in the express stack;
 * body-parser then skips the request because the body is already read
 * (`req._body`).
 */

/** Matches AppKit's express.json bodyLimit default of '1mb'. */
export const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const windows1252 = new TextDecoder('windows-1252');

/** Decode request-body bytes: strict UTF-8, with Windows-1252 recovery for invalid sequences. */
export function decodeBodyBytes(buf: Uint8Array): { text: string; recovered: boolean } {
  try {
    return { text: strictUtf8.decode(buf), recovered: false };
  } catch {
    return { text: windows1252.decode(buf), recovered: true };
  }
}

/** U+FFFD replacement chars or lone surrogate halves — the fingerprints of lossy decoding. */
export function hasMojibake(text: string): boolean {
  return /�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

// Reverse Windows-1252 map (char code → byte), built from the decoder itself
// so the two directions can never disagree.
let cp1252Reverse: Map<number, number> | null = null;
function reverseCp1252(): Map<number, number> {
  if (!cp1252Reverse) {
    cp1252Reverse = new Map();
    for (let byte = 0; byte < 256; byte++) cp1252Reverse.set(windows1252.decode(new Uint8Array([byte])).charCodeAt(0), byte);
  }
  return cp1252Reverse;
}

// Continuation-byte faces: bytes 0x80-0xBF as Windows-1252 renders them.
let continuationFaces: Set<number> | null = null;
function isCp1252ContinuationFace(code: number): boolean {
  if (!continuationFaces) {
    continuationFaces = new Set();
    for (let byte = 0x80; byte <= 0xbf; byte++) continuationFaces.add(windows1252.decode(new Uint8Array([byte])).charCodeAt(0));
  }
  return continuationFaces.has(code);
}

/**
 * Classic double-encoding lead-in: a UTF-8 lead byte read as Windows-1252
 * (0xC2/0xC3/0xE2 — the leads of Latin-1 letters and general punctuation,
 * rendered A-circumflex / A-tilde / a-circumflex) followed by a continuation
 * byte's cp1252 face. Deliberately conservative: only these three leads, so
 * text that legitimately contains stray accented capitals is never touched.
 */
function hasDoubleEncodingSignature(text: string): boolean {
  for (let i = 0; i < text.length - 1; i++) {
    const c = text.charCodeAt(i);
    if ((c === 0xc2 || c === 0xc3 || c === 0xe2) && isCp1252ContinuationFace(text.charCodeAt(i + 1))) return true;
  }
  return false;
}

/**
 * Repair text that was UTF-8 encoded and then mis-decoded as Windows-1252
 * ("Ã©" back to é, "â€™" back to a right single quote). Returns null when
 * the text does not carry the double-encoding signature or does not
 * round-trip to valid UTF-8 — callers must treat null as "leave it alone".
 */
export function repairDoubleEncoding(text: string): string | null {
  if (!hasDoubleEncodingSignature(text)) return null;
  const reverse = reverseCp1252();
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const byte = reverse.get(text.charCodeAt(i));
    if (byte === undefined) return null; // char outside Windows-1252 — not a cp1252 mis-decode
    bytes[i] = byte;
  }
  try {
    const repaired = strictUtf8.decode(bytes);
    return repaired === text ? null : repaired;
  } catch {
    return null;
  }
}

/**
 * Code-unit truncation that never strands half a surrogate pair — a bare
 * `.slice(0, n)` can cut an emoji in two, and the lone surrogate becomes
 * U+FFFD the moment it is serialized to the database or a JSON response.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function jsonRecoveryHandler(limitBytes: number): express.RequestHandler {
  return function utf8JsonRecovery(req, res, next) {
    const flagged = req as unknown as { _body?: boolean };
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (
      flagged._body === true || // another parser already read the stream
      !contentType.includes('json') || // mirror AppKit's json type matcher
      !req.path.startsWith('/api/') || // app API only; static/health untouched
      req.headers['content-encoding'] !== undefined // compressed — leave to the stock parser
    ) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let overflow = false;
    req.on('data', (chunk: Buffer) => {
      if (overflow) return;
      received += chunk.length;
      if (received > limitBytes) {
        overflow = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    });
    req.on('error', next);
    req.on('end', () => {
      if (overflow) {
        res.status(413).json({ error: 'Request body too large' });
        return;
      }
      flagged._body = true; // downstream body-parser: already read
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        req.body = {}; // body-parser's empty-body behavior
        next();
        return;
      }
      const { text, recovered } = decodeBodyBytes(buf);
      if (recovered) {
        console.warn(`[utf8-body] ${req.method} ${req.path}: body was not valid UTF-8 — recovered as Windows-1252`);
      }
      const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip a UTF-8 BOM
      // Stock parser is strict: a JSON body must be an object or array.
      if (!/^\s*[{[]/.test(body)) {
        res.status(400).json({ error: 'Request body must be a JSON object or array' });
        return;
      }
      try {
        req.body = JSON.parse(body) as unknown;
      } catch {
        res.status(400).json({ error: 'Request body is not valid JSON' });
        return;
      }
      next();
    });
  };
}

interface RouterLayer {
  name: string;
}

/**
 * Mount the recovery middleware and splice it ahead of the stock jsonParser
 * layer so it owns the raw bytes. Express offers no "insert before" API, so
 * this reaches into the router stack (express 4: `app._router.stack`; the
 * layer name `jsonParser` is body-parser's exported function name). Fails
 * open: when the stack or parser layer cannot be found, the middleware stays
 * where it was mounted — behind the stock parser, where `req._body` makes it
 * a no-op — and body handling is exactly what it was before this module.
 */
export function installUtf8BodyRecovery(app: express.Application, limitBytes: number = JSON_BODY_LIMIT_BYTES): void {
  app.use(jsonRecoveryHandler(limitBytes));
  const holder = app as unknown as { _router?: { stack: RouterLayer[] }; router?: { stack: RouterLayer[] } };
  const stack = holder._router?.stack ?? holder.router?.stack;
  if (!stack || stack.length === 0) {
    console.warn('[utf8-body] express router stack not found — UTF-8 recovery inactive');
    return;
  }
  const jsonIdx = stack.findIndex((layer) => layer.name === 'jsonParser');
  if (jsonIdx === -1 || jsonIdx >= stack.length - 1) {
    console.warn('[utf8-body] stock JSON parser layer not found — UTF-8 recovery inactive');
    return;
  }
  const mounted = stack.pop();
  if (mounted) stack.splice(jsonIdx, 0, mounted);
}
