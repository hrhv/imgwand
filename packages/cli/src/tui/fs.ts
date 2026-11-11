import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "dir" | "image" | "parent";
  readonly format?: string;
  readonly size: number;
  readonly modified?: Date;
}

export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { ".jpg": "JPEG", ".jpeg": "JPEG", ".jpe": "JPEG", ".png": "PNG", ".webp": "WebP" };

export type ListDir = (dir: string, showHidden: boolean) => Promise<DirEntry[]>;

/** Directories first, then images; other files are not shown. */
export const listDir: ListDir = async (dir, showHidden) => {
  const names = await readdir(dir);
  const entries: DirEntry[] = [];
  await Promise.all(
    names.map(async (name) => {
      if (!showHidden && name.startsWith(".")) return;
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      if (!info) return;
      if (info.isDirectory()) entries.push({ name, path, kind: "dir", size: 0, modified: info.mtime });
      else if (info.isFile() && IMAGE_EXTENSIONS[extname(name).toLowerCase()]) {
        entries.push({ name, path, kind: "image", format: IMAGE_EXTENSIONS[extname(name).toLowerCase()], size: info.size, modified: info.mtime });
      }
    }),
  );
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return entries;
};
