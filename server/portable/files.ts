import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * Local-disk implementation of the 4-method files interface that the route
 * modules take from AppKit's `files()` plugin (`AppKitServices['files']` in
 * `routes/api.ts`). Keys are volume aliases (`files`, `telemetry`); every
 * alias is a directory under `FILES_DIR`. Paths are relative
 * (`context/<engagement>/<name>`) and are confined to the alias root, so a
 * client-supplied name can never climb out of it.
 *
 * Phase 5 of the platform plan swaps this for object storage behind the same
 * interface; nothing in the routes changes.
 */

export interface FileEntry {
  name?: string;
  path?: string;
  is_directory?: boolean;
  file_size?: number;
  last_modified?: number;
}

export interface FilesApi {
  upload(filePath: string, contents: Buffer, options?: { overwrite?: boolean }): Promise<void>;
  download(filePath: string): Promise<{ contents?: ReadableStream }>;
  list(directoryPath?: string): Promise<FileEntry[]>;
  delete(filePath: string): Promise<void>;
}

/** Resolve `relative` under `root`, refusing anything that escapes it. */
export function resolveUnder(root: string, relative: string): string {
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, cleaned);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWithSep)) {
    throw new Error(`path escapes the files root: ${relative}`);
  }
  return full;
}

export function localFiles(root: string): FilesApi {
  const absRoot = path.resolve(root);
  return {
    async upload(filePath, contents, options) {
      const full = resolveUnder(absRoot, filePath);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      // 'wx' fails when the file exists — the overwrite:false contract.
      await fsp.writeFile(full, contents, { flag: options?.overwrite ? 'w' : 'wx' });
    },
    download(filePath) {
      const full = resolveUnder(absRoot, filePath);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return Promise.resolve({});
      return Promise.resolve({ contents: Readable.toWeb(fs.createReadStream(full)) as ReadableStream });
    },
    async list(directoryPath = '') {
      const dir = resolveUnder(absRoot, directoryPath);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const entries: FileEntry[] = [];
      for (const name of names) {
        const stat = await fsp.stat(path.join(dir, name));
        entries.push({
          name,
          path: path.posix.join(directoryPath.replace(/\\/g, '/'), name),
          is_directory: stat.isDirectory(),
          file_size: stat.isDirectory() ? undefined : stat.size,
          last_modified: stat.mtimeMs,
        });
      }
      return entries.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    },
    async delete(filePath) {
      const full = resolveUnder(absRoot, filePath);
      try {
        await fsp.unlink(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}
