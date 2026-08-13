/**
 * DAT-204: how agent-authored ticket comments are written.
 *
 * Agents post into `app.ticket_comments` from several places — runner progress
 * notes and completion summaries (`agent-work.ts`), the planning agent's reply
 * to comment feedback (`api.ts`), and any `comment_on_ticket` call. They were
 * each free to invent their own style, and what came back was one dense
 * paragraph per comment.
 *
 * The rules live here once and are rendered into every prompt that produces a
 * comment body, so the style cannot drift between flows. Prompts ship with the
 * server per the development standards, so editing this file is a deploy.
 *
 * Safe to rely on markdown: the drawer renders ordinary comments through the
 * `Markdown` component (marked with `gfm: true, breaks: true`, sanitized with
 * DOMPurify), and `.md` in `client/src/index.css` styles headings, `ul`/`ol`,
 * `li` markers, `strong`, `code` and `pre`. `tests/comment-markdown.test.ts`
 * pins that path against the example below.
 */

/** The formatting contract, as prompt bullets. Order matters — the cheap wins first. */
export const COMMENT_STYLE_RULES: string[] = [
  'Comment bodies render as GitHub-flavored markdown, and single newlines become line breaks. Write markdown — never one dense block of text.',
  'Keep paragraphs to 1-3 sentences and put a blank line between distinct points. No paragraph should run past about four lines.',
  'Listing three or more things (findings, files, steps, options)? Use a list, not a long comma-separated sentence — `-` bullets for unordered items, `1.` numbers only for sequences and ranked items.',
  'Cap lists at about seven items and one level of nesting. If you need more structure than that, the comment is too long — cut it, or split it into short `##` sections.',
  'Use `##` headings only when the comment has two or more distinct sections. A short update needs no heading.',
  'Use **bold** for the handful of terms that carry the update (a verdict, a status, a decision) and `inline code` for files, branches, commands, identifiers and values. Fence multi-line output or diffs in a code block.',
  'Bias to scannable and short over complete and verbose: a progress note is usually under 120 words. Formatting is there to be skimmed, not to pad — do not wrap a one-sentence update in headings and bullets.',
  'Lead with the outcome. The first line should tell a reader who never opens the thread again what happened.',
];

/** Worked example — a multi-point note in the intended shape. */
export const COMMENT_STYLE_EXAMPLE = [
  'Example of a well-formatted progress note:',
  '',
  'Prompt work is done; wiring the render path next.',
  '',
  '**Changed so far**',
  '',
  '- `server/routes/comment-style.ts` — new shared formatting rules',
  '- `server/routes/agent-work.ts` — runner prompt now renders those rules',
  '- `server/routes/api.ts` — planning-agent reply asks for markdown',
  '',
  'Verified the drawer renders markdown through the `Markdown` component, so lists and **bold** display correctly.',
  '',
  'Next: tests over `renderPrompt()` and the marked + DOMPurify path, then the PR.',
].join('\n');

/**
 * The full section for prompts whose output IS the comment (runner prompts).
 * Returns lines to splice into a prompt array.
 */
export function commentStyleSection(heading = '## Writing comments on the ticket'): string[] {
  return [
    heading,
    'Everything you post to the ticket thread — progress notes, flags, completion summaries — is read by humans scanning a board. Format it so it can be skimmed:',
    ...COMMENT_STYLE_RULES.map((r) => `- ${r}`),
    '',
    COMMENT_STYLE_EXAMPLE,
  ];
}

/**
 * Compact single-string version for prompts that ask for a comment inside a
 * JSON field, where a full section would swamp the output contract.
 */
export function commentStyleBrief(): string {
  return [
    'Format it as markdown for readability, not as one dense block:',
    '- Short paragraphs (1-3 sentences), blank line between distinct points.',
    '- Three or more items become a `-` bulleted list, not a long comma-separated sentence.',
    '- At most about seven bullets, one level of nesting, no headings unless there are two or more sections.',
    '- **bold** for the key term, `inline code` for files, fields and values.',
    '- Stay short — skimmable beats complete. A one-line answer stays one line, with no bullets.',
  ].join('\n');
}
