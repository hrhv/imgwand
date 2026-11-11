// Sets the release version everywhere it is recorded, so the packages, the binaries' `--version` and the lockfile
// agree (a unit test fails if they don't):
//
//   packages/core/package.json         version
//   packages/cli/package.json          version, and its dependency on @hrhv/imgwand
//   packages/core/src/version.ts       VERSION
//   package-lock.json                  refreshed with `npm install --package-lock-only`
//
// Usage: npx tsx scripts/set-version.ts 0.2.0          (or 0.2.0-rc.1 for a prerelease; a leading "v" is accepted)
//        npx tsx scripts/set-version.ts 0.2.0 --no-lock  (skip the lockfile refresh)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const raw = args.find((a) => !a.startsWith("--"));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

if (!raw || args.includes("--help") || args.includes("-h")) {
  console.error("usage: npx tsx scripts/set-version.ts <version> [--no-lock]   e.g. 0.2.0 or 0.2.0-rc.1");
  process.exit(raw ? 0 : 2);
}
const version = raw.replace(/^v/, "");
if (!SEMVER.test(version)) {
  console.error(`not a semantic version: ${raw}`);
  process.exit(2);
}

/** Replaces exactly one match of `pattern` in a file, keeping the rest of the file byte-for-byte. */
function replaceOnce(file: string, pattern: RegExp, replacement: string): void {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const count = text.match(new RegExp(pattern.source, `${pattern.flags}g`))?.length ?? 0;
  if (count !== 1) throw new Error(`${file}: expected one match for ${pattern}, found ${count}`);
  writeFileSync(path, text.replace(pattern, replacement));
}

const previous = (JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")) as { version: string }).version;
replaceOnce("packages/core/package.json", /^ {2}"version": "[^"]+",$/m, `  "version": "${version}",`);
replaceOnce("packages/cli/package.json", /^ {2}"version": "[^"]+",$/m, `  "version": "${version}",`);
replaceOnce("packages/cli/package.json", /^( +)"@hrhv\/imgwand": "[^"]+"(,?)$/m, `$1"@hrhv/imgwand": "${version}"$2`);
replaceOnce("packages/core/src/version.ts", /^export const VERSION = "[^"]+";$/m, `export const VERSION = "${version}";`);
console.log(`version ${previous} → ${version} in packages/core, packages/cli and version.ts`);

if (!args.includes("--no-lock")) {
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
  });
  console.log("package-lock.json refreshed");
}
