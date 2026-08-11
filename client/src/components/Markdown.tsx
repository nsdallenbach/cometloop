import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Compact sanitized markdown block for ticket descriptions and comments.
 * Styling lives under `.md` in index.css so it tracks the app theme.
 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true });
    return DOMPurify.sanitize(typeof raw === 'string' ? raw : '');
  }, [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
