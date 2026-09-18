# Cross-platform feature parity tracker

Status of every shared-by-design UI/UX feature across the **web console**
(`client/`) and the **desktop app** (`desktop/`). The process that keeps this
file honest — when to update it, how gaps become tickets, who re-audits — is
[cross-platform-parity.md](./cross-platform-parity.md). Update this table in
the same PR as the change it describes.

**Status values**

- ✅ **OK** — implemented and consistent on this platform
- 🟡 **At risk** — works today, but duplicated by hand (drift is one edit away)
- 🔴 **Gap** — missing or inconsistent on this platform; must have a gap ticket
- ➖ **N/A** — intentionally not on this platform (see parity class)

**Parity classes** (defined in the process doc)

- **By construction** — one implementation serves both platforms (the desktop
  Tickets tab embeds the deployed web app; `shared/design/tokens.css`).
  Nothing to track per-feature; listed so nobody re-audits them by hand.
- **Shared by design** — implemented separately on each platform and expected
  to match. This is the surface this tracker exists for.
- **Platform-exclusive** — deliberately one-platform (e.g. the web app never
  gets a path into anyone's laptop; the desktop never re-implements the board).

## Design system & UX idioms (shared by design)

| Feature | Web | Desktop | Class | Last reviewed | Notes / gap ticket |
| --- | --- | --- | --- | --- | --- |
| Design tokens, dark (`--bg/--tx/--acc/…`) | 🟡 | ✅ | Shared by design | 2026-08-26 | Desktop imports `shared/design/tokens.css`; web still carries its own copy in `client/src/index.css` (flagged in the tokens file since DAT-226). Values match today — verified by diff — but every token edit must be made twice. **Gap ticket needed: rewire `client/` to import the shared sheet.** |
| Design tokens, light | 🟡 | 🔴 | Shared by design | 2026-08-26 | Same duplication as above, plus the desktop never applies them (see theme toggle row). |
| Theme toggle (dark/light, persisted) | ✅ | 🔴 | Shared by design | 2026-08-26 | Web toggles + persists `eec-theme`; desktop hardcodes `data-theme="dark"` in `desktop/src/renderer/index.html`. The shared token sheet already ships light values, so this is UI wiring only. **Gap ticket needed.** |
| Fonts (DM Sans / DM Mono via Google Fonts) | ✅ | ✅ | Shared by design | 2026-08-26 | Same `<link>` in `client/index.html` and `desktop/src/renderer/index.html`, same weights. |
| `eec-*` keyframes + `hv-*` microinteractions | 🟡 | ✅ | Shared by design | 2026-08-26 | Desktop gets them from `shared/design/tokens.css`; web has its own copy in `index.css`. Rolls up into the token-sheet rewire ticket. |
| `mono()` style helper | 🟡 | 🟡 | Shared by design | 2026-08-26 | `client/src/util.ts` and a hand-copied mirror at the top of `desktop/src/renderer/src/App.tsx`. Candidate for `shared/design/` once the token rewire lands. |
| Markdown rendering (comments, notes, instructions) | ✅ | 🔴 | Shared by design | 2026-08-26 | Web renders all markdown through the `Markdown` component (marked + DOMPurify, per development standards). Desktop-native views (Agents queue cards) print `instructions` and `last_note` as raw text, so agent-authored markdown shows literal `**` and bullets. **Gap ticket needed.** |
| Toast / notification idiom | ✅ | 🔴 | Shared by design | 2026-08-26 | Web has `NotificationCenter` plus optimistic-mutation toasts; desktop-native views surface errors as inline strings only. Decide: adopt a toast idiom in native views, or accept inline errors and reclassify ➖. **Needs an owner decision + ticket either way.** |
| Custom scrollbar styling | ✅ | ✅ | Shared by design | 2026-08-26 | Both styled; web scopes under `.eec`, desktop styles globally. Cosmetically consistent. |
| Card/row visual language (left accent border, mono chips, state colors) | ✅ | ✅ | Shared by design | 2026-08-26 | Desktop task/deploy cards follow the console card idiom (state color border-left, `mono()` chips). Keep matching by eye until components move to `shared/`. |

## Feature surfaces

| Feature | Web | Desktop | Class | Last reviewed | Notes |
| --- | --- | --- | --- | --- | --- |
| Tickets board (canvas: zones, links, agent traffic), drawer, planning, palette, notifications | ✅ | ✅ | By construction | 2026-09-17 | Desktop Tickets tab is a `<webview>` of the deployed web app with the dev's token injected — full parity with zero duplicated UI. Anything shipped in `client/` is on desktop the moment it deploys. Caveat: it shows the *deployed* bundle, not local builds. |
| Board card motion (Motion springs to derived canvas positions) | ✅ | ✅ | By construction | 2026-09-17 | Lives entirely in the web app; reaches desktop through the webview. |
| Deploys | ✅ (read-only mirror) | ✅ (executor) | Shared by design (asymmetric) | 2026-08-26 | Intentionally asymmetric: deploys run on the dev's machine with their identity; the web renders a read-only mirror from events. The *asymmetry* is the design — track that both halves stay in step when deploy states/fields change. |
| Agents management (instances, feeds, run/kill) | ➖ | ✅ | Platform-exclusive | 2026-08-26 | "Native-app exclusive — the web console never gets a path into anyone's laptop." |
| Interactive terminal (DAT-240) | ➖ | ✅ | Platform-exclusive | 2026-08-26 | Requires local PTY. |
| Identity (Databricks OAuth, gh/az/ADO device flows, MCP secrets) | ➖ | ✅ | Platform-exclusive | 2026-08-26 | Local keychain by design. |
| Managed file sync | ➖ | 🟡 | Platform-exclusive | 2026-08-26 | Desktop placeholder ("coming in a later phase"); manifest editing is planned to live in the console. Revisit the classification when it lands. |
| Portfolio, roadmap, analytics, standards, admin | ✅ | ✅ | By construction | 2026-08-26 | Via the embedded console. |

## Known gaps (seeded by the initial audit, 2026-08-26)

Each needs a ticket tagged `parity-gap` (see the process doc for the
convention); record the ticket key in the table row when filed.

1. **Token sheet duplication** — rewire `client/src/index.css` to import
   `shared/design/tokens.css` and delete the copied blocks (the DAT-226
   follow-up that never got a ticket). Fold the `eec-*`/`hv-*` copies and the
   `mono()` mirror into the same work.
2. **Desktop light theme** — add the theme toggle to the desktop shell;
   tokens already exist in the shared sheet.
3. **Desktop markdown rendering** — render `instructions`/`last_note` (and any
   future rich text in native views) through a shared or ported `Markdown`
   component instead of raw text.
4. **Desktop notification idiom** — decide toast adoption vs. accepting inline
   errors; implement or reclassify.
