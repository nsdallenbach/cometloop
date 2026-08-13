/**
 * The standard tags every board offers: the lightweight feature/bug
 * classification (DAT-210). They are ordinary tags — no new field, no tag
 * table — so they are stored, rendered and filtered exactly like any tag a
 * user types. The only thing "standard" about them is that the tag input
 * suggests them and that their casing is canonical (see normalizeTags), so
 * `Bug`, `BUG` and `bug` never split into three different labels.
 */
export const STANDARD_TAGS = ['feature', 'bug'] as const;

const CANONICAL = new Map<string, string>(STANDARD_TAGS.map((t) => [t.toLowerCase(), t as string]));

/** The canonical spelling of a standard tag, or the tag unchanged. */
export function canonicalTag(tag: string): string {
  return CANONICAL.get(tag.trim().toLowerCase()) ?? tag.trim();
}

/**
 * Tags are free-form labels: trim each, drop empties, and dedupe
 * case-insensitively keeping the first spelling the user typed — except for
 * the standard tags, which always land in their canonical lowercase form.
 */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = canonicalTag(raw);
    const lower = tag.toLowerCase();
    if (!tag || seen.has(lower)) continue;
    seen.add(lower);
    out.push(tag);
  }
  return out;
}
