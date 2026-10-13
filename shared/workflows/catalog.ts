/**
 * The workflow catalog: what a node can be. Shared by the server (which runs
 * workflows and validates saved graphs) and the client (which draws the
 * builder's inspector from it), so the two can never disagree about a
 * trigger's fields or an action's name.
 *
 * A node is `{ kind, type, config }`. `kind` is the shape on the canvas
 * (trigger / condition / action / agent); `type` picks an entry from the
 * matching catalog below; `config` holds that entry's field values. Every
 * entry declares its fields as plain descriptors so the inspector is a
 * generic form, and triggers declare the `payload` paths they fill, which is
 * what rules compare and templates (`{{ticket.key}}`) read.
 */

export type NodeKind = 'trigger' | 'agent' | 'condition' | 'action';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  /**
   * text / textarea / number: as they sound. select: one of `options`.
   * status: a ticket lane. project: an engagement id (the client offers its
   * list). choices: the Decide node's options, one `label: description` per
   * line.
   */
  type: 'text' | 'textarea' | 'number' | 'select' | 'status' | 'project' | 'choices';
  placeholder?: string;
  help?: string;
  options?: FieldOption[];
  min?: number;
  max?: number;
  default?: string | number;
}

export interface CatalogEntry {
  id: string;
  label: string;
  blurb: string;
  fields: FieldDef[];
}

export interface TriggerDef extends CatalogEntry {
  group: 'tickets' | 'code' | 'agents' | 'time' | 'manual';
  /** Dotted paths the event fills, for rules and templates. */
  payload: string[];
}

export interface ConditionDef extends CatalogEntry {
  /** Outcome labels the edges out of this node can carry; `null` = the Decide node's own choices. */
  outcomes: string[] | null;
}

export type ActionDef = CatalogEntry;
export type AgentDef = CatalogEntry;

export const TICKET_STATUSES: FieldOption[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'progress', label: 'In Progress' },
  { value: 'review', label: 'In Review' },
  { value: 'deploying', label: 'Deploying' },
  { value: 'done', label: 'Done' },
  { value: 'proposed', label: 'Agent proposed' },
  { value: 'dismissed', label: 'Dismissed' },
];

const TICKET_PAYLOAD = ['ticket.key', 'ticket.title', 'ticket.status', 'ticket.assignee', 'ticket.engagementId', 'ticket.description', 'ticket.tags'];
const PROJECT_FIELD: FieldDef = { key: 'project', label: 'Only this project', type: 'project', help: 'Blank: every project.' };

