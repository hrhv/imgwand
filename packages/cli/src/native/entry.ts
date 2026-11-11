/**
 * Entry point of the standalone binary: extract the embedded native libraries, point sharp and the C2PA SDK at
 * them, then start the regular CLI. (The npm package starts at ../index.ts and loads them from node_modules.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { C2PA_NODE_VERSION, NATIVE_FILES, NATIVE_KEY, NATIVE_SHA256 } from "./assets.js";
import { extractNative } from "./extract.js";

let cacheDir: string | undefined;
try {
  cacheDir = extractNative({ key: NATIVE_KEY, files: NATIVE_FILES, sha256: NATIVE_SHA256 }, { env: process.env, readEmbedded: (p) => readFileSync(p) });
  const find = (test: (rel: string) => boolean) => {
    const hit = NATIVE_FILES.find(([rel]) => test(rel));
    return hit ? join(cacheDir!, hit[0]) : undefined;
  };
  process.env.IMGWAND_SHARP_NODE = find((rel) => /\/sharp-[^/]+\/lib\/sharp-.*\.node$/.test(rel));
  process.env.C2PA_LIBRARY_PATH = find((rel) => rel.startsWith("@contentauth/c2pa-node/"));
} catch (error) {
  process.stderr.write(`imgwand: cannot prepare native libraries: ${(error as Error).message}\nSet IMGWAND_NATIVE_DIR to a writable directory.\n`);
  process.exit(1);
}

const { run } = await import("../program.js");
process.exitCode = await run(process.argv.slice(2), { native: { cacheDir, c2paVersion: C2PA_NODE_VERSION } });
