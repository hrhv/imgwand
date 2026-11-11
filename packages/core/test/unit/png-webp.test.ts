import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { samePicture } from "../../src/container/index.js";
import { decodeTextChunk, parsePng, rebuildPng, XMP_KEYWORD } from "../../src/container/png.js";
import { parseWebp, rebuildWebp } from "../../src/container/webp.js";
import { ImgwandError } from "../../src/errors.js";
import { ascii, buildTiff, concat, fullPng, fullWebp, pngChunk, scene, withChunks } from "../helpers/fixtures.js";

const text = (s: string) => new TextEncoder().encode(s);

/** Re-wraps the bitstream chunk of a WebP as a "simple" file (no VP8X), the way many encoders write them. */
function simpleWebp(webp: Uint8Array): Uint8Array {
  const bitstream = parseWebp(webp).blocks.find((b) => b.name === "VP8 " || b.name === "VP8L")!;
  const out = concat("RIFF", new Uint8Array(4), "WEBP", bitstream.raw);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}
const latin = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

describe("PNG container", () => {
  it("classifies chunks and decodes their payloads", async () => {
    const c = parsePng(await fullPng());
    const by = (name: string) => c.blocks.filter((b) => b.name === name);
    expect(c.blocks[0]!.name).toBe("signature");
    expect(by("IHDR")[0]!.kind).toBe("structure");
    expect(by("iCCP")[0]!.kind).toBe("icc");
    expect(by("iCCP")[0]!.info.profileName).toBe("Display P3");
    expect(by("iCCP")[0]!.payload.length).toBeGreaterThan(128); // inflated profile
    expect(by("eXIf")[0]!.kind).toBe("exif");
    expect(by("iTXt")[0]!.kind).toBe("xmp");
    expect(by("tEXt").map((b) => b.info.keyword)).toEqual(["Author", "Software"]);
    expect(new TextDecoder().decode(by("zTXt")[0]!.payload)).toBe("Made in Lisbon");
    expect(by("tIME")[0]!.kind).toBe("other");
    expect(c.blocks.every((b) => b.info.crcOk !== false)).toBe(true);
  });

  it("decodes compressed iTXt and rejects malformed text chunks", () => {
    const compressed = concat("Title\0", new Uint8Array([1, 0]), "en\0", "Titel\0", deflateSync(text("Olá")));
    expect(decodeTextChunk("iTXt", compressed)).toMatchObject({ keyword: "Title", text: "Olá", compressed: true, language: "en", translated: "Titel" });
    expect(() => decodeTextChunk("tEXt", text("no terminator"))).toThrow(ImgwandError);
    expect(() => decodeTextChunk("iTXt", text("k\0\0"))).toThrow(/iTXt/);
    expect(() => decodeTextChunk("zTXt", concat("k\0\0", "not zlib"))).toThrow(/decompress/);
  });

  it("strips a JPEG-style Exif prefix in eXIf", async () => {
    const tiff = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("X") }] });
    const png = withChunks(new Uint8Array(await scene(8, 8).png().toBuffer()), pngChunk("eXIf", concat("Exif\0\0", tiff)));
    expect(parsePng(png).blocks.find((b) => b.kind === "exif")!.payload).toEqual(tiff);
  });

  it("flags bad CRCs without refusing the file", async () => {
    const png = withChunks(new Uint8Array(await scene(8, 8).png().toBuffer()), pngChunk("tEXt", concat("A\0", "b")));
    const broken = png.slice();
    broken[33 + 8 + 3]! ^= 0xff; // a byte of the tEXt data
    const block = parsePng(broken).blocks.find((b) => b.name === "tEXt")!;
    expect(block.info.crcOk).toBe(false);
  });

  it("rejects corrupt files", async () => {
    const png = new Uint8Array(await scene(8, 8).png().toBuffer());
    expect(() => parsePng(new Uint8Array(4))).toThrow(/signature/);
    expect(() => parsePng(png.subarray(0, 14))).toThrow(/truncated/);
    expect(() => parsePng(png.subarray(0, 20))).toThrow(/runs past/);
    const badType = png.slice();
    badType.set(latin("1234"), 12);
    expect(() => parsePng(badType)).toThrow(/invalid/);
  });

  it("rewrites text chunks keeping their type when possible", async () => {
    const c = parsePng(await fullPng());
    const author = c.blocks.find((b) => b.info.keyword === "Author")!;
    const comment = c.blocks.find((b) => b.info.keyword === "Comment")!;
    const out = parsePng(
      rebuildPng(c, [
        { id: author.id, action: "replace", payload: text("Zoë") },
        { id: comment.id, action: "replace", payload: text("Feito em Lisboa ✓") },
      ]),
    );
    const a = out.blocks.find((b) => b.info.keyword === "Author")!;
    const m = out.blocks.find((b) => b.info.keyword === "Comment")!;
    expect(a.name).toBe("tEXt"); // Latin-1 fits
    expect(new TextDecoder().decode(a.payload)).toBe("Zoë");
    expect(m.name).toBe("iTXt"); // ✓ does not fit Latin-1, so it becomes UTF-8 iTXt
    expect(new TextDecoder().decode(m.payload)).toBe("Feito em Lisboa ✓");
    expect(out.blocks.every((b) => b.info.crcOk !== false)).toBe(true);
  });

  it("keeps zTXt compressed when replacing it with Latin-1 text", async () => {
    const c = parsePng(await fullPng());
    const comment = c.blocks.find((b) => b.info.keyword === "Comment")!;
    const out = parsePng(rebuildPng(c, [{ id: comment.id, action: "replace", payload: text("plain") }]));
    expect(out.blocks.find((b) => b.info.keyword === "Comment")!.name).toBe("zTXt");
  });

  it("replaces XMP and EXIF, inserts new metadata before IDAT, refuses picture chunks", async () => {
    const c = parsePng(new Uint8Array(await scene(16, 16).png().toBuffer()));
    const tiff = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("Y") }] });
    const inserted = parsePng(rebuildPng(c, [], [
      { kind: "exif", payload: tiff },
      { kind: "xmp", payload: text("<x:xmpmeta/>") },
      { kind: "comment", payload: text("hello") },
    ]));
    const names = inserted.blocks.map((b) => b.name);
    expect(names.indexOf("eXIf")).toBeLessThan(names.indexOf("IDAT"));
    expect(inserted.blocks.find((b) => b.kind === "xmp")!.info.keyword).toBe(XMP_KEYWORD);
    expect(inserted.blocks.find((b) => b.info.keyword === "Comment")).toBeDefined();
    expect(samePicture(c, inserted)).toBe(true);

    const xmp = inserted.blocks.find((b) => b.kind === "xmp")!;
    const exif = inserted.blocks.find((b) => b.kind === "exif")!;
    const replaced = parsePng(rebuildPng(inserted, [
      { id: xmp.id, action: "replace", payload: text("<new/>") },
      { id: exif.id, action: "replace", payload: tiff },
    ]));
    expect(new TextDecoder().decode(replaced.blocks.find((b) => b.kind === "xmp")!.payload)).toBe("<new/>");

    const idat = c.blocks.find((b) => b.name === "IDAT")!;
    expect(() => rebuildPng(c, [{ id: idat.id, action: "remove" }])).toThrow(/part of the picture/);
    const full = parsePng(await fullPng());
    const icc = full.blocks.find((b) => b.kind === "icc")!;
    expect(() => rebuildPng(full, [{ id: icc.id, action: "replace", payload: new Uint8Array(1) }])).toThrow(/cannot be rewritten/);
    expect(() => rebuildPng(c, [], [{ kind: "iptc", payload: new Uint8Array(1) }])).toThrow(/IPTC/);
  });

  it("keeps a trailer after IEND", async () => {
    const png = concat(new Uint8Array(await scene(8, 8).png().toBuffer()), "junk");
    const c = parsePng(png);
    expect(c.blocks.at(-1)!.name).toBe("trailer");
    expect(rebuildPng(c, [])).toEqual(png);
  });
});

