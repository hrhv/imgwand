import { defineConfig } from "tsup";

// Declarations are emitted by `tsc -p tsconfig.build.json` (see the build script), not by tsup.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
