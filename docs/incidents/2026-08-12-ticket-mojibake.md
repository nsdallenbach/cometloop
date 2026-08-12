# Incident: mojibake (�) in ticket titles and descriptions — 2026-08-12

**Ticket:** DAT-198 · **Symptom:** replacement characters (`�`) and stray `?`
appearing in ticket titles and content on the board.

## Root cause

Some clients posted JSON ticket bodies encoded in **Windows-1252** (the
Windows legacy codepage) without a charset declaration. Observed on tickets
DAT-191, DAT-192, DAT-193, DAT-194 and DAT-197, which were created with
explicit titles/descriptions through the REST API (not the console chatbox);
the fingerprint is unambiguous:

- `—` (em dash, U+2014) became a **single `�`** — Windows-1252 encodes it as
  byte `0x97`, which is invalid UTF-8, so the server's JSON parser replaced
  it with U+FFFD.
- `→` (U+2192) became **`?`** — it has no Windows-1252 mapping at all, so the
  *client's* encoder substituted a literal question mark before the bytes
  ever left the machine.

The server side of the bug: AppKit mounts a global `express.json()` and
body-parser decodes bodies as UTF-8 **non-strictly** — invalid bytes turn
into U+FFFD silently, with no error and no log line. Everything downstream
(zod, Postgres `TEXT` columns, the React client) is UTF-8-clean and faithfully
stored/rendered the already-corrupted text. The console chatbox flow was never
affected (browsers always send well-formed UTF-8), which is why chatbox
tickets like DAT-188/195/196 kept their em dashes intact.

The likely mis-encoding client: PowerShell tooling in agent/lead chat
sessions (`Set-Content`/`Out-File` default to the ANSI codepage on Windows
PowerShell, and older `Invoke-RestMethod` versions do not default string
bodies to UTF-8).

## Fix (server, `server/routes/utf8-body.ts`)

1. **Strict UTF-8 decode at the ingestion boundary** for `/api/*` JSON
   bodies, spliced ahead of AppKit's parser: well-formed UTF-8 (the normal
   case) parses exactly as before; bodies with invalid UTF-8 are re-decoded
   as Windows-1252 — lossless, recovering the intended characters — and the
   recovery is logged (`[utf8-body] … recovered as Windows-1252`).
2. **Surrogate-safe truncation** (`clipText`) for every title/reply
   truncation site, so a `slice()` boundary can no longer cut an emoji in
   half and produce a lone surrogate (a second, latent source of `�`).

## Historical data

`scripts/fix-mojibake.cjs` scans ticket titles, descriptions, acceptance
criteria and comments:

- **Unrecoverable** damage (`�` from invalid bytes, `?` already substituted
  client-side) cannot be reconstructed — the script lists those rows and
  `--flag` tags the tickets `encoding-corrupt` for manual follow-up.
- **Recoverable** damage (UTF-8 mis-read as Windows-1252, e.g. `â€™` where a
  `’` belongs — the reverse direction of this incident) is repaired in place
  with `--repair`.

## Prevention

- Regression tests (`server/routes/utf8-body.test.ts`) drive real HTTP
  requests through AppKit's exact middleware order with emoji/accented UTF-8
  bodies and with the Windows-1252 byte pattern from this incident.
- Anyone scripting against the API from Windows: send bodies as UTF-8 bytes
  (`curl.exe --data-binary` with a UTF-8 file, or `Invoke-RestMethod` with
  `-ContentType 'application/json; charset=utf-8'` on PowerShell 7). The
  server now tolerates the legacy codepage, but `→`/emoji still cannot
  survive a client-side Windows-1252 encode — only UTF-8 carries them.
