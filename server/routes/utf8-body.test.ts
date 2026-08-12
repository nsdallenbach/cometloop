import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { clipText, decodeBodyBytes, hasMojibake, installUtf8BodyRecovery, repairDoubleEncoding } from './utf8-body';

/**
 * DAT-198 regression suite: non-ASCII ticket text must survive ingestion.
 *
 * The integration block reproduces AppKit's exact mounting order (global
 * express.json() first, extensions after) and drives real HTTP requests
 * through it — a UTF-8 body with emoji/accents, and the Windows-1252 body
 * shape that produced the board's mojibake (em dash as byte 0x97).
 */

const EM_DASH = '—';
const E_ACUTE = 'é';

describe('decodeBodyBytes', () => {
  it('decodes well-formed UTF-8 losslessly (emoji, accents, dashes)', () => {
    const text = `Caf${E_ACUTE} rocket \u{1F680} ${EM_DASH} ¡hola! 你好`;
    const { text: decoded, recovered } = decodeBodyBytes(Buffer.from(text, 'utf8'));
    expect(decoded).toBe(text);
    expect(recovered).toBe(false);
  });

  it('recovers Windows-1252 bytes instead of writing U+FFFD', () => {
    // "KPIs <em dash> caf<e acute>" as cp1252: — is 0x97, é is 0xE9.
    const bytes = Buffer.concat([Buffer.from('KPIs '), Buffer.from([0x97]), Buffer.from(' caf'), Buffer.from([0xe9])]);
    const { text, recovered } = decodeBodyBytes(bytes);
    expect(text).toBe(`KPIs ${EM_DASH} caf${E_ACUTE}`);
    expect(recovered).toBe(true);
    expect(hasMojibake(text)).toBe(false);
  });
});

describe('hasMojibake', () => {
  it('flags U+FFFD and lone surrogates, passes healthy text', () => {
    expect(hasMojibake('Analytics � KPIs')).toBe(true);
    expect(hasMojibake('broken \uD83D end')).toBe(true); // lone high surrogate
    expect(hasMojibake('\uDE80 orphan low')).toBe(true);
    expect(hasMojibake(`clean \u{1F680} ${EM_DASH} caf${E_ACUTE}`)).toBe(false);
  });
});

describe('repairDoubleEncoding', () => {
  it('repairs classic UTF-8-read-as-cp1252 sequences', () => {
    // '’' (U+2019) mis-decoded: bytes E2 80 99 seen as cp1252 => "â€™"
    expect(repairDoubleEncoding('doesnâ€™t work')).toBe('doesn’t work');
    // 'é' mis-decoded: bytes C3 A9 seen as cp1252 => "Ã©"
    expect(repairDoubleEncoding('cafÃ©')).toBe(`caf${E_ACUTE}`);
  });

  it('returns null for healthy text and for unrepairable text', () => {
    expect(repairDoubleEncoding(`caf${E_ACUTE} ${EM_DASH} fine`)).toBe(null);
    expect(repairDoubleEncoding('plain ascii')).toBe(null);
    // Signature present but the rest of the string is not cp1252-mappable.
    expect(repairDoubleEncoding('Ã© with emoji \u{1F680}')).toBe(null);
    // U+FFFD damage is lossy; there is nothing to reconstruct.
    expect(repairDoubleEncoding('Analytics � KPIs')).toBe(null);
  });
});

describe('clipText', () => {
  it('never strands half a surrogate pair', () => {
    const text = `abc\u{1F680}`; // 5 UTF-16 code units, emoji occupies the last two
    expect(clipText(text, 4)).toBe('abc'); // a bare slice(0, 4) would keep the lone high surrogate
    expect(clipText(text, 5)).toBe(text);
    expect(clipText('short', 80)).toBe('short');
    expect(hasMojibake(JSON.parse(JSON.stringify(clipText(text, 4))) as string)).toBe(false);
  });
});

describe('ingestion round trip (AppKit mounting order)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    // Mirror AppKit's ServerPlugin.start(): global json parser first...
    app.use(express.json({ limit: '1mb', type: (req) => String(req.headers['content-type'] ?? '').includes('json') }));
    // ...then app extensions; the recovery layer splices itself ahead.
    installUtf8BodyRecovery(app, 4096);
    app.post('/api/echo', (req, res) => res.json({ body: req.body as unknown }));
    app.post('/outside', (req, res) => res.json({ body: req.body as unknown }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (path: string, body: string | Buffer, contentType = 'application/json') =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': contentType }, body });

  it('keeps emoji and accents intact through a well-formed UTF-8 request', async () => {
    const payload = { title: `Rocket \u{1F680} caf${E_ACUTE} ${EM_DASH} über`, description: `→ arrows ✓` };
    const res = await post('/api/echo', JSON.stringify(payload));
    expect(res.status).toBe(200);
    const { body } = (await res.json()) as { body: typeof payload };
    expect(body).toEqual(payload);
    expect(hasMojibake(JSON.stringify(body))).toBe(false);
  });

  it('recovers a Windows-1252 body instead of storing U+FFFD (the DAT-198 corruption)', async () => {
    // {"title":"KPIs <0x97> caf<0xE9>"} encoded the way legacy Windows tooling sends it.
    const cp1252 = Buffer.concat([
      Buffer.from('{"title":"KPIs '),
      Buffer.from([0x97]),
      Buffer.from(' caf'),
      Buffer.from([0xe9]),
      Buffer.from('"}'),
    ]);
    const res = await post('/api/echo', cp1252);
    expect(res.status).toBe(200);
    const { body } = (await res.json()) as { body: { title: string } };
    expect(body.title).toBe(`KPIs ${EM_DASH} caf${E_ACUTE}`);
    expect(hasMojibake(body.title)).toBe(false);
  });

  it('still parses non-/api routes with the stock parser (and its U+FFFD behavior)', async () => {
    const res = await post('/outside', JSON.stringify({ ok: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { body: { ok: boolean } }).body.ok).toBe(true);
  });

  it('rejects malformed JSON with a JSON error, not a crash', async () => {
    const res = await post('/api/echo', '{"broken": ');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/JSON/);
  });

  it('rejects non-object JSON bodies (strict mode, like body-parser)', async () => {
    const res = await post('/api/echo', '"just a string"');
    expect(res.status).toBe(400);
  });

  it('answers 413 for oversized bodies', async () => {
    const res = await post('/api/echo', JSON.stringify({ big: 'x'.repeat(8192) }));
    expect(res.status).toBe(413);
  });

  it('treats an empty body as an empty object', async () => {
    const res = await post('/api/echo', '');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { body: unknown }).body).toEqual({});
  });
});
