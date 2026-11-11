import { describe, expect, it } from "vitest";
import { MAX_SEGMENT_PAYLOAD, parseJpeg, rebuildJpeg } from "../../src/container/jpeg.js";
import { detectFormat, parseContainer, samePicture } from "../../src/container/index.js";
import { ImgwandError } from "../../src/errors.js";
import { buildTiff, comSegment, concat, ascii, exifSegment, fullJpeg, iptcSegment, jpegSegment, plainJpeg, withSegments, xmpSegment, XMP_PACKET } from "../helpers/fixtures.js";

const kinds = (bytes: Uint8Array) => parseJpeg(bytes).blocks.map((b) => `${b.name}:${b.kind}`);

describe("JPEG container", () => {
  it("classifies every kind of segment", async () => {
    const icc = jpegSegment(0xe2, concat("ICC_PROFILE\0", new Uint8Array([1, 1]), new Uint8Array(10)));
    const mpf = jpegSegment(0xe2, concat("MPF\0", "II*\0", new Uint8Array([8, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
    const c2pa = jpegSegment(0xeb, concat("JP", new Uint8Array([0, 1, 0, 0, 0, 1]), new Uint8Array([0, 0, 0, 40]), "jumb", new Uint8Array([0, 0, 0, 30]), "jumd", new Uint8Array(17), "c2pa\0"));
    const jumbf = jpegSegment(0xeb, concat("JP", new Uint8Array([0, 2, 0, 0, 0, 1]), "other jumbf"));
    const adobe = jpegSegment(0xee, concat("Adobe", new Uint8Array(7)));
    const ducky = jpegSegment(0xec, concat("Ducky\0", new Uint8Array(8)));
    const ext = jpegSegment(0xe1, concat("http://ns.adobe.com/xmp/extension/\0", "0123"));
    const weird = jpegSegment(0xe1, "not exif");
    const bytes = withSegments(await plainJpeg(), exifSegment(buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("X") }] })), xmpSegment("<x/>"), ext, icc, mpf, c2pa, jumbf, iptcSegment(), adobe, ducky, weird, comSegment("hi"));
    const list = kinds(bytes);
    expect(list).toContain("APP1:exif");
    expect(list).toContain("APP1:xmp");
    expect(list).toContain("APP1:xmp-extended");
    expect(list).toContain("APP2:icc");
    expect(list).toContain("APP2:mpf");
    expect(list).toContain("APP11:c2pa");
    expect(list).toContain("APP11:jumbf");
    expect(list).toContain("APP13:iptc");
    expect(list).toContain("APP14:structure");
    expect(list).toContain("APP12:other");
    expect(list).toContain("APP1:other");
    expect(list).toContain("COM:comment");
    expect(list[0]).toBe("SOI:structure");
    expect(list.at(-1)).toBe("EOI:structure");
    const iccBlock = parseJpeg(bytes).blocks.find((b) => b.kind === "icc")!;
    expect(iccBlock.info).toMatchObject({ sequence: 1, count: 1 });
    expect(iccBlock.payload.length).toBe(10);
  });

  it("accepts the 'Exif\\0\\xff' header variant", async () => {
    const tiff = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("X") }] });
    const seg = jpegSegment(0xe1, concat("Exif\0", new Uint8Array([0xff]), tiff));
    const block = parseJpeg(withSegments(await plainJpeg(), seg)).blocks.find((b) => b.kind === "exif")!;
    expect([...block.payload.subarray(0, 2)]).toEqual([0x49, 0x49]);
  });

  it("keeps entropy-coded data with stuffed bytes and restart markers inside SOS", () => {
    const sos = jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0]));
    const scan = new Uint8Array([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd9]);
    const bytes = concat(new Uint8Array([0xff, 0xd8]), sos, scan);
    const blocks = parseJpeg(bytes).blocks;
    const scanBlock = blocks.find((b) => b.name === "SOS")!;
    expect(scanBlock.raw.length).toBe(sos.length + 8); // up to (not including) the final FF D9
    expect(blocks.at(-1)!.name).toBe("EOI");
  });

  it("treats data after EOI as a protected trailer", async () => {
    const jpeg = concat(await plainJpeg(), "TRAILER-DATA");
    const container = parseJpeg(jpeg);
    expect(container.blocks.at(-1)).toMatchObject({ name: "trailer", kind: "structure" });
    const rebuilt = rebuildJpeg(container, []);
    expect(rebuilt).toEqual(jpeg);
  });

  it("skips fill bytes before markers", async () => {
    const plain = await plainJpeg();
    const filled = concat(plain.subarray(0, 2), new Uint8Array([0xff]), plain.subarray(2));
    const container = parseJpeg(filled);
    expect(container.blocks[1]!.raw[0]).toBe(0xff);
    expect(rebuildJpeg(container, [])).toEqual(filled);
  });

  it("rejects corrupt files with ImgwandError", async () => {
    const plain = await plainJpeg();
    expect(() => parseJpeg(new Uint8Array([0x00, 0x01]))).toThrow(ImgwandError);
    expect(() => parseJpeg(concat(plain.subarray(0, 2), new Uint8Array([0x12, 0x34])))).toThrow(/expected a marker/);
    expect(() => parseJpeg(concat(plain.subarray(0, 2), new Uint8Array([0xff, 0xe1, 0xff, 0xff, 1, 2])))).toThrow(/runs past the end/);
    expect(() => parseJpeg(concat(plain.subarray(0, 2), new Uint8Array([0xff, 0xe1, 0x00])))).toThrow(/truncated/);
    expect(() => parseJpeg(concat(plain.subarray(0, 2), new Uint8Array([0xff, 0xe1, 0x00, 0x01])))).toThrow(ImgwandError);
    expect(() => parseJpeg(concat(plain.subarray(0, 2), new Uint8Array([0xff, 0xff])))).toThrow(/truncated marker/);
  });

  it("removes and replaces segments without touching the picture", async () => {
    const jpeg = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET()), comSegment("old"));
    const container = parseJpeg(jpeg);
    const xmp = container.blocks.find((b) => b.kind === "xmp")!;
    const com = container.blocks.find((b) => b.kind === "comment")!;
    const out = rebuildJpeg(container, [
      { id: xmp.id, action: "remove" },
      { id: com.id, action: "replace", payload: new TextEncoder().encode("new comment") },
    ]);
    const after = parseJpeg(out);
    expect(after.blocks.some((b) => b.kind === "xmp")).toBe(false);
    expect(new TextDecoder().decode(after.blocks.find((b) => b.kind === "comment")!.payload)).toBe("new comment");
    expect(samePicture(container, after)).toBe(true);
  });

  it("refuses to remove picture segments", async () => {
    const container = parseJpeg(await plainJpeg());
    const sof = container.blocks.find((b) => b.name.startsWith("SOF"))!;
    expect(() => rebuildJpeg(container, [{ id: sof.id, action: "remove" }])).toThrow(/part of the picture/);
  });

  it("inserts EXIF after JFIF and other metadata after the APPn run", async () => {
    const jfif = jpegSegment(0xe0, concat("JFIF\0", new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0])));
    const jpeg = withSegments(await plainJpeg(), jfif);
    expect(parseJpeg(jpeg).blocks[1]!.name).toBe("APP0");
    const tiff = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("X") }] });
    const out = rebuildJpeg(parseJpeg(jpeg), [], [
      { kind: "exif", payload: tiff },
      { kind: "xmp", payload: new TextEncoder().encode("<x/>") },
      { kind: "comment", payload: new TextEncoder().encode("c") },
      { kind: "iptc", payload: new Uint8Array(0) },
    ]);
    const names = kinds(out);
    expect(names.slice(0, 3)).toEqual(["SOI:structure", "APP0:structure", "APP1:exif"]);
    expect(names).toContain("APP1:xmp");
    expect(names).toContain("COM:comment");
    expect(names).toContain("APP13:iptc");
  });

  it("refuses payloads larger than one segment", async () => {
    const container = parseJpeg(withSegments(await plainJpeg(), comSegment("x")));
    const com = container.blocks.find((b) => b.kind === "comment")!;
    expect(() => rebuildJpeg(container, [{ id: com.id, action: "replace", payload: new Uint8Array(MAX_SEGMENT_PAYLOAD + 1) }])).toThrow(/at most/);
  });

  it("moves multi-picture (MPF) offsets when edits change the distance to the trailer", async () => {
    // MPF with one MPEntry list of two images; the second points into the trailer.
    const ifd = new Uint8Array(2 + 12 + 4 + 32);
    const dv = new DataView(ifd.buffer);
    dv.setUint16(0, 1, true);
    dv.setUint16(2, 0xb002, true);
    dv.setUint16(4, 7, true);
    dv.setUint32(6, 32, true);
    dv.setUint32(10, 8 + 18, true); // MP entries right after the IFD (offset from the TIFF header)
    const entries = new DataView(ifd.buffer, 18);
    entries.setUint32(16 + 8, 5000, true); // second image offset
    const mpfTiff = concat("II*\0", new Uint8Array([8, 0, 0, 0]), ifd);
    const mpf = jpegSegment(0xe2, concat("MPF\0", mpfTiff));
    const jpeg = concat(withSegments(await plainJpeg(), mpf, comSegment("a comment that will be removed")), "SECOND-IMAGE");
    const container = parseJpeg(jpeg);
    const com = container.blocks.find((b) => b.kind === "comment")!;
    const out = rebuildJpeg(container, [{ id: com.id, action: "remove" }]);
    const mpfAfter = parseJpeg(out).blocks.find((b) => b.kind === "mpf")!;
    const offset = new DataView(mpfAfter.payload.buffer, mpfAfter.payload.byteOffset).getUint32(8 + 18 + 16 + 8, true);
    expect(offset).toBe(5000 - com.raw.length);
    // Unchanged when nothing moves.
    const same = rebuildJpeg(container, []);
    expect(same).toEqual(jpeg);
  });

  it("detects formats and names unsupported ones", async () => {
    expect(detectFormat(await plainJpeg())).toBe("jpeg");
    const heic = concat(new Uint8Array([0, 0, 0, 24]), "ftypheic", new Uint8Array(12));
    expect(() => detectFormat(heic)).toThrow(/HEIC/);
    const avif = concat(new Uint8Array([0, 0, 0, 24]), "ftypavif", new Uint8Array(12));
    expect(() => detectFormat(avif)).toThrow(/AVIF/);
    const mp4 = concat(new Uint8Array([0, 0, 0, 24]), "ftypisom", new Uint8Array(12));
    expect(() => detectFormat(mp4)).toThrow(/ISO-BMFF/);
    expect(() => detectFormat(concat("II*\0", new Uint8Array(8)))).toThrow(/TIFF/);
    expect(() => detectFormat(concat("GIF89a", new Uint8Array(8)))).toThrow(/GIF/);
    expect(() => detectFormat(concat("BM", new Uint8Array(12)))).toThrow(/BMP/);
    expect(() => detectFormat(new Uint8Array(16))).toThrow(/Unrecognized/);
  });

  it("round-trips a rich file byte for byte when nothing is edited", async () => {
    const jpeg = await fullJpeg();
    expect(rebuildJpeg(parseContainer(jpeg), [])).toEqual(jpeg);
  });
});