export const TRIGGERS: TriggerDef[] = [
  {
    id: 'ticket.created',
    label: 'Ticket created',
    group: 'tickets',
    blurb: 'A ticket lands on a board, by hand, by import or by an agent.',
    fields: [PROJECT_FIELD],
    payload: TICKET_PAYLOAD,
  },
  {
    id: 'ticket.moved',
    label: 'Ticket moved',
    group: 'tickets',
    blurb: 'A ticket changes lane.',
    fields: [
      { key: 'to', label: 'Into lane', type: 'status', help: 'Blank: any lane.' },
      { key: 'from', label: 'From lane', type: 'status', help: 'Blank: any lane.' },
      PROJECT_FIELD,
    ],
    payload: [...TICKET_PAYLOAD, 'move.from', 'move.to'],
  },
  {
    id: 'comment.added',
    label: 'Comment added',
    group: 'tickets',
    blurb: 'Someone, or an agent, comments on a ticket.',
    fields: [{ key: 'contains', label: 'Only when the comment contains', type: 'text', placeholder: '/deploy', help: 'Case-insensitive. Blank: every comment.' }, PROJECT_FIELD],
    payload: [...TICKET_PAYLOAD, 'comment.author', 'comment.body'],
  },
  {
    id: 'pr.opened',
    label: 'Pull request opened',
    group: 'code',
    blurb: 'A linked pull request opens on a connected repository.',
    fields: [PROJECT_FIELD],
    payload: [...TICKET_PAYLOAD, 'pr.number', 'pr.title', 'pr.author', 'pr.url', 'pr.branch'],
  },
  {
    id: 'pr.merged',
    label: 'Pull request merged',
    group: 'code',
    blurb: 'A linked pull request merges.',
    fields: [PROJECT_FIELD],
    payload: [...TICKET_PAYLOAD, 'pr.number', 'pr.title', 'pr.author', 'pr.url', 'pr.branch'],
  },
  {
    id: 'deploy.finished',
    label: 'Deploy finished',
    group: 'code',
    blurb: 'A local deploy reported by a desktop ends.',
    fields: [
      {
        key: 'result',
        label: 'Result',
        type: 'select',
        options: [
          { value: '', label: 'Any' },
          { value: 'succeeded', label: 'Succeeded' },
          { value: 'failed', label: 'Failed' },
        ],
      },
      PROJECT_FIELD,
    ],
    payload: [...TICKET_PAYLOAD, 'deploy.result', 'deploy.detail', 'deploy.agent', 'deploy.actor'],
  },
  {
    id: 'agent.completed',
    label: 'Agent run finished',
    group: 'agents',
    blurb: 'A coding agent finishes a ticket, or gives up on it.',
    fields: [
      {
        key: 'outcome',
        label: 'Outcome',
        type: 'select',
        options: [
          { value: '', label: 'Any' },
          { value: 'done', label: 'Done (PR ready)' },
          { value: 'failed', label: 'Failed' },
        ],
      },
      PROJECT_FIELD,
    ],
    payload: [...TICKET_PAYLOAD, 'run.agent', 'run.outcome', 'run.summary', 'run.url'],
  },
  {
    id: 'ticket.idle',
    label: 'Ticket idle',
    group: 'time',
    blurb: 'A ticket has had no activity for a number of business days. Fires once per quiet period.',
    fields: [
      { key: 'days', label: 'Business days without activity', type: 'number', min: 1, max: 60, default: 3 },
      { key: 'status', label: 'In lane', type: 'status', help: 'Blank: In Progress and In Review.' },
      PROJECT_FIELD,
    ],
    payload: [...TICKET_PAYLOAD, 'idle.days', 'idle.since'],
  },
  {
    id: 'schedule',
    label: 'Schedule',
    group: 'time',
    blurb: 'On the clock. Times are UTC.',
    fields: [
      {
        key: 'every',
        label: 'Every',
        type: 'select',
        options: [
          { value: 'hour', label: 'Hour' },
          { value: 'day', label: 'Day' },
          { value: 'weekday', label: 'Weekday (Mon–Fri)' },
          { value: 'week', label: 'Week (Mondays)' },
        ],
        default: 'day',
      },
      { key: 'at', label: 'At (HH:MM UTC)', type: 'text', placeholder: '09:00', default: '09:00', help: 'Ignored for hourly.' },
    ],
    payload: ['schedule.firedAt'],
  },
  {
    id: 'manual',
    label: 'Run by hand',
    group: 'manual',
    blurb: 'Only when someone presses Run now, optionally on a ticket.',
    fields: [],
    payload: [...TICKET_PAYLOAD, 'manual.by'],
  },
];

