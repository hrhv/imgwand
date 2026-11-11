import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editMetadata, samePixels, signC2pa, stripAll } from "../../src/index.js";
import { fullJpeg, fullPng, fullWebp, testSigner } from "../helpers/fixtures.js";

/**
 * Cross-checks edited files with ExifTool, an independent and very strict reader. CI installs it; locally the
 * suite is skipped when it is missing.
 */
const hasExiftool = spawnSync("exiftool", ["-ver"]).status === 0;
// CI sets this, so a broken ExifTool install fails the build instead of silently skipping the cross-checks.
if (!hasExiftool && process.env.IMGWAND_REQUIRE_EXIFTOOL) throw new Error("ExifTool is required (IMGWAND_REQUIRE_EXIFTOOL) but `exiftool -ver` failed");
const dir = mkdtempSync(join(tmpdir(), "imgwand-exiftool-"));
let counter = 0;

interface ExiftoolResult {
  readonly tags: Record<string, unknown>;
  readonly warnings: string[];
}

function exiftool(bytes: Uint8Array, ...args: string[]): ExiftoolResult {
  const file = join(dir, `f${counter++}`);
  writeFileSync(file, bytes);
  const json = spawnSync("exiftool", ["-j", "-G1", "-a", ...args, file], { encoding: "utf8" });
  const validate = spawnSync("exiftool", ["-validate", "-warning", "-error", "-a", "-s3", file], { encoding: "utf8" });
  const tags = (JSON.parse(json.stdout) as Record<string, unknown>[])[0]!;
  return { tags, warnings: validate.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !/^(OK|\d+ (Warnings?|Errors?))/.test(l)) };
}

/** Warnings that are about the fixtures themselves (minimal EXIF, deliberately stale digest), not about edits. */
const BASELINE = /Missing required|Unrecognized MakerNotes|IPTCDigest is not current|Improper EXIF header|XMP is missing xpacket/;
function problems(result: ExiftoolResult): string[] {
  return result.warnings.filter((w) => !BASELINE.test(w));
}

describe.skipIf(!hasExiftool)("ExifTool cross-validation", () => {
  it("sees GPS and identifying tags disappear while everything else stays", async () => {
    const bytes = await fullJpeg();
    const before = exiftool(bytes).tags;
    expect(before["GPS:GPSLatitude"]).toBeDefined();
    const out = editMetadata(bytes, { remove: ["privacy"] });
    const result = exiftool(out.bytes);
    expect(problems(result)).toEqual([]);
    const after = result.tags;
    for (const tag of ["GPS:GPSLatitude", "IFD0:Artist", "ExifIFD:SerialNumber", "ExifIFD:LensSerialNumber", "XMP-dc:Creator", "IPTC:By-line", "IFD1:ThumbnailImage", "File:Comment"]) {
      expect(after[tag], tag).toBeUndefined();
    }
    for (const tag of ["IFD0:Make", "IFD0:Model", "ExifIFD:FNumber", "ExifIFD:ISO", "XMP-xmp:Rating", "XMP-xmp:CreatorTool", "IPTC:Keywords", "ICC-header:ColorSpaceData"]) {
      expect(after[tag], tag).toEqual(before[tag]);
    }
    expect(after["Photoshop:IPTCDigest"]).toBe(after["File:CurrentIPTCDigest"]);
    expect(await samePixels(bytes, out.bytes)).toBe(true);
  });

  it("agrees with values imgwand writes", async () => {
    const out = editMetadata(await fullJpeg(), {
      set: {
        "exif:IFD0:Artist": "Zoë Q",
        "exif:IFD0:XPComment": "hello xp",
        "exif:ExifIFD:UserComment": "a comment",
        "exif:GPS:GPSLatitude": "51.5007",
        "exif:IFD0:ImageDescription": "A brand new tag",
        "xmp:dc:description": "desc",
        "iptc:Keywords": "x; y",
        "comment:COM": "new comment",
      },
    });
    const result = exiftool(out.bytes, "-n");
    expect(problems(result)).toEqual([]);
    const info = result.tags;
    expect(info["IFD0:Artist"]).toBe("Zoë Q");
    expect(info["IFD0:XPComment"]).toBe("hello xp");
    expect(info["ExifIFD:UserComment"]).toBe("a comment");
    expect(Number(info["GPS:GPSLatitude"])).toBeCloseTo(51.5007, 3);
    expect(info["IFD0:ImageDescription"]).toBe("A brand new tag");
    expect(info["XMP-dc:Description"]).toBe("desc");
    expect(info["IPTC:Keywords"]).toEqual(["x", "y"]);
    expect(info["File:Comment"]).toBe("new comment");
  });

  it("validates stripped PNG and WebP files", async () => {
    for (const bytes of [await fullPng(), await fullWebp()]) {
      const out = stripAll(bytes, { keepIcc: true });
      const result = exiftool(out.bytes);
      expect(problems(result)).toEqual([]);
      const info = result.tags;
      expect(Object.keys(info).some((k) => k.startsWith("XMP") || k.startsWith("GPS") || k === "IFD0:Artist")).toBe(false);
      expect(await samePixels(bytes, out.bytes)).toBe(true);
    }
  });

  it("finds no JUMBF/C2PA after removing Content Credentials", async () => {
    const signed = await signC2pa(await fullJpeg(), "image/jpeg", { signer: testSigner(), digitalSourceType: "digitalCapture" });
    expect(Object.keys(exiftool(signed).tags).some((k) => k.startsWith("JUMBF"))).toBe(true);
    const out = editMetadata(signed, { remove: ["c2pa"] });
    expect(Object.keys(exiftool(out.bytes).tags).some((k) => k.startsWith("JUMBF"))).toBe(false);
  });

  it("validates big-endian EXIF edits", async () => {
    const out = editMetadata(await fullJpeg({ littleEndian: false }), { remove: ["gps", "thumbnail"], set: { "exif:IFD0:Software": "imgwand big-endian" } });
    const result = exiftool(out.bytes);
    expect(problems(result)).toEqual([]);
    const info = result.tags;
    expect(info["IFD0:Software"]).toBe("imgwand big-endian");
    expect(info["ExifIFD:ExifByteOrder"] ?? info["File:ExifByteOrder"]).toMatch(/Big-endian/);
  });
});
