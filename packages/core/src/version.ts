/** The library version. A test keeps this in sync with package.json. */
export const VERSION = "0.1.0-alpha.1";

export interface RuntimeVersions {
  readonly imgwand: string;
  readonly sharp?: string;
  readonly libvips?: string;
  readonly c2pa?: string;
}

/** Versions of the native libraries in use. Loads them, so call it only when the answer is wanted. */
export async function runtimeVersions(): Promise<RuntimeVersions> {
  let sharp: string | undefined;
  let libvips: string | undefined;
  let c2pa: string | undefined;
  try {
    const m = (await import("sharp")).default;
    sharp = m.versions.sharp;
    libvips = m.versions.vips;
  } catch {
    // reported as missing
  }
  try {
    // The SDK reports the c2pa-rs version it was built with in the claim generator info of what it signs; the
    // npm package version is the closest stable identifier available without signing anything.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    c2pa = (require("@contentauth/c2pa-node/package.json") as { version: string }).version;
  } catch {
    c2pa = undefined;
  }
  return { imgwand: VERSION, sharp, libvips, c2pa };
}
