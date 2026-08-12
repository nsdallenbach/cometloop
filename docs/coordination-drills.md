# Coordination drills

Live exercises of the inter-agent coordination channel
(see [agent-coordination.md](./agent-coordination.md)) between concurrent
runners. Each drill runs two agents against the same repo at the same time and
verifies the protocol end to end: branch announcement, targeted messages with
SLAs, checkpoint polling, and ticket mirroring.

## Drill log

### 2026-08-12 — DAT-183 (responder: `local-emu`)

Concurrent two-runner drill on the live channel.

Responder-side checklist exercised in this run:

- [x] `list_active_branches` checked before branching (no overlapping work).
- [x] Branch `DAT-183-coord-drill-responder` announced via
      `announce_branch_activity` immediately after creation.
- [x] `get_coordination_messages` polled at checkpoints (post-plan, pre-push,
      pre-complete) with the `next_since_id` cursor.
- [x] Targeted requests answered per SLA (`interrupt` before continuing,
      `wait` before completing) with `post_coordination_message` type
      `response`.
- [x] Final `status_update` (branch + PR URL) posted before completion.

Message traffic for the drill is durably recorded in
`app.coordination_messages` and mirrored onto the DAT-183 ticket for human
review.

### 2026-08-12 — DAT-183 run #2 (responder: `local-emu-2`)

Second concurrent drill run. The first run's runner exited without writing a
completion summary, so this run adopted the existing branch and PR (#48)
instead of duplicating them.

Responder-side protocol exercised in this run:

- [x] `list_active_branches` checked before branching (no active overlapping
      work; existing remote branch + open PR #48 adopted rather than forked).
- [x] Branch re-announced via `announce_branch_activity` under agent
      `local-emu-2`.
- [x] Channel backlog drained from cursor 0; a pending targeted
      `request_for_info` from `local-emu` (message id 7) was answered with a
      `response` before continuing — no unanswered targeted requests left
      behind by the failed run #1.
- [x] `get_coordination_messages` polled at checkpoints (post-plan, pre-push,
      pre-complete) with the `next_since_id` cursor.
- [x] Final `status_update` (branch + PR URL) posted before completion.

Observed in run #1 (initiator side, DAT-182): the peer runner was not online
during the initiator's window, so the live two-runner round trip depends on
both runners genuinely overlapping. Run #2 keeps the responder online and
polling to give the concurrent initiator a live peer.
