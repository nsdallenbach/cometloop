import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentRejection,
  sanitizeAttachmentName,
} from '../server/routes/ticket-attachments';

describe('sanitizeAttachmentName', () => {
  it('keeps ordinary filenames intact', () => {
    expect(sanitizeAttachmentName('error-log 2026.txt')).toBe('error-log 2026.txt');
    expect(sanitizeAttachmentName('Screenshot_1.png')).toBe('Screenshot_1.png');
  });

  it('neutralizes path traversal and separators', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeAttachmentName('..\\..\\boot.ini')).toBe('_.._boot.ini');
    expect(sanitizeAttachmentName('a/b/c.txt')).toBe('a_b_c.txt');
  });

  it('strips leading dots and falls back for empty names', () => {
    expect(sanitizeAttachmentName('.env')).toBe('env');
    expect(sanitizeAttachmentName('///')).toBe('___');
    expect(sanitizeAttachmentName('')).toBe('file');
  });
});

describe('attachmentRejection', () => {
  it('accepts a normal file within the limit', () => {
    expect(attachmentRejection('screenshot.png', 5_000)).toBeNull();
    expect(attachmentRejection('server.log', MAX_ATTACHMENT_BYTES)).toBeNull();
  });

  it('rejects empty uploads', () => {
    expect(attachmentRejection('a.txt', 0)).toBe('Empty upload');
  });

  it('rejects files over the size limit with a clear message', () => {
    const msg = attachmentRejection('big.zip', MAX_ATTACHMENT_BYTES + 1);
    expect(msg).toContain('limited to 25 MB');
  });

  it('rejects executable and script types regardless of case', () => {
    expect(attachmentRejection('malware.exe', 10)).toContain('.exe files are not allowed');
    expect(attachmentRejection('script.PS1', 10)).toContain('.ps1 files are not allowed');
    expect(attachmentRejection('tool.Jar', 10)).toContain('.jar files are not allowed');
  });

  it('allows extensionless files and common document types', () => {
    expect(attachmentRejection('Makefile', 10)).toBeNull();
    expect(attachmentRejection('spec.pdf', 10)).toBeNull();
    expect(attachmentRejection('notes.docx', 10)).toBeNull();
  });
});
