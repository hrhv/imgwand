/**
 * Builds standalone imgwand executables (no Node.js or npm needed to run them) with `bun build --compile`.
 * sharp/libvips and the C2PA SDK are native libraries; each binary embeds the ones for its platform and extracts
 * them to a per-user cache on first run (see packages/cli/src/native).
 *
 *   tsx scripts/build-binaries.ts host                       # the platform you are on
 *   tsx scripts/build-binaries.ts linux-x64 --gzip           # specific platforms, plus .gz files for a release
 *   tsx scripts/build-binaries.ts linux-x64-musl --c2pa-node path/to/index.node
 *
 * Native libraries per platform:
 *   sharp       npm's cross-platform install (npm install --os/--cpu/--libc) into .native/<platform>
 *   c2pa-node   the SDK's prebuilt release for glibc Linux and macOS; musl needs --c2pa-node (scripts/build-c2pa-musl.sh)
 *
 * Output: dist/bin/imgwand-<platform>[.gz]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

interface Target {
  bun: string;
  sharp: string;
  os: string;
  cpu: string;
  libc?: string;
  /** Rust target triple of the c2pa-node prebuilt binary; undefined when there is none (musl). */
  c2pa?: string;
}

export const TARGETS: Record<string, Target> = {
  "darwin-arm64": { bun: "bun-darwin-arm64", sharp: "darwin-arm64", os: "darwin", cpu: "arm64", c2pa: "aarch64-apple-darwin" },
  "darwin-x64": { bun: "bun-darwin-x64-baseline", sharp: "darwin-x64", os: "darwin", cpu: "x64", c2pa: "x86_64-apple-darwin" },
  "linux-x64": { bun: "bun-linux-x64-baseline", sharp: "linux-x64", os: "linux", cpu: "x64", libc: "glibc", c2pa: "x86_64-unknown-linux-gnu" },
  "linux-arm64": { bun: "bun-linux-arm64", sharp: "linux-arm64", os: "linux", cpu: "arm64", libc: "glibc", c2pa: "aarch64-unknown-linux-gnu" },
  "linux-x64-musl": { bun: "bun-linux-x64-musl-baseline", sharp: "linuxmusl-x64", os: "linux", cpu: "x64", libc: "musl" },
  "linux-arm64-musl": { bun: "bun-linux-arm64-musl", sharp: "linuxmusl-arm64", os: "linux", cpu: "arm64", libc: "musl" },
};

/** The checkout to build (--root); defaults to the repository this script is in. */
const rootIndex = process.argv.indexOf("--root");
const ROOT = resolve(rootIndex >= 0 && process.argv[rootIndex + 1] ? process.argv[rootIndex + 1]! : join(import.meta.dirname, ".."));
const OUT = join(ROOT, "dist", "bin");
const SCRIPTS = import.meta.dirname;
const run = (cmd: string, args: string[], cwd = ROOT) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) throw new Error(`Could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${r.status}`);
};
const pkgVersion = (name: string) => (JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;

function hostPlatform(): string {
  const cpu = arch() === "arm64" ? "arm64" : "x64";
  if (platform() === "darwin") return `darwin-${cpu}`;
  if (platform() !== "linux") throw new Error(`Unsupported host platform: ${platform()}`);
  const musl = existsSync(`/lib/ld-musl-${cpu === "x64" ? "x86_64" : "aarch64"}.so.1`);
  return `linux-${cpu}${musl ? "-musl" : ""}`;
}

/** node_modules holding sharp's native packages for the target. */
function sharpModules(name: string, target: Target): string {
  const own = join(ROOT, "node_modules");
  if (existsSync(join(own, "@img", `sharp-${target.sharp}`))) return own;
  const dir = join(ROOT, ".native", `${name}-sharp-${pkgVersion("sharp")}`);
  if (!existsSync(join(dir, "node_modules", "@img", `sharp-${target.sharp}`))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"private":true}');
    const args = ["install", "--no-save", "--no-package-lock", "--ignore-scripts", `--os=${target.os}`, `--cpu=${target.cpu}`, `sharp@${pkgVersion("sharp")}`];
    if (target.libc) args.push(`--libc=${target.libc}`);
    run("npm", args, dir);
  }
  return join(dir, "node_modules");
}