export const RULE_OPS: FieldOption[] = [
  { value: 'equals', label: 'equals' },
  { value: 'not-equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'not-contains', label: 'does not contain' },
  { value: 'greater', label: 'is greater than' },
  { value: 'less', label: 'is less than' },
  { value: 'exists', label: 'is set' },
  { value: 'empty', label: 'is empty' },
];

export const DECIDE_PROVIDERS: FieldOption[] = [
  { value: 'auto', label: 'Auto (Jev → Databricks ai_decide → model)' },
  { value: 'jev', label: 'Jev (TypeSafe)' },
  { value: 'databricks', label: 'Databricks ai_decide' },
  { value: 'model', label: 'Configured model' },
];

export const CONDITIONS: ConditionDef[] = [
  {
    id: 'rule',
    label: 'Rule',
    blurb: 'Compare one field of the event. Connections out of it are labelled yes or no.',
    fields: [
      { key: 'field', label: 'Field', type: 'text', placeholder: 'ticket.status', help: 'A payload path from the trigger.' },
      { key: 'op', label: 'Comparison', type: 'select', options: RULE_OPS, default: 'equals' },
      { key: 'value', label: 'Value', type: 'text' },
    ],
    outcomes: ['yes', 'no'],
  },
  {
    id: 'decide',
    label: 'Decide',
    blurb: 'A decision model picks one of your choices from the event: Jev, or Databricks ai_decide when the workspace has it. Connections out of it are labelled with the choices.',
    fields: [
      { key: 'question', label: 'Question', type: 'textarea', placeholder: 'Is this ticket a bug, a feature or a chore?' },
      {
        key: 'choices',
        label: 'Choices',
        type: 'choices',
        placeholder: 'bug: something that worked no longer does\nfeature: new behaviour\nchore: housekeeping',
        help: 'One per line as label: description. The labels become the connection labels.',
      },
      {
        key: 'state',
        label: 'What the model sees',
        type: 'textarea',
        placeholder: '{{ticket.title}}\n\n{{ticket.description}}',
        help: 'A template over the event. Blank: the whole event as JSON.',
      },
      { key: 'provider', label: 'Provider', type: 'select', options: DECIDE_PROVIDERS, default: 'auto' },
    ],
    outcomes: null,
  },
];

export const ACTIONS: ActionDef[] = [
  {
    id: 'ticket.move',
    label: 'Move the ticket',
    blurb: 'Change the ticket’s lane.',
    fields: [{ key: 'status', label: 'Into lane', type: 'status', default: 'review' }],
  },
  {
    id: 'ticket.comment',
    label: 'Comment on the ticket',
    blurb: 'Post a comment as the workflow.',
    fields: [{ key: 'body', label: 'Comment', type: 'textarea', placeholder: 'Heads up: {{ticket.key}} has been idle for {{idle.days}} days.' }],
  },
  {
    id: 'ticket.assign',
    label: 'Assign the ticket',
    blurb: 'Set the assignee.',
    fields: [{ key: 'assignee', label: 'Assignee', type: 'text', placeholder: 'dev@example.com or {{pr.author}}' }],
  },
  {
    id: 'ticket.tag',
    label: 'Tag the ticket',
    blurb: 'Add a tag (no duplicates).',
    fields: [{ key: 'tag', label: 'Tag', type: 'text', placeholder: 'needs-triage' }],
  },
  {
    id: 'notify',
    label: 'Notify someone',
    blurb: 'An in-app notification (and the email digest).',
    fields: [
      { key: 'to', label: 'To', type: 'text', placeholder: '{{ticket.assignee}}', help: 'An email, or a template that becomes one.' },
      { key: 'title', label: 'Title', type: 'text', placeholder: '{{ticket.key}} needs you' },
      { key: 'message', label: 'Message', type: 'textarea' },
    ],
  },
  {
    id: 'feed',
    label: 'Post to the project feed',
    blurb: 'A line on the engagement’s activity feed.',
    fields: [{ key: 'text', label: 'Text', type: 'textarea', placeholder: 'Workflow moved {{ticket.key}} to review.' }],
  },
  {
    id: 'webhook',
    label: 'Call a webhook',
    blurb: 'POST JSON to a URL. The body is a template; blank sends the whole event.',
    fields: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://hooks.example.com/…' },
      { key: 'body', label: 'JSON body', type: 'textarea', placeholder: '{"text": "{{ticket.key}}: {{ticket.title}}"}' },
    ],
  },
];

export const AGENTS: AgentDef[] = [
  {
    id: 'queue',
    label: 'Queue for an agent',
    blurb: 'Put the ticket on the agent work queue, with instructions. A runner claims it like any other ticket.',
    fields: [
      { key: 'instructions', label: 'Instructions', type: 'textarea', placeholder: 'Address the review comments and push.' },
      { key: 'assignee', label: 'Route to', type: 'text', placeholder: 'dev@example.com', help: 'Blank: the pool.' },
      { key: 'priority', label: 'Priority', type: 'number', min: 0, max: 10, default: 0 },
    ],
  },
];

export const CATALOG: Record<NodeKind, CatalogEntry[]> = {
  trigger: TRIGGERS,
  condition: CONDITIONS,
  action: ACTIONS,
  agent: AGENTS,
};

export function catalogEntry(kind: NodeKind, type: string): CatalogEntry | undefined {
  return CATALOG[kind].find((e) => e.id === type);
}

/** The default type for a new node of a kind. */
export const DEFAULT_TYPE: Record<NodeKind, string> = {
  trigger: 'ticket.moved',
  condition: 'rule',
  action: 'ticket.comment',
  agent: 'queue',
};

export type NodeConfig = Record<string, string | number>;

