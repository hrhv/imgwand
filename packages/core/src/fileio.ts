import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ImgwandError } from "./errors.js";

/** Files larger than this are refused (metadata tools have no business loading multi-gigabyte files whole). */
export const MAX_FILE_SIZE = 1024 * 1024 * 1024;

export async function readImageFile(path: string, maxSize = MAX_FILE_SIZE): Promise<Uint8Array> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new ImgwandError("IO_ERROR", `Cannot read ${path}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (error as Error).message}`, { cause: error });
  }
  if (!info.isFile()) throw new ImgwandError("IO_ERROR", `${path} is not a regular file`);
  if (info.size > maxSize) throw new ImgwandError("IO_ERROR", `${path} is ${info.size} bytes; the limit is ${maxSize}`);
  const data = await readFile(path);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export interface WriteOptions {
  /** Keep a copy of the existing file: true for "<path>.bak", or an explicit path. Never overwrites a backup. */
  readonly backup?: boolean | string;
}

export interface WriteResult {
  readonly path: string;
  readonly backupPath?: string;
}

async function freeBackupPath(preferred: string): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? preferred : `${preferred}.${i}`;
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new ImgwandError("IO_ERROR", `Too many backups next to ${preferred}`);
}

/**
 * Writes a file atomically: the data goes to a temporary file in the same directory, is flushed to disk, and then
 * renamed over the target, so readers see either the old file or the new one, never a partial write. The file
 * mode of an existing target is preserved.
 */
export async function writeFileAtomic(path: string, bytes: Uint8Array, options: WriteOptions = {}): Promise<WriteResult> {
  let mode = 0o644;
  let exists = false;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new ImgwandError("IO_ERROR", `${path} exists and is not a regular file`);
    mode = info.mode & 0o777;
    exists = true;
  } catch (error) {
    if (error instanceof ImgwandError) throw error;
  }

  let backupPath: string | undefined;
  if (options.backup && exists) {
    backupPath = await freeBackupPath(typeof options.backup === "string" ? options.backup : `${path}.bak`);
    try {
      await copyFile(path, backupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      throw new ImgwandError("IO_ERROR", `Cannot write the backup ${backupPath}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { cause: error });
    }
  }

  const tmp = join(dirname(path), `.${basename(path)}.imgwand-${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error instanceof ImgwandError ? error : new ImgwandError("IO_ERROR", `Cannot write ${path}: ${(error as Error).message}`, { cause: error });
  }
  return { path, backupPath };
}