/** The c2pa-node addon for the target: an explicit file, the installed one when it matches, or the SDK release. */
async function c2paAddon(name: string, target: Target, explicit?: string): Promise<string> {
  if (explicit) return resolve(explicit);
  const version = pkgVersion("@contentauth/c2pa-node");
  if (name === hostPlatform()) {
    const installed = join(ROOT, "node_modules", "@contentauth", "c2pa-node", "dist", "index.node");
    if (existsSync(installed)) return installed;
  }
  if (!target.c2pa) throw new Error(`No prebuilt C2PA SDK for ${name}; build one with scripts/build-c2pa-musl.sh and pass --c2pa-node`);
  const dir = join(ROOT, ".native", `${name}-c2pa-${version}`);
  const file = join(dir, "index.node");
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const tag = encodeURIComponent(`@contentauth/c2pa-node@${version}`);
  const url = `https://github.com/contentauth/c2pa-js/releases/download/${tag}/c2pa-node_${target.c2pa}-v${version}.zip`;
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  writeFileSync(join(dir, "c2pa.zip"), new Uint8Array(await res.arrayBuffer()));
  run("unzip", ["-o", "-q", "c2pa.zip"], dir);
  rmSync(join(dir, "c2pa.zip"));
  if (!existsSync(file)) throw new Error(`The release archive did not contain index.node: ${url}`);
  return file;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Writes the module that embeds the native files (imports with { type: "file" }). */
function writeAssets(name: string, files: [string, string][]): string {
  const key = createHash("sha256");
  for (const [rel, path] of files) key.update(rel).update(sha256(path));
  let src = "// Generated by scripts/build-binaries.ts\n";
  files.forEach(([, path], i) => (src += `import f${i} from ${JSON.stringify(path)} with { type: "file" };\n`));
  src += `export const NATIVE_KEY = ${JSON.stringify(key.digest("hex").slice(0, 16))};\n`;
  src += `export const NATIVE_FILES = [${files.map(([rel], i) => `[${JSON.stringify(rel)}, f${i}]`).join(", ")}];\n`;
  src += `export const NATIVE_SHA256 = ${JSON.stringify(Object.fromEntries(files.map(([rel, path]) => [rel, sha256(path)])))};\n`;
  src += `export const C2PA_NODE_VERSION = ${JSON.stringify(pkgVersion("@contentauth/c2pa-node"))};\n`;
  const out = join(ROOT, ".native", name, "assets.gen.ts");
  mkdirSync(join(ROOT, ".native", name), { recursive: true });
  writeFileSync(out, src);
  return out;
}

function signMac(path: string): void {
  if (platform() !== "darwin") {
    console.warn(`  ! ${path} is not re-signed (codesign needs macOS)`);
    return;
  }
  // Bun appends the app to an already-signed runtime, invalidating the signature; Apple Silicon needs a valid one.
  run("codesign", ["--force", "--sign", "-", path]);
  run("codesign", ["--verify", "--strict", path]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const gzip = args.includes("--gzip");
  const c2paIndex = args.indexOf("--c2pa-node");
  const c2paPath = c2paIndex >= 0 ? args[c2paIndex + 1] : undefined;
  const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--c2pa-node" && args[i - 1] !== "--root").map((a) => (a === "host" ? hostPlatform() : a));
  const selected = names.length ? names : Object.keys(TARGETS);
  mkdirSync(OUT, { recursive: true });

  for (const name of selected) {
    const target = TARGETS[name];
    if (!target) throw new Error(`Unknown platform "${name}". Choose from: host, ${Object.keys(TARGETS).join(", ")}`);
    console.log(`→ ${name} (${target.bun})`);
    const modules = sharpModules(name, target);
    const files: [string, string][] = [];
    for (const pkg of [`sharp-${target.sharp}`, `sharp-libvips-${target.sharp}`]) {
      const lib = join(modules, "@img", pkg, "lib");
      for (const f of readdirSync(lib)) if (/\.(node|dylib|dll)$|\.so(\.\d+)*$/.test(f)) files.push([`@img/${pkg}/lib/${f}`, join(lib, f)]);
    }
    if (!files.some(([rel]) => rel.endsWith(".node"))) throw new Error(`sharp's addon for ${name} was not found in ${modules}`);
    files.push(["@contentauth/c2pa-node/dist/index.node", await c2paAddon(name, target, c2paPath)]);
    const assets = writeAssets(name, files);
    const outfile = join(OUT, `imgwand-${name}`);
    run("bun", [join(SCRIPTS, "bun-compile.ts"), "--root", ROOT, "--target", target.bun, "--assets", assets, "--outfile", outfile]);
    // The embedded libraries make the binary large; a small one means the asset module was not swapped in.
    const size = (await import("node:fs")).statSync(outfile).size;
    const embedded = files.reduce((n, [, path]) => n + (readFileSync(path).length), 0);
    if (size < embedded) throw new Error(`${outfile} is ${size} bytes but should embed ${embedded} bytes of native libraries`);
    if (name.startsWith("darwin-")) signMac(outfile);
    if (gzip) await pipeline(createReadStream(outfile), createGzip({ level: 9 }), createWriteStream(`${outfile}.gz`));
    console.log(`  ✓ ${outfile}`);
  }
}

await main();