describe("WebP container", () => {
  it("classifies chunks", async () => {
    const c = parseWebp(await fullWebp());
    const names = c.blocks.map((b) => `${b.name}:${b.kind}`);
    expect(names).toContain("VP8X:structure");
    expect(names).toContain("ICCP:icc");
    expect(names).toContain("EXIF:exif");
    expect(names).toContain("XMP :xmp");
  });

  it("clears VP8X flags for removed chunks and keeps RIFF sizes right", async () => {
    const c = parseWebp(await fullWebp());
    const edits = c.blocks.filter((b) => b.kind === "exif" || b.kind === "xmp" || b.kind === "icc").map((b) => ({ id: b.id, action: "remove" as const }));
    const out = rebuildWebp(c, edits);
    const after = parseWebp(out);
    const flags = after.blocks.find((b) => b.name === "VP8X")!.payload[0]!;
    expect(flags & 0x2c).toBe(0);
    expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8);
    expect(samePicture(c, after)).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });

  it("synthesizes VP8X when adding metadata to a simple lossy or lossless WebP", async () => {
    for (const encoded of [await scene(30, 20).webp({ quality: 70 }).toBuffer(), await scene(30, 20).webp({ lossless: true }).toBuffer()]) {
      const c = parseWebp(simpleWebp(new Uint8Array(encoded)));
      expect(c.blocks.some((b) => b.name === "VP8X")).toBe(false);
      const tiff = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("Cam") }] });
      const out = rebuildWebp(c, [], [{ kind: "xmp", payload: text("<x/>") }, { kind: "exif", payload: tiff }]);
      const after = parseWebp(out);
      const vp8x = after.blocks.find((b) => b.name === "VP8X")!;
      expect(vp8x.payload[0]! & 0x0c).toBe(0x0c);
      expect(after.blocks.map((b) => b.name).slice(-2)).toEqual(["EXIF", "XMP "]);
      const meta = await sharp(out).metadata();
      expect([meta.width, meta.height]).toEqual([30, 20]);
      expect(meta.exif).toBeDefined();
    }
  });

  it("pads odd-sized chunks", async () => {
    const c = parseWebp(new Uint8Array(await scene(10, 10).webp().toBuffer()));
    const out = rebuildWebp(c, [], [{ kind: "xmp", payload: text("<odd/>") }]); // 6 bytes... make it odd:
    const odd = rebuildWebp(parseWebp(out), [{ id: parseWebp(out).blocks.find((b) => b.kind === "xmp")!.id, action: "replace", payload: text("<odd />") }]);
    expect(odd.length % 2).toBe(0);
    expect(new TextDecoder().decode(parseWebp(odd).blocks.find((b) => b.kind === "xmp")!.payload)).toBe("<odd />");
  });

  it("rejects corrupt files and impossible edits", async () => {
    expect(() => parseWebp(text("RIFF0000WEBX"))).toThrow(/RIFF/);
    const webp = simpleWebp(new Uint8Array(await scene(10, 10).webp().toBuffer()));
    const oversized = webp.slice();
    new DataView(oversized.buffer).setUint32(16, 1_000_000, true); // the VP8 chunk claims to be huge
    expect(() => parseWebp(oversized)).toThrow(/runs past/);
    const c = parseWebp(webp);
    const vp8 = c.blocks.find((b) => b.name === "VP8 ")!;
    expect(() => rebuildWebp(c, [{ id: vp8.id, action: "remove" }])).toThrow(/part of the picture/);
    expect(() => rebuildWebp(c, [{ id: vp8.id, action: "replace", payload: new Uint8Array(2) }])).toThrow(/cannot be rewritten/);
    expect(() => rebuildWebp(c, [], [{ kind: "comment", payload: new Uint8Array(1) }])).toThrow(/comment/);
    expect(() => rebuildWebp(c, [], [{ kind: "iptc", payload: new Uint8Array(1) }])).toThrow(/IPTC/);
  });

  it("strips a JPEG-style Exif prefix in EXIF chunks", async () => {
    const c = parseWebp(await fullWebp());
    const exif = c.blocks.find((b) => b.kind === "exif")!;
    expect(["II", "MM"]).toContain(new TextDecoder().decode(exif.payload.subarray(0, 2)));
  });
});
