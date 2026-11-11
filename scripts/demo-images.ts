/**
 * Writes a folder of demo images with rich metadata (for trying the TUI and for screenshots):
 *
 *   tsx scripts/demo-images.ts <dir>
 *
 *   sunset.jpg   EXIF (GPS, thumbnail, MakerNote), XMP, IPTC, ICC, comment, signed C2PA manifest (test certificate)
 *   alfama.png   eXIf, XMP, ICC, text chunks, tIME
 *   pixel.webp   EXIF, XMP, ICC
 *   plain.jpg    no metadata at all
 *   archive/old.jpg
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signC2pa } from "../packages/core/src/index.js";
import { fullJpeg, fullPng, fullWebp, plainJpeg, testSigner } from "../packages/core/test/helpers/fixtures.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: tsx scripts/demo-images.ts <dir>");
  process.exit(2);
}
mkdirSync(join(dir, "archive"), { recursive: true });

const jpeg = await fullJpeg({ width: 960, height: 600 });
const signed = await signC2pa(jpeg, "image/jpeg", {
  signer: testSigner(),
  title: "sunset.jpg",
  digitalSourceType: "digitalCapture",
  assertions: [{ label: "cawg.training-mining", data: { entries: { "cawg.ai_generative_training": { use: "notAllowed" }, "cawg.ai_inference": { use: "notAllowed" } } } }],
});
writeFileSync(join(dir, "sunset.jpg"), signed);
writeFileSync(join(dir, "alfama.png"), await fullPng());
writeFileSync(join(dir, "pixel.webp"), await fullWebp());
writeFileSync(join(dir, "plain.jpg"), await plainJpeg(640, 400));
writeFileSync(join(dir, "archive", "old.jpg"), await fullJpeg({ width: 480, height: 300 }));
console.log(`wrote demo images to ${dir}`);
