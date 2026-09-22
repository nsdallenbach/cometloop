import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localFiles, resolveUnder } from './files';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cometloop-files-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const readAll = async (stream: ReadableStream | undefined) =>
  stream ? Buffer.from(await new Response(stream).arrayBuffer()).toString('utf8') : null;

describe('localFiles', () => {
  it('round-trips upload, list, download and delete under the alias root', async () => {
    const files = localFiles(root);
    await files.upload('context/exec/brief.md', Buffer.from('# brief'), { overwrite: true });
    const listed = await files.list('context/exec');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'brief.md', path: 'context/exec/brief.md', is_directory: false, file_size: 7 });
    expect(typeof listed[0].last_modified).toBe('number');

    const dl = await files.download('context/exec/brief.md');
    expect(await readAll(dl.contents)).toBe('# brief');

    await files.delete('context/exec/brief.md');
    expect(await files.list('context/exec')).toEqual([]);
    await expect(files.delete('context/exec/brief.md')).resolves.toBeUndefined(); // idempotent
  });

  it('honours the overwrite:false contract the attachment routes rely on', async () => {
    const files = localFiles(root);
    await files.upload('a.txt', Buffer.from('1'));
    await expect(files.upload('a.txt', Buffer.from('2'))).rejects.toThrow();
    await files.upload('a.txt', Buffer.from('3'), { overwrite: true });
    expect(await readAll((await files.download('a.txt')).contents)).toBe('3');
  });

  it('answers a missing directory with an empty list and a missing file with no contents', async () => {
    const files = localFiles(root);
    expect(await files.list('nowhere/yet')).toEqual([]);
    expect(await files.download('nowhere/yet/x.txt')).toEqual({});
  });

  it('refuses paths that climb out of the root', async () => {
    const files = localFiles(root);
    await expect(files.upload('../escape.txt', Buffer.from('x'))).rejects.toThrow(/escapes/);
    expect(() => resolveUnder(root, 'ok/../../nope')).toThrow(/escapes/);
    expect(resolveUnder(root, '/leading/slash')).toBe(path.join(root, 'leading', 'slash'));
  });
});
