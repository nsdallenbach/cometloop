/** Pure helpers for the Project Standards editor (diff review + code embedding). */

export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

/**
 * Line diff for the AI-refine review: common prefix/suffix are stripped, the
 * middle is aligned with LCS. Returns null when the doc is too large to diff
 * responsively — callers fall back to a plain preview of the suggestion.
 */
export function lineDiff(a: string, b: string): DiffLine[] | null {
  const al = a.split('\n');
  const bl = b.split('\n');
  let start = 0;
  while (start < al.length && start < bl.length && al[start] === bl[start]) start++;
  let endA = al.length;
  let endB = bl.length;
  while (endA > start && endB > start && al[endA - 1] === bl[endB - 1]) {
    endA--;
    endB--;
  }
  const ma = al.slice(start, endA);
  const mb = bl.slice(start, endB);
  if (ma.length * mb.length > 500_000) return null;
  // LCS lengths table over the changed middle only.
  const w = mb.length + 1;
  const dp = new Uint32Array((ma.length + 1) * w);
  for (let i = ma.length - 1; i >= 0; i--) {
    for (let j = mb.length - 1; j >= 0; j--) {
      dp[i * w + j] = ma[i] === mb[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = al.slice(0, start).map((text) => ({ type: 'same' as const, text }));
  let i = 0;
  let j = 0;
  while (i < ma.length && j < mb.length) {
    if (ma[i] === mb[j]) {
      out.push({ type: 'same', text: ma[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ type: 'del', text: ma[i++] });
    } else {
      out.push({ type: 'add', text: mb[j++] });
    }
  }
  while (i < ma.length) out.push({ type: 'del', text: ma[i++] });
  while (j < mb.length) out.push({ type: 'add', text: mb[j++] });
  out.push(...al.slice(endA).map((text) => ({ type: 'same' as const, text })));
  return out;
}

export const CODE_LANG: Record<string, string> = {
  py: 'python', sql: 'sql', ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  sh: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json', java: 'java', scala: 'scala',
  cs: 'csharp', go: 'go', rb: 'ruby', tf: 'hcl', ps1: 'powershell', md: 'markdown', txt: '',
};

export const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

/** Fenced block whose fence is longer than any backtick run in the snippet. */
export function fencedBlock(name: string, code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const lang = CODE_LANG[extOf(name)] ?? '';
  return `### Example — ${name}\n\n${fence}${lang}\n${code.replace(/\n$/, '')}\n${fence}\n`;
}
