// Copy-paste prompt for importing an existing project into the console.
//
// The console has no import parser: existing projects come in through the
// same door as new ones — the New engagement flow's "Describe the project"
// brief, which the planning agent turns into phases, milestones and draft
// tickets. This prompt instructs a human or AI agent working inside the
// existing project to gather its context and distill it into a brief that
// survives that pipeline accurately, then lists what to attach after
// creation (Sources, Standards, Config/repo connection).

export const CLIENT_PLACEHOLDER = '<CLIENT NAME>';
export const NAME_PLACEHOLDER = '<PROJECT NAME>';

/** Brief size accepted by the Setup flow's plan parser (server ParseBody). */
export const BRIEF_MIN_CHARS = 30;
export const BRIEF_MAX_CHARS = 20000;

/**
 * Renders the import prompt. Blank client/name fall back to angle-bracket
 * placeholders so the copied text is still self-explanatory.
 */
export function buildImportPrompt(client?: string, name?: string): string {
  const c = client?.trim() || CLIENT_PLACEHOLDER;
  const n = name?.trim() || NAME_PLACEHOLDER;
  return `You are importing an existing project into Cometloop for client "${c}" as engagement "${n}". The console has no automated importer: it ingests projects through the New engagement flow, where a written project brief is parsed by a planning agent into phases, milestones and draft tickets. Your job is to gather the existing project's context and distill it into that brief, so the derived plan matches reality instead of being invented.

STEP 1 — GATHER THE EXISTING PROJECT'S CONTEXT
Collect, from wherever the project lives today (repo, wiki, tracker, drive, email):
- Goals and scope: the problem statement, agreed deliverables, and anything explicitly out of scope. Check the SOW/contract, kickoff deck, README, and architecture docs.
- Timeline: the real start date, target end date, and any phase or wave structure already in use (assessment, build, migration waves, hypercare...). Note dates that have already passed.
- Work items: the current backlog/board. For each open item capture title, rough size, and which phase it belongs to. Note what is already DONE — done work belongs in the brief as completed context, not as new tickets.
- Milestones: dated commitments — go-lives, cutovers, sign-offs, demos, phase gates.
- Team and cadence: who works on it, roles, and the reporting rhythm (e.g. weekly status to the client's IT director).
- Key documents: list the files worth carrying over (SOW, runbooks, designs, standards) — you will attach them after creation in Step 4.

STEP 2 — WRITE THE PROJECT BRIEF
Compose one plain-text brief between ${BRIEF_MIN_CHARS} and ${String(BRIEF_MAX_CHARS)} characters (a few hundred words is the sweet spot). The planning agent derives 3-6 phases, 3-6 dated milestones, and 10-16 draft tickets from it, so state each of those explicitly rather than leaving them to be guessed:
- Open with 2-3 sentences of context: what the project is, for whom, and where it stands today (e.g. "wave 1 of 2 complete").
- Phases: name each phase with its start and end dates (YYYY-MM-DD or "starting mid-September"). Include remaining phases; summarize completed ones in one line.
- Milestones: list each dated commitment with its date.
- Remaining work: enumerate the concrete outstanding tasks as short actionable lines with a day estimate each, e.g. "- Migrate remaining 12 ETL jobs to ADF (5d)". Aim for 10-16 lines that cover the real backlog; fold smaller items together. Tag each with its phase if not obvious.
- Team shape and reporting cadence in one line.
Quote source documents where useful ("per SOW section 2.3") — the parser cites its sources, and real references keep the derived tickets traceable.

STEP 3 — CREATE THE ENGAGEMENT
In Cometloop: Portfolio -> New engagement. Enter "${c}" as the client and "${n}" as the engagement name, then choose "Describe the project" and paste the brief from Step 2 (if you have the signed SOW as a file, "Upload SOW" is the alternative path). Generate the plan, then review it against your Step 1 notes: dismiss proposals that duplicate finished work, and accept the rest before creating the engagement.

STEP 4 — ATTACH THE REMAINING CONTEXT
After the engagement exists, from its workspace:
- Sources tab: upload the key documents listed in Step 1 (SOW, runbooks, designs) so agents and teammates get the project's context.
- Standards tab: paste the project's engineering/working standards document if one exists.
- Config tab: connect the git repository so PRs and commits auto-link to tickets by key, and set the runner base image plus any libraries this project's agents need preinstalled.
- Fix up the board: adjust ticket estimates or phases the parser got wrong, and add any items the brief left out.

Result: the engagement's roadmap, milestones and board reflect the project as it actually stands, and its documents are attached where the console expects them.`;
}
