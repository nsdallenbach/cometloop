export const TICKET_ACTIVITY_TYPES = ['refinement_in_progress', 'planning_response_in_progress'] as const;
export type TicketActivityType = (typeof TICKET_ACTIVITY_TYPES)[number];

export const TICKET_ACTIVITY_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.ticket_activity (
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    activity_type TEXT NOT NULL CHECK (activity_type IN ('refinement_in_progress','planning_response_in_progress')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ticket_key, activity_type)
  )`,
];

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** Idempotent so retries and overlapping invocations of the same flow cannot duplicate a badge. */
export async function setTicketActivity(q: Query, key: string, activity: TicketActivityType): Promise<void> {
  await q(
    `INSERT INTO app.ticket_activity (ticket_key, activity_type) VALUES ($1,$2)
     ON CONFLICT (ticket_key, activity_type) DO UPDATE SET started_at = NOW()`,
    [key, activity]
  );
}

/** Clears only this flow's marker, preserving any concurrent ticket activity. */
export async function clearTicketActivity(q: Query, key: string, activity: TicketActivityType): Promise<void> {
  await q('DELETE FROM app.ticket_activity WHERE ticket_key = $1 AND activity_type = $2', [key, activity]);
}
