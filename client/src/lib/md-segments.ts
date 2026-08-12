/**
 * Split markdown into plain segments and ```mermaid fences so the Markdown
 * component can hand diagrams to the mermaid renderer while everything else
 * goes through marked. An unclosed fence stays plain markdown — better to
 * show the code than to eat the rest of the document.
 */

export type MdSegment = { kind: 'md'; body: string } | { kind: 'mermaid'; body: string };

const MERMAID_FENCE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;

export function splitMermaid(text: string): MdSegment[] {
  const out: MdSegment[] = [];
  let last = 0;
  MERMAID_FENCE.lastIndex = 0;
  for (let m = MERMAID_FENCE.exec(text); m !== null; m = MERMAID_FENCE.exec(text)) {
    if (m.index > last) out.push({ kind: 'md', body: text.slice(last, m.index) });
    const body = m[1].trim();
    if (body) out.push({ kind: 'mermaid', body });
    last = m.index + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ kind: 'md', body: text.slice(last) });
  return out;
}
