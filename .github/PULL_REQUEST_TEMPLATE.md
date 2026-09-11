<!-- Branch or title must contain the ticket key (DAT-123) — that is what
     auto-links the PR and drives ticket automation. -->

## What & why

<!-- One or two sentences. Link the ticket. -->

## Validation

- [ ] `npm run typecheck && npm run lint && npm run build` from a clean state
      (what CI runs — see docs/development-standards.md)

## Cross-platform parity

<!-- Applies to any change touching shared UI/UX: `shared/design/`,
     `desktop/src/renderer/`, or client idioms native views mirror (tokens,
     markdown rendering, toasts, theme, fonts). Process:
     docs/cross-platform-parity.md -->

- [ ] No shared UI/UX change (webview-embedded console features and
      platform-exclusive surfaces count as "no")
- [ ] Shared change, **implemented on both platforms** — tracker row updated
      in this PR (`docs/feature-parity-tracker.md`)
- [ ] Shared change, **one platform only** — `parity-gap` ticket filed:
      `DAT-___`, and recorded in the tracker row
