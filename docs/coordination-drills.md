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
