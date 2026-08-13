# Steering agents with ticket comments (DAT-146 validation)

DAT-146 asked whether the LLM working a queued ticket can read ticket comments
as context, whether leads can steer a run via comments, and whether a runner
can be triggered to pick up rework from the review queue. Findings and the
changes that closed the gaps:

## What already worked

- **Comments ship in the work package.** `workPackage()` in
  `server/routes/agent-work.ts` selects the ticket's comments and the runner
  writes them into `work-package.json`, so they were always *available* to the
  agent on disk.
- **Comments are readable mid-run.** The `get_ticket` MCP tool returns the
  live comment list; validated during the DAT-146 run itself — the agent
  fetched its own ticket over MCP and saw comments posted after claim.
- **The write side was already wired.** Runner progress notes, flags and
  completions are inserted into `app.ticket_comments`, so a ticket's comment
  thread is a two-way channel.

## What was missing (fixed by DAT-146)

1. **Comments never reached the prompt.** `renderPrompt()` rendered the
   description, acceptance criteria and lead instructions but not comments —
   the LLM was never told they exist. The prompt now includes a
   `## Ticket comments` section (newest 20, bodies capped at 1500 chars, with
   author and timestamp) and tells the agent to treat lead/teammate comments
   as steering.
2. **No mid-run steering loop.** Nothing told the agent to look at comments
   again after claim. The prompt's delivery expectations now instruct the
   agent to re-read comments with `get_ticket` before pushing and apply any
   guidance posted while it worked.
3. **Review tickets could not be re-queued.** `POST /api/tickets/:key/queue`
   rejected tickets outside `backlog`/`progress`, so a lead could not send a
   Review ticket back to a runner. Review is now queueable: post the review
   feedback as comments, queue the ticket (board lane, drawer, or the
   `queue_ticket_for_agent` MCP tool), and the next runner claims it with the
   feedback in its prompt.

## The steering loop

1. Lead queues a ticket; any pre-existing comments render into the prompt.
2. Runner claims, works, and posts progress notes (which become comments).
3. Lead posts a comment mid-run ("skip the migration, config-flag it").
4. Agent re-reads comments via `get_ticket` before pushing and applies it.
5. On `done` the ticket parks in Review; the lead reviews, comments, and
   re-queues from Review for rework — the new run's prompt carries the
   feedback.

Caveat: mid-run steering is cooperative — the agent is instructed to check,
not interrupted. A comment posted after the agent's final pre-push check will
only be picked up on a re-queue.

## How the agent side of the thread is formatted (DAT-204)

The channel was two-way but one-sided in style: humans wrote markdown and
agents wrote paragraphs, so a long agent note arrived as an unbroken block.

The formatting contract now lives in one place, `server/routes/comment-style.ts`,
and is rendered into every prompt that produces a comment body:

- `commentStyleSection()` → the runner prompt (`renderPrompt()` in
  `server/routes/agent-work.ts`), which covers progress notes, flags and
  completion summaries.
- `commentStyleBrief()` → the planning agent's reply to comment feedback
  (`applyCommentFeedback()` in `server/routes/api.ts`), where the comment is
  one field of a JSON contract.
- The delivery-console MCP tools that write a comment (`comment_on_ticket`,
  `report_agent_progress`, `finish_agent_work`) repeat the short version in
  their tool descriptions.

The rules in one line: short paragraphs, a blank line between distinct points,
`-` bullets once there are three or more items, at most about seven bullets and
one level of nesting, headings only for genuinely multi-section comments,
**bold** and `code` for key terms — and short beats complete, with one-sentence
updates left as one sentence.

Display side: `TicketDrawer` renders an ordinary comment through the `Markdown`
component (marked with `gfm`/`breaks`, then DOMPurify), and `.md` in
`client/src/index.css` styles headings, lists, `strong`, `code` and `pre` —
including an explicit `list-style` override, because the appkit-ui Tailwind
preflight resets it. `tests/comment-markdown.test.ts` pins that path.

Coordination-mirror comments (`::coord::`) are deliberately excluded: they are
one-line machine messages rendered by `CoordCommentBody`, which linkifies
ticket keys, @mentions and URLs instead of parsing markdown.
