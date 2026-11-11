import { mkdtempSync, readFileSync, statSync, chmodSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import coreManifest from "../../package.json" with { type: "json" };
import cliManifest from "../../../cli/package.json" with { type: "json" };
import {
  ImageDocument,
  VERSION,
  editMetadata,
  imageInfo,
  inspect,
  readImageFile,
  readMetadata,
  removeMetadata,
  renderPaletted,
  renderPng,
  renderRaster,
  resolveSelectors,
  runtimeVersions,
  samePicture,
  samePixels,
  setMetadata,
  stripAll,
  suggest,
  writeFileAtomic,
  parseContainer,
  ImgwandError,
  isImgwandError,
} from "../../src/index.js";
import { fullJpeg, fullPng, fullWebp, plainJpeg, withSegments, xmpSegment, XMP_PACKET } from "../helpers/fixtures.js";

const ids = (bytes: Uint8Array) => inspect(bytes).fields.map((f) => f.id);
const tmp = () => mkdtempSync(join(tmpdir(), "imgwand-test-"));

describe("selectors", () => {
  it("resolves ids, names, globs, groups, presets and exclusions", async () => {
    const { fields } = inspect(await fullJpeg());
    const r = (...s: string[]) => [...resolveSelectors(fields, s).ids].sort();
    expect(r("exif:IFD0:Make")).toEqual(["exif:IFD0:Make"]);
    expect(r("EXIF:ifd0:make")).toEqual(["exif:IFD0:Make"]);
    expect(r("Make")).toEqual(["exif:IFD0:Make"]);
    expect(r("exif:GPS:*").every((id) => id.startsWith("exif:GPS:"))).toBe(true);
    expect(r("gps")).toEqual(expect.arrayContaining(["exif:GPS:GPSLatitude", "xmp:exif:GPSLatitude"]));
    expect(r("location")).toEqual(r("gps"));
    expect(r("comments")).toEqual(["comment:COM"]);
    expect(r("exif").length).toBeGreaterThan(20);
    expect(r("all", "!exif", "!xmp", "!iptc", "!icc", "!photoshop", "!comment")).toEqual([]);
    expect(r("exif:IFD0:*", "-exif:IFD0:Make")).not.toContain("exif:IFD0:Make");
  });

  it("expands block and group removals to everything that must go with them", async () => {
    const { fields } = inspect(await fullJpeg());
    const thumb = [...resolveSelectors(fields, ["exif:IFD1:XResolution"]).ids];
    expect(thumb.length).toBeGreaterThan(3);
    expect(thumb.every((id) => id.startsWith("exif:IFD1:"))).toBe(true);
    const icc = [...resolveSelectors(fields, ["icc:Copyright"]).ids];
    expect(icc.every((id) => id.startsWith("icc:"))).toBe(true);
    expect(icc.length).toBeGreaterThan(5);
    // Excluding part of something that only goes as a whole keeps all of it.
    expect([...resolveSelectors(fields, ["exif:IFD1:*", "!exif:IFD1:XResolution"]).ids]).toEqual([]);
  });

  it("privacy takes identifying fields but never C2PA or the color profile", async () => {
    const { fields } = inspect(await fullJpeg());
    const privacy = [...resolveSelectors(fields, ["privacy"]).ids];
    for (const id of ["exif:IFD0:Artist", "exif:ExifIFD:SerialNumber", "exif:ExifIFD:LensSerialNumber", "exif:ExifIFD:MakerNote", "exif:GPS:GPSLatitude", "xmp:dc:creator", "xmp:xmpMM:DocumentID", "iptc:By-line", "iptc:City", "comment:COM"]) {
      expect(privacy).toContain(id);
    }
    expect(privacy.some((id) => id.startsWith("exif:IFD1:"))).toBe(true);
    for (const id of ["exif:IFD0:Make", "exif:ExifIFD:FNumber", "xmp:xmp:Rating", "iptc:Keywords"]) expect(privacy).not.toContain(id);
    expect(privacy.some((id) => id.startsWith("icc:") || id.startsWith("c2pa:"))).toBe(false);
  });

  it("reports unmatched exact selectors, refuses unremovable fields, and suggests", async () => {
    const { fields } = inspect(await fullJpeg());
    expect(resolveSelectors(fields, ["exif:IFD0:Nope", "nonexistent", "nomatch:*", "  "]).unmatched).toEqual(["exif:IFD0:Nope", "nonexistent"]);
    expect(resolveSelectors(fields, ["!exif:IFD0:Nope"]).unmatched).toEqual([]);
    expect(suggest(fields, "serial")).toEqual(expect.arrayContaining(["exif:ExifIFD:SerialNumber"]));
    const withWarning = [...fields, { id: "exif:warning:0", group: "exif" as const, section: "Warnings", name: "Warning", value: "x", removal: "none" as const, writable: false, sensitive: false, blockIds: [1] }];
    expect(() => resolveSelectors(withWarning, ["exif:warning:0"])).toThrow(/cannot be removed/);
  });
});

describe("editMetadata", () => {
  it("removes fields losslessly from JPEG, PNG and WebP", async () => {
    for (const bytes of [await fullJpeg(), await fullPng(), await fullWebp()]) {
      const out = editMetadata(bytes, { remove: ["gps", "privacy"] });
      expect(out.changed).toBe(true);
      expect(ids(out.bytes).some((id) => id.includes("GPS"))).toBe(false);
      expect(samePicture(parseContainer(bytes), parseContainer(out.bytes))).toBe(true);
      expect(await samePixels(bytes, out.bytes)).toBe(true);
    }
  });

  it("never modifies the caller's buffer, even a Node Buffer", async () => {
    const original = Buffer.from(await fullJpeg());
    const snapshot = Buffer.from(original);
    editMetadata(original, { remove: ["all"], set: {} });
    editMetadata(original, { remove: ["exif:IFD0:Artist"], set: { "exif:IFD0:Software": "x" } });
    expect(original.equals(snapshot)).toBe(true);
  });

  it("is a no-op (same bytes) when nothing matches", async () => {
    const bytes = await plainJpeg();
    const out = editMetadata(bytes, { remove: ["gps"] });
    expect(out.changed).toBe(false);
    expect(out.bytes).toBe(bytes);
    expect(editMetadata(bytes, {}).changed).toBe(false);
  });

  it("validates requests", async () => {
    const bytes = await fullJpeg();
    expect(() => editMetadata(bytes, { remove: ["exif:IFD0:Nope"] })).toThrow(/No such field/);
    expect(() => editMetadata(bytes, { remove: ["Serial"] })).toThrow(/did you mean/);
    expect(() => editMetadata(bytes, { remove: ["exif:IFD0:Make"], set: { "exif:IFD0:Make": "x" } })).toThrow(/both removed and set/);
    expect(() => editMetadata(bytes, { set: { "exif:ExifIFD:MakerNote": "x" } })).toThrow(/not writable/);
    expect(() => editMetadata(bytes, { set: { "mystery:field": "x" } })).toThrow(/Don't know how to set/);
    expect(() => editMetadata(bytes, { set: { "exif:Nope:Make": "x" } })).toThrow(/Don't know how to set|Unknown EXIF field/);
    expect(() => editMetadata(new Uint8Array(10), {})).toThrow(ImgwandError);
  });

  it("creates EXIF in a file that has none, and removes the block when emptied", async () => {
    const created = editMetadata(await plainJpeg(), { set: { "exif:IFD0:Artist": "Jane", "exif:GPS:GPSLatitude": "12.5", "exif:GPS:GPSLatitudeRef": "N" } });
    expect(ids(created.bytes)).toEqual(expect.arrayContaining(["exif:IFD0:Artist", "exif:GPS:GPSLatitude"]));
    const emptied = editMetadata(created.bytes, { remove: ["exif"] });
    expect(parseContainer(emptied.bytes).blocks.some((b) => b.kind === "exif")).toBe(false);
  });

  it("sets EXIF while removing other EXIF fields in the same pass", async () => {
    const out = editMetadata(await fullJpeg(), { remove: ["exif:GPS:*"], set: { "exif:IFD0:Artist": "Anon" } });
    expect(inspect(out.bytes).fields.find((f) => f.id === "exif:IFD0:Artist")?.value).toBe("Anon");
    expect(ids(out.bytes).some((id) => id.startsWith("exif:GPS:"))).toBe(false);
  });

  it("refuses to set EXIF while dropping the EXIF block", async () => {
    const bytes = await fullJpeg();
    const unreadable = withSegments(await plainJpeg(), (await import("../helpers/fixtures.js")).exifSegment(new TextEncoder().encode("garbage!garbage!")));
    expect(inspect(unreadable).fields.find((f) => f.id.startsWith("exif:block"))?.removal).toBe("block");
    expect(() => editMetadata(unreadable, { remove: [inspect(unreadable).fields.find((f) => f.id.startsWith("exif:block"))!.id], set: { "exif:IFD0:Artist": "x" } })).toThrow(/whole EXIF block/);
    expect(editMetadata(bytes, { remove: ["exif:IFD0:Orientation"] }).warnings.join(" ")).toMatch(/rotated/);
  });

  it("stripAll keeps the ICC profile and Orientation by default", async () => {
    const out = stripAll(await fullJpeg());
    const left = ids(out.bytes);
    expect(left).toContain("exif:IFD0:Orientation");
    expect(left.some((id) => id.startsWith("icc:"))).toBe(true);
    expect(left.filter((id) => !id.startsWith("icc:") && id !== "exif:IFD0:Orientation")).toEqual([]);
    const bare = stripAll(await fullJpeg(), { keepIcc: false, keepOrientation: false });
    expect(ids(bare.bytes)).toEqual([]);
  });

  it("removeMetadata and setMetadata are shortcuts", async () => {
    const bytes = await fullJpeg();
    expect(ids(removeMetadata(bytes, ["comment"]))).not.toContain("comment:COM");
    expect(inspect(setMetadata(bytes, { "exif:IFD0:Software": "imgwand" })).fields.find((f) => f.id === "exif:IFD0:Software")?.value).toBe("imgwand");
  });

  it("isImgwandError recognizes expected errors", () => {
    expect(isImgwandError(new ImgwandError("IO_ERROR", "x"))).toBe(true);
    expect(isImgwandError(new Error("x"))).toBe(false);
  });
});

describe("readMetadata", () => {
  it("summarizes blocks and works without C2PA", async () => {
    const report = await readMetadata(await fullJpeg(), { c2pa: false });
    expect(report.format).toBe("jpeg");
    expect(report.mimeType).toBe("image/jpeg");
    expect(report.blocks.some((b) => b.kind === "exif" && b.size > 100)).toBe(true);
    expect(report.c2pa).toBeNull();
  });
});

describe("ImageDocument", () => {
  it("stages, undoes, previews and saves edits", async () => {
    const dir = tmp();
    const path = join(dir, "photo.jpg");
    writeFileSync(path, await fullJpeg());
    const doc = await ImageDocument.open(path);
    expect(doc.dirty).toBe(false);
    const staged = doc.stageRemove(["gps"]);
    expect(staged.size).toBeGreaterThan(3);
    doc.stageSet("exif:IFD0:Artist", "Anon");
    expect(doc.pendingSets.get("exif:IFD0:Artist")).toBe("Anon");
    expect(doc.dirty).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.pendingSets.size).toBe(0);
    doc.unstageRemove(["exif:GPS:*"]);
    expect([...doc.pendingRemovals].some((id) => id.startsWith("exif:GPS:"))).toBe(false);
    doc.discard();
    expect(doc.dirty).toBe(false);
    expect(doc.undo()).toBe(true);
    expect(doc.dirty).toBe(true);
    expect(() => doc.stageRemove(["nope:nope"])).toThrow(/No such field/);

    const preview = doc.preview();
    expect(preview.changed).toBe(true);
    expect(readFileSync(path)).toEqual(Buffer.from(await readImageFile(path))); // preview wrote nothing
    const { outcome, written } = await doc.save(undefined, { backup: true });
    expect(outcome.removed.length).toBeGreaterThan(0);
    expect(written?.backupPath).toBe(`${path}.bak`);
    expect(doc.dirty).toBe(false);
    // EXIF GPS was un-staged above; only the XMP GPS property was still staged.
    expect(doc.fields.some((f) => f.id === "xmp:exif:GPSLatitude")).toBe(false);
    expect(doc.fields.some((f) => f.id.startsWith("exif:GPS:"))).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(doc.bytes);
    while (doc.undo());
    expect(doc.undo()).toBe(false);

    await doc.replaceBytes(await plainJpeg());
    expect(doc.fields).toEqual([]);
  });

  it("works on in-memory bytes without a path", async () => {
    const doc = await ImageDocument.open(await fullJpeg());
    expect(doc.path).toBeUndefined();
    doc.stageRemove(["comment"]);
    const { written } = await doc.save();
    expect(written).toBeUndefined();
    expect(doc.fields.some((f) => f.id === "comment:COM")).toBe(false);
  });
});

describe("file I/O", () => {
  it("writes atomically, preserves the mode and never overwrites backups", async () => {
    const dir = tmp();
    const path = join(dir, "a.jpg");
    writeFileSync(path, "one");
    chmodSync(path, 0o640);
    const first = await writeFileAtomic(path, new TextEncoder().encode("two"), { backup: true });
    expect(first.backupPath).toBe(`${path}.bak`);
    const second = await writeFileAtomic(path, new TextEncoder().encode("three"), { backup: true });
    expect(second.backupPath).toBe(`${path}.bak.1`);
    expect(readFileSync(path, "utf8")).toBe("three");
    expect(readFileSync(`${path}.bak`, "utf8")).toBe("one");
    expect(readFileSync(`${path}.bak.1`, "utf8")).toBe("two");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const custom = await writeFileAtomic(path, new TextEncoder().encode("four"), { backup: join(dir, "keep.orig") });
    expect(custom.backupPath).toBe(join(dir, "keep.orig"));
    const fresh = await writeFileAtomic(join(dir, "new.jpg"), new Uint8Array([1]), { backup: true });
    expect(fresh.backupPath).toBeUndefined();
    expect(statSync(join(dir, "new.jpg")).mode & 0o777).toBe(0o644);
  });

  it("refuses non-files and unwritable targets cleanly", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "sub"));
    await expect(writeFileAtomic(join(dir, "sub"), new Uint8Array(1))).rejects.toThrow(/not a regular file/);
    await expect(writeFileAtomic(join(dir, "missing", "x.jpg"), new Uint8Array(1))).rejects.toThrow(/Cannot write/);
    expect(existsSync(join(dir, "missing"))).toBe(false);
    await expect(readImageFile(join(dir, "nope.jpg"))).rejects.toThrow(/no such file/);
    await expect(readImageFile(join(dir, "sub"))).rejects.toThrow(/not a regular file/);
    writeFileSync(join(dir, "big.jpg"), new Uint8Array(100));
    await expect(readImageFile(join(dir, "big.jpg"), 10)).rejects.toThrow(/limit/);
  });
});