/** A config with every field's default filled in where the config is silent. */
export function withDefaults(kind: NodeKind, type: string, config: NodeConfig | undefined): NodeConfig {
  const out: NodeConfig = { ...(config ?? {}) };
  for (const f of catalogEntry(kind, type)?.fields ?? []) {
    if (out[f.key] === undefined && f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** The Decide node's choices, parsed from its `label: description` lines. */
export function parseChoices(raw: unknown): { label: string; description: string }[] {
  const out: { label: string; description: string }[] = [];
  for (const line of text(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    const label = (i === -1 ? t : t.slice(0, i)).trim();
    const description = i === -1 ? '' : t.slice(i + 1).trim();
    if (label && !out.some((c) => c.label.toLowerCase() === label.toLowerCase())) out.push({ label, description });
  }
  return out;
}

/** The outcome labels a condition node's outgoing connections may carry. */
export function conditionOutcomes(type: string, config: NodeConfig | undefined): string[] {
  const def = CONDITIONS.find((c) => c.id === type);
  if (!def) return [];
  if (def.outcomes) return def.outcomes;
  return parseChoices(config?.choices).map((c) => c.label);
}

const statusLabel = (v: unknown): string => TICKET_STATUSES.find((s) => s.value === text(v))?.label ?? text(v);

/** One line that says what a node does, from its config, for the card and the list. */
export function summarizeNode(kind: NodeKind, type: string, config: NodeConfig | undefined): string {
  const c = withDefaults(kind, type, config);
  const project = c.project ? ` · ${text(c.project)}` : '';
  switch (`${kind}:${type}`) {
    case 'trigger:ticket.created':
      return `when a ticket is created${project}`;
    case 'trigger:ticket.moved':
      return `when a ticket moves${c.from ? ` from ${statusLabel(c.from)}` : ''}${c.to ? ` into ${statusLabel(c.to)}` : ''}${project}`;
    case 'trigger:comment.added':
      return `when a comment${c.contains ? ` containing “${text(c.contains)}”` : ''} is added${project}`;
    case 'trigger:pr.opened':
      return `when a linked PR opens${project}`;
    case 'trigger:pr.merged':
      return `when a linked PR merges${project}`;
    case 'trigger:deploy.finished':
      return `when a deploy ${c.result ? text(c.result) : 'finishes'}${project}`;
    case 'trigger:agent.completed':
      return `when an agent run ${c.outcome === 'done' ? 'succeeds' : c.outcome === 'failed' ? 'fails' : 'ends'}${project}`;
    case 'trigger:ticket.idle':
      return `when a ticket${c.status ? ` in ${statusLabel(c.status)}` : ''} is idle ${text(c.days) || '3'} business days${project}`;
    case 'trigger:schedule':
      return c.every === 'hour' ? 'every hour' : `every ${text(c.every) || 'day'} at ${text(c.at) || '09:00'} UTC`;
    case 'trigger:manual':
      return 'when someone presses Run now';
    case 'condition:rule':
      return `${text(c.field) || '?'} ${RULE_OPS.find((o) => o.value === text(c.op))?.label ?? 'equals'}${['exists', 'empty'].includes(text(c.op)) ? '' : ` ${text(c.value)}`}`;
    case 'condition:decide': {
      const choices = parseChoices(c.choices).map((x) => x.label);
      return `${text(c.question) || 'decide'} → ${choices.length ? choices.join(' / ') : '?'}`;
    }
    case 'action:ticket.move':
      return `move to ${statusLabel(c.status)}`;
    case 'action:ticket.comment':
      return `comment: ${text(c.body)}`;
    case 'action:ticket.assign':
      return `assign to ${text(c.assignee) || '?'}`;
    case 'action:ticket.tag':
      return `tag ${text(c.tag) || '?'}`;
    case 'action:notify':
      return `notify ${text(c.to) || '?'}: ${text(c.title)}`;
    case 'action:feed':
      return `feed: ${text(c.text)}`;
    case 'action:webhook':
      return `POST ${text(c.url) || '?'}`;
    case 'agent:queue':
      return `queue${c.assignee ? ` for ${text(c.assignee)}` : ''}: ${text(c.instructions) || 'work the ticket'}`;
    default:
      return type;
  }
}

/** Why a node's config is not runnable, in plain words, or null. */
export function nodeProblem(kind: NodeKind, type: string, config: NodeConfig | undefined): string | null {
  const entry = catalogEntry(kind, type);
  if (!entry) return `Unknown ${kind} type “${type}”`;
  const c = withDefaults(kind, type, config);
  const need = (key: string, what: string) => (text(c[key]).trim() ? null : `${entry.label}: ${what} is required`);
  switch (`${kind}:${type}`) {
    case 'trigger:schedule':
      return c.every !== 'hour' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(text(c.at)) ? 'Schedule: the time must be HH:MM (UTC)' : null;
    case 'condition:rule':
      return need('field', 'the field');
    case 'condition:decide':
      return need('question', 'the question') ?? (parseChoices(c.choices).length < 2 ? 'Decide: give at least two choices' : null);
    case 'action:ticket.comment':
      return need('body', 'the comment');
    case 'action:ticket.assign':
      return need('assignee', 'the assignee');
    case 'action:ticket.tag':
      return need('tag', 'the tag');
    case 'action:notify':
      return need('to', 'the recipient') ?? need('title', 'the title');
    case 'action:feed':
      return need('text', 'the text');
    case 'action:webhook':
      return /^https?:\/\/\S+$/.test(text(c.url)) ? null : 'Call a webhook: the URL must start with http:// or https://';
    default:
      return null;
  }
}
