import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  // The library and the runtime dependencies are installed next to the CLI; only our own code is bundled.
  external: ["@hrhv/imgwand", "ink", "react", "commander", "sharp", "@contentauth/c2pa-node"],
  banner: { js: "#!/usr/bin/env node" },
});
