import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { parseContainer } from "../../src/container/index.js";
import { parsePng } from "../../src/container/png.js";
import { parseWebp } from "../../src/container/webp.js";
import { editMetadata, inspect, stripAll } from "../../src/document.js";
import { dmsToDecimal } from "../../src/exif/format.js";
import { gpsDms, encodeValue, parseTiff, readValue, removeTiffEntries, setTiffEntry } from "../../src/exif/tiff.js";
import { ImageDocument, ImgwandError, readC2pa, renderPaletted, samePixels, writeFileAtomic } from "../../src/index.js";
import { parseResources } from "../../src/iptc/handler.js";
import { ascii, buildTiff, comSegment, concat, exifSegment, iptcSegment, jpegSegment, plainJpeg, pngChunk, scene, short, withChunks, withSegments, xmpSegment, XMP_PACKET } from "../helpers/fixtures.js";

/** Regression tests for the issues found in code review (each named after what used to go wrong). */

const ids = (bytes: Uint8Array) => inspect(bytes).fields.map((f) => f.id);
const field = (bytes: Uint8Array, id: string) => inspect(bytes).fields.find((f) => f.id === id);

describe("EXIF", () => {
  it("a tag stored in the 'wrong' IFD can be removed by the id it is listed under", async () => {
    const tiff = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("X") }, { tag: 0x9003, value: ascii("2026:01:01 00:00:00") }] });
    const jpeg = withSegments(await plainJpeg(), exifSegment(tiff));
    expect(ids(jpeg)).toContain("exif:IFD0:DateTimeOriginal");
    const out = editMetadata(jpeg, { remove: ["exif:IFD0:DateTimeOriginal"] });
    expect(out.changed).toBe(true);
    expect(ids(out.bytes)).not.toContain("exif:IFD0:DateTimeOriginal");
    expect(ids(stripAll(jpeg, { keepIcc: false, keepOrientation: false }).bytes)).toEqual([]);
  });

  it("entries of unknown type are kept (not dropped or overwritten) by edits", () => {
    const bytes = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("Make") }, { tag: 0x0110, value: ascii("Model") }, { tag: 0x0131, value: ascii("Sw") }], ifd1: [{ tag: 0x011a, value: { type: 5, data: [72, 1] } }] });
    const t = parseTiff(bytes);
    const model = t.ifds.get("IFD0")!.entries.find((e) => e.tag === 0x0110)!;
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(model.entryOffset + 2, 99, true); // unknown type
    const weird = parseTiff(bytes);
    expect(weird.ifds.get("IFD0")!.entries.map((e) => [e.tag, e.known])).toEqual([[0x010f, true], [0x0110, false], [0x0131, true]]);
    const removed = parseTiff(removeTiffEntries(weird, [{ ifd: "IFD0", tag: 0x0131 }]));
    expect(removed.ifds.get("IFD0")!.entries.map((e) => e.tag)).toEqual([0x010f, 0x0110]);
    const grown = parseTiff(setTiffEntry(weird, "IFD0", 0x013b, "Artist"));
    expect(grown.ifds.get("IFD0")!.entries.map((e) => e.tag)).toEqual([0x010f, 0x0110, 0x0131, 0x013b]);
    expect(grown.ifds.has("IFD1")).toBe(true); // IFD0's next pointer still points at IFD1
    expect(readValue(weird, weird.ifds.get("IFD0")!.entries[1]!)).toBeUndefined();
  });

  it("refuses to rewrite an IFD whose table is truncated", () => {
    const bytes = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("M") }, { tag: 0x0110, value: ascii("N") }] });
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(8, 400, true); // claims 400 entries
    const t = parseTiff(bytes.slice(0, 8 + 2 + 24 + 2));
    expect(t.ifds.get("IFD0")!.truncated).toBe(true);
    expect(() => removeTiffEntries(t, [{ ifd: "IFD0", tag: 0x010f }])).toThrow(/truncated/);
  });

  it("validates numbers instead of wrapping or truncating them", () => {
    expect(() => encodeValue("ExifIFD", 0x8827, 3, "70000", true)).toThrow(/0 to 65535/);
    expect(() => encodeValue("IFD0", 0x0112, 3, "1.7", true)).toThrow(/whole numbers/);
    expect(() => encodeValue("GPS", 0x0000, 1, [300], true)).toThrow(/0 to 255/);
    expect(() => encodeValue("ExifIFD", 0x829a, 5, 2 ** 33, true)).toThrow(/too large/);
    expect(() => encodeValue("ExifIFD", 0x8827, 3, "", true)).toThrow(/number is required/);
    expect(() => encodeValue("ExifIFD", 0x8827, 3, Number.POSITIVE_INFINITY, true)).toThrow(/finite/);
    expect(() => encodeValue("ExifIFD", 0x9201, 10, -5, true)).not.toThrow();
  });

  it("rounds GPS seconds up into minutes and degrees", () => {
    expect(gpsDms(10.99999999)).toEqual([11, 0, 0]);
    expect(gpsDms(38.71)).toEqual([38, 42, 36]);
    expect(gpsDms(-33.5)).toEqual([33, 30, 0]);
  });

  it("negative decimal coordinates set the hemisphere Ref (unless it is set explicitly)", async () => {
    const out = editMetadata(await plainJpeg(), { set: { "exif:GPS:GPSLatitude": "-33.8688", "exif:GPS:GPSLongitude": "151.2093" } });
    expect(field(out.bytes, "exif:GPS:GPSLatitudeRef")?.value).toBe("S");
    expect(field(out.bytes, "exif:GPS:GPSLongitudeRef")?.value).toBe("E");
    expect(dmsToDecimal(field(out.bytes, "exif:GPS:GPSLatitude")!.raw as [number, number][])).toBeCloseTo(33.8688, 4);
    const explicit = editMetadata(await plainJpeg(), { set: { "exif:GPS:GPSLatitude": "-10", "exif:GPS:GPSLatitudeRef": "N" } });
    expect(field(explicit.bytes, "exif:GPS:GPSLatitudeRef")?.value).toBe("N");
  });

  it("creates an Interop tag in a file without an Exif IFD", async () => {
    const jpeg = withSegments(await plainJpeg(), exifSegment(buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("X") }] })));
    const out = editMetadata(jpeg, { set: { "exif:Interop:InteropIndex": "R98" } });
    expect(field(out.bytes, "exif:Interop:InteropIndex")?.value).toBe("R98");
  });

  it("with two EXIF blocks: ids route to the right block and 'removed' is accurate", async () => {
    const a = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("A-make") }, { tag: 0x013b, value: ascii("Ann") }] });
    const b = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("B-make") }, { tag: 0x013b, value: ascii("Bob") }] });
    const jpeg = withSegments(await plainJpeg(), exifSegment(a), exifSegment(b));
    const second = inspect(jpeg).fields.find((f) => f.value === "Bob")!;
    expect(second.id).toMatch(/^exif:IFD0:Artist#\d+$/);
    expect(second.writable).toBe(true);
    const set = editMetadata(jpeg, { set: { [second.id]: "Barbara" } });
    expect(inspect(set.bytes).fields.some((f) => f.value === "Barbara")).toBe(true);
    expect(inspect(set.bytes).fields.some((f) => f.value === "Ann")).toBe(true);
    const removeFirst = editMetadata(jpeg, { remove: ["exif:IFD0:Make", "exif:IFD0:Artist"] });
    expect(removeFirst.removed.map((f) => f.value).sort()).toEqual(["A-make", "Ann"]);
    expect(inspect(removeFirst.bytes).fields.map((f) => f.value).sort()).toEqual(["B-make", "Bob"]);
    expect(() => editMetadata(jpeg, { set: { "exif:IFD0:Artist#999": "x" } })).toThrow(/No EXIF block/);
  });

  it("caps decoded values so a small file cannot exhaust memory", () => {
    const n = 10_000;
    const bytes = buildTiff({ ifd0: [{ tag: 0x0111, value: { type: 4, data: new Array(n).fill(7) } }] });
    const t = parseTiff(bytes);
    const v = readValue(t, t.ifds.get("IFD0")!.entries[0]!) as number[];
    expect(v.length).toBe(256);
  });
});

