import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against the library's source, not its build output.
    alias: { "@hrhv/imgwand": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["packages/*/src/index.ts", "packages/cli/src/native/**"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        "packages/core/src/**": { lines: 90, functions: 90, branches: 80, statements: 90 },
        "packages/cli/src/**": { lines: 80, functions: 80, branches: 70, statements: 80 },
      },
    },
  },
});
