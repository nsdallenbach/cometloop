/**
 * Tags are free-form labels: trim each, drop empties, and dedupe
 * case-insensitively keeping the first spelling the user typed.
 */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const lower = tag.toLowerCase();
    if (!tag || seen.has(lower)) continue;
    seen.add(lower);
    out.push(tag);
  }
  return out;
}
