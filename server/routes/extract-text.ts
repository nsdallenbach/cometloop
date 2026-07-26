import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

const MAX_CHARS = 24_000;

function printableRatio(buf: Buffer): number {
  const sample = buf.subarray(0, 2000);
  if (sample.length === 0) return 0;
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  }
  return printable / sample.length;
}

/**
 * Best-effort text extraction for uploaded SOW documents.
 * Supports PDF (unpdf), DOCX (mammoth) and plain text; returns '' when the
 * document body cannot be read so callers can fall back to inference.
 */
export async function extractSowText(filename: string, buf: Buffer): Promise<string> {
  const lower = filename.toLowerCase();
  try {
    if (lower.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      return text.replace(/\s+\n/g, '\n').slice(0, MAX_CHARS);
    }
    if (lower.endsWith('.docx') || buf.subarray(0, 2).toString('latin1') === 'PK') {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return value.slice(0, MAX_CHARS);
    }
    if (printableRatio(buf) > 0.85) {
      return buf.toString('utf8').slice(0, MAX_CHARS);
    }
  } catch (err) {
    console.warn('[extract] text extraction failed:', (err as Error).message);
  }
  return '';
}
