// Dependency-free fuzzy search + ranking for the command palette.
//
// Matching tiers per query token (best field score wins):
//   exact field match > prefix > word-boundary substring > substring >
//   fuzzy subsequence > small-typo (Damerau-Levenshtein <= 1..2) word match.
// Fields are weighted so label matches outrank keyword/description matches.

export interface PaletteSearchable {
  kind: string;
  label: string;
  hint?: string;
  description?: string;
  keywords?: string[];
}

const FIELD_WEIGHTS: Array<[keyof PaletteSearchable, number]> = [
  ['label', 1],
  ['keywords', 0.85],
  ['description', 0.7],
  ['kind', 0.6],
  ['hint', 0.5],
];

const norm = (s: string) => s.toLowerCase();

const isBoundary = (text: string, idx: number) => idx === 0 || !/[a-z0-9]/i.test(text[idx - 1]);

/** Score a query token against one text. Returns 0 when there is no match. */
export function tokenScore(token: string, text: string): number {
  if (!token || !text) return 0;
  token = norm(token);
  const t = norm(text);
  if (t === token) return 100;
  if (t.startsWith(token)) return 85 + 10 * (token.length / t.length);
  const at = t.indexOf(token);
  if (at !== -1) return (isBoundary(t, at) ? 72 : 60) + 8 * (token.length / t.length);
  const sub = subsequenceScore(token, t);
  const typo = typoScore(token, t);
  return Math.max(sub, typo);
}

/** fzf-style in-order character match with adjacency and word-boundary bonuses. */
function subsequenceScore(token: string, text: string): number {
  let idx = -1;
  let prev = -2;
  let raw = 0;
  for (const ch of token) {
    idx = text.indexOf(ch, idx + 1);
    if (idx === -1) return 0;
    if (idx === prev + 1) raw += 8;
    else raw += Math.max(1, 5 - Math.min(4, idx - prev - 2));
    if (isBoundary(text, idx)) raw += 6;
    prev = idx;
  }
  // Normalize: all-adjacent boundary-start run would approach 14/char.
  const quality = raw / (token.length * 14);
  return 20 + 30 * Math.min(1, quality);
}

/** Match a token with 1–2 typos against whole words (and word prefixes) of the text. */
function typoScore(token: string, text: string): number {
  if (token.length < 3) return 0;
  const maxDist = token.length >= 6 ? 2 : 1;
  let best = 0;
  for (const word of text.split(/[^a-z0-9]+/)) {
    if (!word) continue;
    // Compare against the whole word and, for partially-typed queries, its prefix.
    const targets = word.length > token.length ? [word, word.slice(0, token.length + 1)] : [word];
    for (const target of targets) {
      if (Math.abs(target.length - token.length) > maxDist) continue;
      const dist = damerauLevenshtein(token, target, maxDist);
      if (dist <= maxDist) best = Math.max(best, 50 - 12 * dist - (target === word ? 0 : 4));
    }
  }
  return best;
}

/** Optimal-string-alignment distance, early-exiting once `max` is exceeded. */
export function damerauLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

/** Best weighted score for one token across all searchable fields of an item. */
function itemTokenScore(token: string, item: PaletteSearchable): number {
  let best = 0;
  for (const [field, weight] of FIELD_WEIGHTS) {
    const value = item[field];
    if (!value) continue;
    const texts = Array.isArray(value) ? value : [value];
    for (const text of texts) {
      best = Math.max(best, weight * tokenScore(token, text));
      if (best >= 100) return best;
    }
  }
  return best;
}

/**
 * Rank items against a query. Every whitespace-separated query token must match
 * at least one field; item score is the sum of per-token best scores. An empty
 * query returns items in their original order.
 */
export function searchPaletteItems<T extends PaletteSearchable>(items: T[], query: string, limit = Infinity): T[] {
  const tokens = norm(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return items.slice(0, limit);
  const scored: Array<{ item: T; score: number; idx: number }> = [];
  for (let idx = 0; idx < items.length; idx++) {
    let score = 0;
    let matched = true;
    for (const token of tokens) {
      const s = itemTokenScore(token, items[idx]);
      if (s <= 0) {
        matched = false;
        break;
      }
      score += s;
    }
    if (matched) scored.push({ item: items[idx], score, idx });
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, limit).map((s) => s.item);
}
