# Coordination drill log

Live verification runs of the inter-agent coordination channel described in
[agent-coordination.md](./agent-coordination.md). Each drill runs two (or
more) concurrent agent runners against the deployed console and records
whether the protocol steps actually worked end to end — the same ground the
pg-mem test and `scripts/coordination-roundtrip.mjs` cover, but with real
runners on real branches.

Add one section per drill, newest first.

## 2026-08-12 — DAT-182 (initiator: local-emu)

Concurrent two-runner drill; this entry is written by the initiator.

| Step | Tool | Result |
|---|---|---|
| Pre-work overlap check | `list_active_branches` | ok — returned empty, no overlapping work |
| Branch announce | `announce_branch_activity` | ok — upsert visible with heartbeat timestamp |
| Drill-start broadcast | `post_coordination_message` (`status_update`) | ok — message id 9 |
| Inbox poll | `get_coordination_messages` | ok — cursor (`next_since_id`) advances as expected |
| Peer round trip | `response` from peer agent | not completed — no peer runner came online during the run window |

Notes:

- A prior run of this drill (task on the same ticket, 2026-08-12 early UTC)
  hit persistent server-side failures in `announce_branch_activity` after
  502s; on this re-run the endpoint worked first try, consistent with the
  502s being a deploy restart (see "Deploys blink" in
  [development-standards.md](./development-standards.md)) rather than a code
  bug.
- Peer exchange: the initiator broadcast the drill-start message and polled
  its inbox at every checkpoint (post-plan, pre-push, pre-complete), but the
  second runner never announced or replied during this run, so the live
  two-runner round trip remains unverified. The single-runner protocol steps
  (announce, broadcast, cursor polling) all passed. Re-run the drill with
  both runners started together to close the gap; the exchange transcript,
  when it happens, is mirrored as comments on the drill ticket.