describe("XMP", () => {
  it("handles every XMP packet, not just the first", async () => {
    const second = XMP_PACKET().replace("Ana Silva", "Other Author").replace("Sunset over Alfama", "Second title");
    const jpeg = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET()), xmpSegment(second));
    const all = ids(jpeg);
    const secondCreator = all.find((id) => /^xmp:dc:creator#p\d+$/.test(id))!;
    expect(secondCreator).toBeDefined();
    expect(field(jpeg, secondCreator)?.sensitive).toBe(true);
    expect(parseContainer(stripAll(jpeg).bytes).blocks.some((b) => b.kind === "xmp")).toBe(false);
    const privacy = editMetadata(jpeg, { remove: ["privacy"] });
    expect(ids(privacy.bytes).some((id) => id.startsWith("xmp:dc:creator"))).toBe(false);
    const set = editMetadata(jpeg, { set: { [secondCreator.replace("creator", "title")]: "Edited second" } });
    expect(inspect(set.bytes).fields.find((f) => f.value === "Edited second")).toBeDefined();
    expect(inspect(set.bytes).fields.find((f) => f.value === "Sunset over Alfama")).toBeDefined();
  });

  it("setting a language alternative keeps the translations", async () => {
    const xml = XMP_PACKET().replace('<rdf:li xml:lang="x-default">Sunset over Alfama</rdf:li>', '<rdf:li xml:lang="x-default">Sunset</rdf:li><rdf:li xml:lang="pt-PT">Pôr do sol</rdf:li>');
    const out = editMetadata(withSegments(await plainJpeg(), xmpSegment(xml)), { set: { "xmp:dc:title": "Dusk" } });
    const raw = field(out.bytes, "xmp:dc:title")!.raw as { lang: string; text: string }[];
    expect(raw).toEqual([{ lang: "x-default", text: "Dusk" }, { lang: "pt-PT", text: "Pôr do sol" }]);
  });
});

