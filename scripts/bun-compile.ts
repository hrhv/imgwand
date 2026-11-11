/**
 * Compiles the CLI into a standalone executable with Bun (run by scripts/build-binaries.ts, under Bun):
 *
 *   bun scripts/bun-compile.ts --target bun-darwin-arm64 --assets <generated assets.ts> --outfile dist/bin/imgwand-darwin-arm64
 *
 * Plugins:
 *  - the library is bundled from source (packages/core/src), not from its build output;
 *  - the CLI's native-asset stub is swapped for the generated module that embeds this platform's libraries;
 *  - sharp's loader is pointed at the extracted addon (it otherwise requires "@img/sharp-<platform>/sharp.node",
 *    which does not exist inside a single-file executable);
 *  - Ink's optional React DevTools integration is stubbed out.
 */
import { fileURLToPath } from "node:url";

declare const Bun: {
  build(options: Record<string, unknown>): Promise<{ success: boolean; logs: unknown[] }>;
  file(path: string): { text(): Promise<string> };
};

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || !args[i + 1]) throw new Error(`missing --${name}`);
  return args[i + 1]!;
};
const target = arg("target");
const assets = arg("assets");
const outfile = arg("outfile");
// The checkout to build; build-binaries.ts passes it explicitly (in CI the tooling and the source differ).
const root = `${(args.includes("--root") ? arg("root") : fileURLToPath(new URL("..", import.meta.url))).replace(/\/$/, "")}/`;

const result = await Bun.build({
  entrypoints: [`${root}packages/cli/src/native/entry.ts`],
  compile: { target, outfile },
  minify: true,
  sourcemap: "none",
  define: { "process.env.DEV": '"false"' },
  plugins: [
    {
      name: "imgwand-binary",
      setup(build: {
        onResolve(o: { filter: RegExp }, cb: (a: { path: string; importer: string }) => { path: string; namespace?: string } | undefined): void;
        onLoad(o: { filter: RegExp; namespace?: string }, cb: (a: { path: string }) => Promise<{ contents: string; loader: string }> | { contents: string; loader: string }): void;
      }) {
        build.onResolve({ filter: /^@hrhv\/imgwand$/ }, () => ({ path: `${root}packages/core/src/index.ts` }));
        build.onResolve({ filter: /^\.\/assets\.js$/ }, (a) => (/[\\/]native[\\/]entry\.ts$/.test(a.importer) ? { path: assets } : undefined));
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js" }));
        build.onLoad({ filter: /[\\/]sharp[\\/]dist[\\/]sharp\.(mjs|cjs)$/ }, async (a) => {
          const source = await Bun.file(a.path).text();
          const patched = source.replace(/require\("@img\/sharp-[^"]+\/sharp\.node"\)/g, "require(process.env.IMGWAND_SHARP_NODE)");
          if (patched === source) throw new Error("sharp's loader changed; update the patch in scripts/bun-compile.ts");
          return { contents: patched, loader: "js" };
        });
      },
    },
  ],
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
