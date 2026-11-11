/**
 * Native libraries embedded in a standalone binary. This is the stub used by the npm package (which loads the
 * libraries from node_modules); scripts/build-binaries.ts swaps in a generated module that embeds the files.
 */
export const NATIVE_KEY = "";
/** [path relative to the extraction directory, path of the embedded file] */
export const NATIVE_FILES: readonly (readonly [string, string])[] = [];
export const NATIVE_SHA256: Readonly<Record<string, string>> = {};
export const C2PA_NODE_VERSION = "";
