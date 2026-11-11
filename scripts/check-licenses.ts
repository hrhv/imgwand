/**
 * Fails when a runtime dependency (of either package) has a license that is not compatible with distributing
 * imgwand under MPL-2.0, including inside the standalone binaries.
 *
 *   tsx scripts/check-licenses.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ALLOWED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "MPL-2.0", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Python-2.0", "CC-BY-4.0"]);
/** libvips is LGPL; sharp ships it as a separate shared library, which LGPL allows. */
const EXCEPTIONS: Record<string, string> = { "@img/sharp-libvips-": "LGPL-3.0-or-later" };
/** Packages whose package.json lacks the SPDX field, with the license from their LICENSE file (checked by hand). */
const VERIFIED: Record<string, string> = { "@contentauth/c2pa-types": "MIT" };
/** "MIT/X11" is the MIT license under its old name. */
const ALIASES: Record<string, string> = { "MIT/X11": "MIT" };
/**
 * Dependencies only c2pa-node's postinstall download script uses (unzip, progress bar, ...). They run at install
 * time on the user's machine, are never imported at runtime, and are not part of the standalone binaries.
 */
const INSTALL_ONLY = new Set(["unzipper", "cli-progress", "pretty-bytes", "cargo-cp-artifact"]);

interface Manifest {
  name: string;
  version: string;
  license?: string | { type: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const read = (dir: string): Manifest | undefined => {
  const file = join(dir, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : undefined;
};

function allowed(name: string, license: string): boolean {
  for (const [prefix, lic] of Object.entries(EXCEPTIONS)) if (name.startsWith(prefix) && license === lic) return true;
  // SPDX "A OR B" (either is fine), "(A AND B)" (all must be fine).
  const expr = license.replace(/[()]/g, "");
  if (expr.includes(" OR ")) return expr.split(" OR ").some((l) => ALLOWED.has(l.trim()));
  return expr.split(" AND ").every((l) => ALLOWED.has(l.trim()));
}

const seen = new Map<string, string>();
const problems: string[] = [];
const visit = (name: string, from: string) => {
  if (seen.has(name) || INSTALL_ONLY.has(name)) return;
  const dir = [join(ROOT, from, "node_modules", name), join(ROOT, "node_modules", name)].find(existsSync);
  const manifest = dir ? read(dir) : undefined;
  if (!manifest) return; // optional dependency for another platform
  const declared = typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? VERIFIED[name] ?? "UNKNOWN");
  const license = ALIASES[declared] ?? declared;
  seen.set(name, license);
  if (!allowed(name, license)) problems.push(`${name}@${manifest.version}: ${license}`);
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) visit(dep, from);
};

for (const pkg of ["packages/core", "packages/cli"]) {
  const manifest = read(join(ROOT, pkg))!;
  for (const dep of Object.keys(manifest.dependencies ?? {})) if (!dep.startsWith("@hrhv/")) visit(dep, pkg);
}

const counts = new Map<string, number>();
for (const license of seen.values()) counts.set(license, (counts.get(license) ?? 0) + 1);
console.log(`${seen.size} runtime dependencies: ${[...counts].map(([l, n]) => `${l} ×${n}`).join(", ")}`);
if (problems.length > 0) {
  console.error(`Licenses not compatible with MPL-2.0 distribution:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
