import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * Standalone binaries carry sharp/libvips and the C2PA SDK as embedded files. Native code has to be loaded from
 * a real file, so on first run they are extracted to a versioned per-user cache directory, keeping the npm folder
 * layout (sharp finds libvips through an rpath relative to its own location).
 */

export interface NativeBundle {
  readonly key: string;
  readonly files: readonly (readonly [string, string])[];
  readonly sha256: Readonly<Record<string, string>>;
}

export interface ExtractIo {
  readonly env: NodeJS.ProcessEnv;
  readonly readEmbedded: (path: string) => Uint8Array;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A directory only this user can write to; refuses one that someone else owns or that is a symlink. */
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} is not a directory`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`${path} belongs to another user`);
  if ((info.mode & 0o022) !== 0) chmodSync(path, 0o700);
}

export function cacheRoot(env: NodeJS.ProcessEnv): { root: string; shared: boolean } {
  // A user-chosen directory is only ever the parent: everything goes in its own subdirectory, so cleaning the
  // cache can never touch anything else that lives there.
  if (env.IMGWAND_NATIVE_DIR) return { root: join(env.IMGWAND_NATIVE_DIR, "imgwand-native"), shared: false };
  const home = env.HOME || homedir();
  const base = env.XDG_CACHE_HOME || (home ? join(home, ".cache") : "");
  if (base) {
    try {
      privateDir(join(base, "imgwand"));
      return { root: join(base, "imgwand", "native"), shared: false };
    } catch {
      // fall through to the temp directory
    }
  }
  // Shared temp directory: the per-user parent must be ours too (checked here, before anything is created in it),
  // or another user who created it first could swap the libraries between verification and loading.
  const parent = join(tmpdir(), `imgwand-${typeof process.getuid === "function" ? process.getuid() : userInfo().username}`);
  privateDir(parent);
  return { root: join(parent, "native"), shared: true };
}

/** Names of cache entries this module creates; nothing else is ever removed. */
const CACHE_ENTRY = /^(darwin|linux|win32)-(x64|arm64)-[0-9a-f]{16}(\.tmp-\d+-\d+)?$/;

function intact(dir: string, bundle: NativeBundle, verifyHashes: boolean): boolean {
  if (!existsSync(join(dir, ".complete"))) return false;
  for (const [rel] of bundle.files) {
    const path = join(dir, rel);
    if (!existsSync(path)) return false;
    if (verifyHashes && sha256(readFileSync(path)) !== bundle.sha256[rel]) return false;
  }
  return true;
}

/** Extracts the bundle (once) and returns the directory holding it. */
export function extractNative(bundle: NativeBundle, io: ExtractIo): string {
  const { root, shared } = cacheRoot(io.env);
  privateDir(root);
  const dir = join(root, `${process.platform}-${process.arch}-${bundle.key}`);
  // In a shared location (the temp directory), check the content every time, not just its presence.
  if (intact(dir, bundle, shared)) return dir;

  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    for (const [rel, embedded] of bundle.files) {
      const bytes = io.readEmbedded(embedded);
      if (sha256(bytes) !== bundle.sha256[rel]) throw new Error(`embedded ${rel} is corrupt`);
      const out = join(tmp, rel);
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
      writeFileSync(out, bytes, { mode: 0o500 });
    }
    writeFileSync(join(tmp, ".complete"), bundle.key);
    rmSync(dir, { recursive: true, force: true });
    try {
      renameSync(tmp, dir);
    } catch (error) {
      // Another imgwand process extracted the same bundle at the same time; use theirs.
      if (!intact(dir, bundle, false)) throw error;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dir;
}

/** Removes cached bundles other than the one in use. Returns the removed directories. */
export function cleanNativeCache(env: NodeJS.ProcessEnv, keep?: string): string[] {
  const { root } = cacheRoot(env);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (path === keep || !CACHE_ENTRY.test(name)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
