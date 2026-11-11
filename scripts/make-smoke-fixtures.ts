/**
 * Regenerates the small sample images the smoke test uses (committed in scripts/smoke/):
 *   tsx scripts/make-smoke-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signC2pa } from "../packages/core/src/index.js";
import { fullJpeg, fullPng, testSigner } from "../packages/core/test/helpers/fixtures.js";

const dir = join(import.meta.dirname, "smoke");
mkdirSync(dir, { recursive: true });
const jpeg = await fullJpeg({ width: 96, height: 60 });
writeFileSync(join(dir, "sample.jpg"), jpeg);
writeFileSync(join(dir, "sample.png"), await fullPng());
writeFileSync(
  join(dir, "signed.jpg"),
  await signC2pa(jpeg, "image/jpeg", {
    signer: testSigner(),
    title: "signed.jpg",
    digitalSourceType: "digitalCapture",
    assertions: [{ label: "cawg.training-mining", data: { entries: { "cawg.ai_inference": { use: "notAllowed" } } } }],
  }),
);
console.log(`wrote ${dir}`);