describe("IPTC and Photoshop blocks", () => {
  it("routes edits to the APP13 block each field came from", async () => {
    const broken = jpegSegment(0xed, concat("Photoshop 3.0\0", "8BIM", new Uint8Array([4, 4, 0, 0, 0, 0, 0, 5]), new Uint8Array([0x1c, 2, 25, 0, 99])));
    const jpeg = withSegments(await plainJpeg(), iptcSegment(), broken);
    const fields = inspect(jpeg).fields;
    const brokenField = fields.find((f) => f.id.startsWith("iptc:record"))!;
    expect(brokenField.id).toMatch(/#\d+$/);
    const out = editMetadata(jpeg, { remove: [brokenField.id] });
    expect(field(out.bytes, "iptc:Keywords")?.value).toBe("sunset; lisbon"); // the readable block survived
    expect(ids(out.bytes).some((id) => id.startsWith("iptc:record"))).toBe(false);
    const set = editMetadata(jpeg, { set: { "iptc:City": "Porto" } });
    expect(inspect(set.bytes).fields.filter((f) => f.id.startsWith("iptc:City"))).toHaveLength(1);
    expect(field(set.bytes, "iptc:City")?.value).toBe("Porto");
  });

  it("keeps resource names byte for byte and trailing bytes after the last resource", async () => {
    const name = Uint8Array.of(2, 0x4d, 0xc4, 0); // Pascal name "M\xC4" (+ pad)
    const res = concat("8BIM", new Uint8Array([0x04, 0x0b]), name, new Uint8Array([0, 0, 0, 2]), "ok");
    const segment = jpegSegment(0xed, concat("Photoshop 3.0\0", res, iptcSegment().subarray(4 + 14), "TAILBYTES"));
    const jpeg = withSegments(await plainJpeg(), segment);
    const out = editMetadata(jpeg, { remove: ["iptc:By-line"] });
    const payload = parseContainer(out.bytes).blocks.find((b) => b.kind === "iptc")!.payload;
    expect([...parseResources(payload)[0]!.nameBytes]).toEqual([0x4d, 0xc4]);
    expect(new TextDecoder().decode(payload.subarray(-9))).toBe("TAILBYTES");
  });
});

describe("PNG and WebP", () => {
  const png = async () => new Uint8Array(await scene(16, 16).png().toBuffer());

  it("a corrupt text or ICC chunk is listed and removable instead of breaking the file", async () => {
    const bad = withChunks(await png(), pngChunk("zTXt", concat("Comment\0\0", "not zlib")), pngChunk("tEXt", "no-terminator"), pngChunk("iCCP", concat("P\0\0", "garbage")));
    const fields = inspect(bad).fields;
    expect(fields.find((f) => f.id === "other:zTXt")).toBeDefined();
    expect(fields.find((f) => f.id === "icc:Profile")?.value).toMatch(/Unreadable/);
    const clean = stripAll(bad, { keepIcc: false });
    expect(parsePng(clean.bytes).blocks.filter((b) => b.kind !== "structure")).toEqual([]);
  });

  it("refuses decompression bombs: the bomb chunk is listed as broken, nothing is inflated past the cap", async () => {
    const bomb = deflateSync(new Uint8Array(80 * 1024 * 1024));
    const bytes = withChunks(await png(), pngChunk("zTXt", concat("Bomb\0\0", bomb)));
    const block = parsePng(bytes).blocks.find((b) => b.name === "zTXt")!;
    expect(block.kind).toBe("other");
    expect(block.info.corrupt).toBe(true);
    expect(parseContainer(stripAll(bytes).bytes).blocks.some((b) => b.name === "zTXt")).toBe(false);
  });

  it("caps the total decompressed by one file", async () => {
    const chunk = pngChunk("zTXt", concat("Big\0\0", deflateSync(new Uint8Array(40 * 1024 * 1024).fill(65))));
    const bytes = withChunks(await png(), chunk, chunk, chunk, chunk);
    const kinds = parsePng(bytes).blocks.filter((b) => b.name === "zTXt").map((b) => b.kind);
    expect(kinds.filter((k) => k === "text").length).toBeLessThanOrEqual(3);
    expect(kinds).toContain("other");
  });

  it("keeps the language of rewritten iTXt chunks and inserts before Apple's iDOT", async () => {
    const itxt = pngChunk("iTXt", concat("Title\0\0\0", "pt\0", "Título\0", "Olá"));
    const idot = pngChunk("iDOT", new Uint8Array(28));
    const base = await png();
    // Apple writes iDOT immediately before the first IDAT.
    const firstIdat = parsePng(base).blocks.find((b) => b.name === "IDAT")!.offset;
    const withIdot = concat(base.subarray(0, 33), itxt, base.subarray(33, firstIdat), idot, base.subarray(firstIdat));
    const out = editMetadata(withIdot, { set: { "png:Title": "Adeus", "png:Comment": "c", "xmp:dc:title": "t" } });
    const blocks = parsePng(out.bytes).blocks;
    const title = blocks.find((b) => b.info.keyword === "Title")!;
    expect([title.info.language, title.info.translated]).toEqual(["pt", "Título"]);
    const names = blocks.map((b) => b.name);
    expect(names.indexOf("iDOT")).toBe(names.indexOf("IDAT") - 1);
    expect(names.indexOf("tEXt")).toBeLessThan(names.indexOf("iDOT"));
  });

  it("an unpadded odd-sized last WebP chunk is padded so new chunks stay aligned", async () => {
    const webp = new Uint8Array(await scene(10, 10).webp().toBuffer());
    const c = parseWebp(webp);
    const xmp = new Uint8Array([0x58, 0x4d, 0x50, 0x20, 3, 0, 0, 0, 0x3c, 0x78, 0x3e]); // "XMP " size 3, no pad
    const odd = concat(webp, xmp);
    new DataView(odd.buffer).setUint32(4, odd.length - 8, true);
    expect(c.blocks.length).toBeGreaterThan(0);
    const out = editMetadata(odd, { set: { "exif:IFD0:Artist": "x" } });
    expect(field(out.bytes, "exif:IFD0:Artist")?.value).toBe("x");
    expect(() => editMetadata(odd, { set: { "comment:COM": "x" } })).toThrow(/no comment field/);
  });
});

describe("library edges", () => {
  it("save-as writes even with nothing staged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-reg-"));
    const doc = await ImageDocument.open(withSegments(await plainJpeg(), comSegment("c")));
    const { written } = await doc.save(join(dir, "copy.jpg"));
    expect(written?.path).toBe(join(dir, "copy.jpg"));
  });

  it("sharp failures are ImgwandErrors", async () => {
    await expect(renderPaletted(new Uint8Array(20), { width: 4, height: 4 })).rejects.toThrow(ImgwandError);
    await expect(samePixels(new Uint8Array(20), await plainJpeg())).rejects.toThrow(ImgwandError);
  });

  it("a backup that cannot be written is an IO_ERROR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-reg-"));
    const path = join(dir, "a.jpg");
    writeFileSync(path, "x");
    mkdirSync(join(dir, "ro"));
    chmodSync(join(dir, "ro"), 0o500);
    await expect(writeFileAtomic(path, new Uint8Array(1), { backup: join(dir, "ro", "a.bak") })).rejects.toThrow(/Cannot write the backup/);
    chmodSync(join(dir, "ro"), 0o700);
  });

  it("invalid C2PA options are reported, not mistaken for 'no manifest'", async () => {
    await expect(readC2pa(await plainJpeg(), "image/jpeg", { trustAnchors: "not a pem" })).rejects.toThrow(/PEM/);
  });

  it("many fields resolve in linear time", async () => {
    const chunks = Array.from({ length: 20_000 }, (_, i) => pngChunk("tEXt", `k${i}\0v`));
    const bytes = withChunks(new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).png().toBuffer()), ...chunks);
    const start = Date.now();
    const out = editMetadata(bytes, { remove: ["all"] });
    expect(out.removed.length).toBe(20_000);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

it("EXIF warning ids stay unique across blocks", async () => {
  const withUnknown = (make: string) => buildTiff({ ifd0: [{ tag: 0x010f, value: ascii(make) }, { tag: 0x0112, value: short(1) }] });
  const t1 = withUnknown("A");
  new DataView(t1.buffer).setUint16(8 + 2 + 12 + 2, 77, true);
  const t2 = withUnknown("B");
  new DataView(t2.buffer).setUint16(8 + 2 + 12 + 2, 77, true);
  const all = ids(withSegments(await plainJpeg(), exifSegment(t1), exifSegment(t2)));
  expect(new Set(all).size).toBe(all.length);
});