describe("pixels (sharp)", () => {
  it("reports image facts including orientation", async () => {
    const rotated = await sharp(await plainJpeg(40, 20)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const info = await imageInfo(rotated);
    expect([info.width, info.height, info.displayWidth, info.displayHeight, info.orientation]).toEqual([40, 20, 20, 40, 6]);
    await expect(imageInfo(new Uint8Array(20))).rejects.toThrow(ImgwandError);
  });

  it("renders scaled rasters, PNGs and paletted images", async () => {
    const bytes = await fullJpeg();
    const raster = await renderRaster(bytes, { width: 40, height: 40 });
    expect(raster.width).toBe(40);
    expect(raster.data.length).toBe(raster.width * raster.height * 4);
    const png = await renderPng(bytes, { width: 64, height: 64 });
    expect((await sharp(png.png).metadata()).format).toBe("png");
    for (const colors of [256, 16, 4, 2]) {
      const pal = await renderPaletted(bytes, { width: 33, height: 20, colors });
      expect(pal.indices.length).toBe(pal.width * pal.height);
      expect(Math.max(...pal.indices)).toBeLessThan(pal.palette.length / 3);
      expect(pal.palette.length / 3).toBeLessThanOrEqual(colors);
    }
    const flat = await renderRaster(new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()), { width: 4, height: 4, background: "#ff0000" });
    expect([...flat.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    await expect(renderRaster(new Uint8Array(10), { width: 1, height: 1 })).rejects.toThrow(ImgwandError);
    await expect(renderPng(new Uint8Array(10), { width: 1, height: 1 })).rejects.toThrow(ImgwandError);
  });

  it("compares decoded pixels", async () => {
    const a = await plainJpeg();
    expect(await samePixels(a, a)).toBe(true);
    expect(await samePixels(a, await plainJpeg(32, 32))).toBe(false);
  });
});

describe("versions", () => {
  it("keeps VERSION in sync with both package.json files", () => {
    expect(VERSION).toBe(coreManifest.version);
    expect(cliManifest.version).toBe(coreManifest.version);
    expect(cliManifest.dependencies["@hrhv/imgwand"]).toBe(coreManifest.version);
  });

  it("reports native library versions", async () => {
    const v = await runtimeVersions();
    expect(v.imgwand).toBe(VERSION);
    expect(v.sharp).toMatch(/^\d+\.\d+/);
    expect(v.libvips).toMatch(/^\d+\.\d+/);
    expect(v.c2pa).toMatch(/^\d+\.\d+/);
  });
});

it("XMP fixture helper is well-formed (sanity)", async () => {
  expect(ids(withSegments(await plainJpeg(), xmpSegment(XMP_PACKET())))).toContain("xmp:dc:title");
});
