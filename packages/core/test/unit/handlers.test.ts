import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { editMetadata, inspect } from "../../src/document.js";
import { parseContainer } from "../../src/container/index.js";
import { parseIcc, iccProfile } from "../../src/icc/handler.js";
import { parseDatasets, parseIptcId, parseResources, serializeDatasets, serializeResources } from "../../src/iptc/handler.js";
import { parseXmp } from "../../src/xmp/handler.js";
import { ImgwandError } from "../../src/errors.js";
import { comSegment, concat, fullJpeg, fullPng, fullWebp, iptcSegment, jpegSegment, plainJpeg, withSegments, xmpSegment, XMP_PACKET } from "../helpers/fixtures.js";

const field = (bytes: Uint8Array, id: string) => inspect(bytes).fields.find((f) => f.id === id);
const ids = (bytes: Uint8Array) => inspect(bytes).fields.map((f) => f.id);

describe("XMP", () => {
  it("lists attribute, array, language-alternative and structure properties", async () => {
    const xml = XMP_PACKET(' xmpMM:History="x"').replace("</rdf:Description>", '<xmpMM:DerivedFrom rdf:parseType="Resource"><stRef:documentID xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#">did:1</stRef:documentID></xmpMM:DerivedFrom><xmpMM:Ingredients><rdf:Bag><rdf:li rdf:parseType="Resource"><stRef:filePath xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#">a.jpg</stRef:filePath></rdf:li></rdf:Bag></xmpMM:Ingredients><dc:rights rdf:resource="https://example.com/license"/></rdf:Description>');
    const jpeg = withSegments(await plainJpeg(), xmpSegment(xml));
    expect(field(jpeg, "xmp:xmp:CreatorTool")?.value).toBe("Darkroom 4.2");
    expect(field(jpeg, "xmp:dc:creator")?.value).toBe("Ana Silva");
    expect(field(jpeg, "xmp:dc:title")?.value).toBe("Sunset over Alfama");
    expect(field(jpeg, "xmp:dc:subject")?.raw).toEqual(["sunset", "travel"]);
    expect(field(jpeg, "xmp:xmpMM:DerivedFrom")?.value).toBe("documentID=did:1");
    expect(field(jpeg, "xmp:xmpMM:Ingredients")?.value).toBe("1 entry");
    expect(field(jpeg, "xmp:dc:rights")?.value).toBe("https://example.com/license");
    expect(field(jpeg, "xmp:exif:GPSLatitude")?.group).toBe("gps");
    expect(field(jpeg, "xmp:dc:creator")?.sensitive).toBe(true);
    expect(field(jpeg, "xmp:xmp:Rating")?.sensitive).toBe(false);
  });

  it("uses conventional prefixes whatever prefix the file uses", async () => {
    const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:foo="http://purl.org/dc/elements/1.1/" xmlns:mine="urn:mine:" foo:format="image/jpeg" mine:thing="1"/></rdf:RDF></x:xmpmeta>';
    const jpeg = withSegments(await plainJpeg(), xmpSegment(xml));
    expect(ids(jpeg)).toEqual(expect.arrayContaining(["xmp:dc:format", "xmp:mine:thing"]));
  });

  it("removes properties and keeps everything else, including the xpacket wrapper", async () => {
    const jpeg = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET()));
    const out = editMetadata(jpeg, { remove: ["xmp:dc:creator", "xmp:photoshop:City"] });
    expect(out.removed.map((f) => f.id).sort()).toEqual(["xmp:dc:creator", "xmp:photoshop:City"]);
    const xml = new TextDecoder().decode(parseContainer(out.bytes).blocks.find((b) => b.kind === "xmp")!.payload);
    expect(xml).toContain("<?xpacket begin");
    expect(xml).not.toContain("Ana Silva");
    expect(xml).not.toContain("Lisbon");
    expect(xml).toContain("Darkroom 4.2");
    expect(field(out.bytes, "xmp:dc:title")?.value).toBe("Sunset over Alfama");
  });

  it("drops the packet when the last property goes", async () => {
    const jpeg = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET()));
    const out = editMetadata(jpeg, { remove: ["xmp"] });
    expect(parseContainer(out.bytes).blocks.some((b) => b.kind === "xmp")).toBe(false);
  });

  it("sets attributes, element text and arrays; creates properties with their namespace", async () => {
    const jpeg = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET()));
    const out = editMetadata(jpeg, {
      set: {
        "xmp:xmp:CreatorTool": "imgwand",
        "xmp:dc:title": "New title",
        "xmp:dc:subject": "a; b; c",
        "xmp:dc:description": "Created",
        "xmp:dc:contributor": "x; y",
        "xmp:Iptc4xmpCore:CountryCode": "PT",
        "xmp:dc:date": "2026-01-01",
      },
    });
    expect(field(out.bytes, "xmp:xmp:CreatorTool")?.value).toBe("imgwand");
    expect(field(out.bytes, "xmp:dc:title")?.value).toBe("New title");
    expect(field(out.bytes, "xmp:dc:subject")?.raw).toEqual(["a", "b", "c"]);
    expect(field(out.bytes, "xmp:dc:description")?.value).toBe("Created");
    expect(field(out.bytes, "xmp:dc:contributor")?.raw).toEqual(["x", "y"]);
    expect(field(out.bytes, "xmp:Iptc4xmpCore:CountryCode")?.value).toBe("PT");
    expect(field(out.bytes, "xmp:dc:date")?.raw).toEqual(["2026-01-01"]);
  });

  it("creates an XMP packet when there is none (JPEG, PNG, WebP)", async () => {
    for (const bytes of [await plainJpeg(), new Uint8Array(await sharp(await plainJpeg()).png().toBuffer()), new Uint8Array(await sharp(await plainJpeg()).webp().toBuffer())]) {
      const out = editMetadata(bytes, { set: { "xmp:dc:title": "Hello" } });
      expect(field(out.bytes, "xmp:dc:title")?.value).toBe("Hello");
    }
  });

  it("validates ids and refuses unsafe or malformed packets", async () => {
    const jpeg = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET()));
    expect(() => editMetadata(jpeg, { set: { "xmp:nope:thing": "x" } })).toThrow(/Unknown XMP namespace/);
    expect(() => editMetadata(jpeg, { set: { "xmp:bad id": "x" } })).toThrow(ImgwandError);
    expect(() => parseXmp('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')).toThrow(/DOCTYPE/);
    expect(() => parseXmp("<x><unclosed></x>")).toThrow(/Malformed/);
    const bad = withSegments(await plainJpeg(), xmpSegment("<x:xmpmeta><broken"));
    const f = field(bad, "xmp:packet")!;
    expect(f.value).toMatch(/Unreadable XMP/);
    expect(f.removal).toBe("block");
    expect(parseContainer(editMetadata(bad, { remove: ["xmp:packet"] }).bytes).blocks.some((b) => b.kind === "xmp")).toBe(false);
  });

  it("cannot set a structure", async () => {
    const xml = XMP_PACKET().replace("</rdf:Description>", '<xmpMM:DerivedFrom rdf:parseType="Resource"><stRef:x xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#">1</stRef:x></xmpMM:DerivedFrom></rdf:Description>');
    const jpeg = withSegments(await plainJpeg(), xmpSegment(xml));
    expect(() => editMetadata(jpeg, { set: { "xmp:xmpMM:DerivedFrom": "x" } })).toThrow(/structure/);
  });

  it("lists and removes extended XMP segments", async () => {
    const ext = jpegSegment(0xe1, concat("http://ns.adobe.com/xmp/extension/\0", "0123456789ABCDEF0123456789ABCDEF", new Uint8Array(8), "<x/>"));
    const jpeg = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET()), ext);
    expect(field(jpeg, "xmp:extended")?.value).toMatch(/1 segment/);
    const out = editMetadata(jpeg, { remove: ["xmp:extended"] });
    expect(parseContainer(out.bytes).blocks.some((b) => b.kind === "xmp-extended")).toBe(false);
    expect(parseContainer(out.bytes).blocks.some((b) => b.kind === "xmp")).toBe(true);
    const all = editMetadata(jpeg, { remove: ["xmp"] });
    expect(parseContainer(all.bytes).blocks.some((b) => b.kind.startsWith("xmp"))).toBe(false);
  });
});

describe("IPTC and Photoshop resources", () => {
  it("parses datasets, resources and the UTF-8 marker", async () => {
    const jpeg = withSegments(await plainJpeg(), iptcSegment());
    expect(field(jpeg, "iptc:Keywords")?.raw).toEqual(["sunset", "lisbon"]);
    expect(field(jpeg, "iptc:By-line")?.sensitive).toBe(true);
    expect(field(jpeg, "iptc:CodedCharacterSet")?.value).toBe("UTF8");
    expect(field(jpeg, "iptc:CopyrightNotice")?.value).toBe("© Ana Silva");
    expect(field(jpeg, "photoshop:ResolutionInfo")?.value).toBe("300x300 dpi");
    expect(field(jpeg, "photoshop:IPTCDigest")?.value).toBe("ab".repeat(16));
  });

  it("removes datasets and recomputes the IPTC digest", async () => {
    const jpeg = withSegments(await plainJpeg(), iptcSegment());
    const out = editMetadata(jpeg, { remove: ["iptc:By-line", "iptc:City"] });
    expect(field(out.bytes, "iptc:By-line")).toBeUndefined();
    expect(field(out.bytes, "iptc:Keywords")).toBeDefined();
    const block = parseContainer(out.bytes).blocks.find((b) => b.kind === "iptc")!;
    const resources = parseResources(block.payload);
    const iptc = resources.find((r) => r.id === 0x0404)!;
    const digest = resources.find((r) => r.id === 0x0425)!;
    expect(Buffer.from(digest.data).toString("hex")).toBe(createHash("md5").update(iptc.data).digest("hex"));
    expect(resources.map((r) => r.id)).toEqual([0x03ed, 0x0404, 0x0425]); // order preserved
  });

  it("sets repeatable and single datasets and declares UTF-8 when needed", async () => {
    const jpeg = withSegments(await plainJpeg(), iptcSegment(false));
    const out = editMetadata(jpeg, { set: { "iptc:Keywords": "a; b ; ; c", "iptc:Headline": "Título" } });
    expect(field(out.bytes, "iptc:Keywords")?.raw).toEqual(["a", "b", "c"]);
    expect(field(out.bytes, "iptc:Headline")?.value).toBe("Título");
  });

  it("creates an APP13 block in a JPEG without one, with a UTF-8 marker", async () => {
    const out = editMetadata(await plainJpeg(), { set: { "iptc:City": "Zürich" } });
    expect(field(out.bytes, "iptc:City")?.value).toBe("Zürich");
    expect(field(out.bytes, "iptc:CodedCharacterSet")?.value).toBe("UTF8");
  });

  it("drops IPTC (and its digest) when the last dataset goes, and the block when nothing is left", async () => {
    const jpeg = withSegments(await plainJpeg(), iptcSegment());
    const out = editMetadata(jpeg, { remove: ["iptc"] });
    const resources = parseResources(parseContainer(out.bytes).blocks.find((b) => b.kind === "iptc")!.payload);
    expect(resources.map((r) => r.id)).toEqual([0x03ed]);
    const none = editMetadata(out.bytes, { remove: ["photoshop:ResolutionInfo"] });
    expect(parseContainer(none.bytes).blocks.some((b) => b.kind === "iptc")).toBe(false);
  });

  it("refuses to write read-only datasets and Photoshop resources", async () => {
    const jpeg = withSegments(await plainJpeg(), iptcSegment());
    expect(() => editMetadata(jpeg, { set: { "iptc:ApplicationRecordVersion": "4" } })).toThrow(/not writable/);
    expect(() => editMetadata(jpeg, { set: { "iptc:Nonsense": "x" } })).toThrow(/Unknown or read-only/);
    expect(() => editMetadata(jpeg, { set: { "photoshop:URL": "x" } })).toThrow(/not writable/);
    const png = new Uint8Array(await sharp(await plainJpeg()).png().toBuffer());
    expect(() => editMetadata(png, { set: { "iptc:City": "x" } })).toThrow(/IPTC/);
  });

  it("round-trips the binary formats, including extended dataset lengths", () => {
    const big = new Uint8Array(40000).fill(0x41);
    const datasets = [{ record: 2, dataset: 120, data: big }, { record: 2, dataset: 25, data: new TextEncoder().encode("k") }];
    expect(parseDatasets(serializeDatasets(datasets)).map((d) => d.data.length)).toEqual([40000, 1]);
    const resources = [{ signature: "8BIM", id: 0x0404, nameBytes: Uint8Array.of(0x6f, 0xc4, 0x64), data: new Uint8Array(3) }, { signature: "8BIM", id: 0x040b, nameBytes: new Uint8Array(0), data: new TextEncoder().encode("https://x") }];
    // Names are kept as raw bytes (0xC4 must not turn into UTF-8 C3 84), and trailing bytes survive.
    const bytes = serializeResources(resources, Uint8Array.of(9, 9, 9));
    expect(parseResources(bytes).map((r) => [r.id, [...r.nameBytes], r.data.length])).toEqual([[0x0404, [0x6f, 0xc4, 0x64], 3], [0x040b, [], 9]]);
    expect([...bytes.subarray(-3)]).toEqual([9, 9, 9]);
    expect(parseIptcId("iptc:2:25")).toEqual({ record: 2, dataset: 25 });
    expect(parseIptcId("iptc:keywords")).toEqual({ record: 2, dataset: 25 });
    expect(parseIptcId("iptc:CodedCharacterSet")).toEqual({ record: 1, dataset: 90 });
    expect(parseIptcId("iptc:whatever")).toBeUndefined();
    expect(() => parseDatasets(new Uint8Array([0x1c, 2, 25, 0, 10, 1]))).toThrow(/runs past/);
    expect(() => parseDatasets(new Uint8Array([0x1c, 2, 25, 0x80, 0x09, 1]))).toThrow(/extended/);
    expect(() => parseResources(concat("8BIM", new Uint8Array([4, 4, 0, 0, 0, 0, 0, 99])))).toThrow(/runs past/);
  });

  it("reports unreadable IPTC as a removable block", async () => {
    const broken = jpegSegment(0xed, concat("Photoshop 3.0\0", "8BIM", new Uint8Array([4, 4, 0, 0, 0, 0, 0, 5]), new Uint8Array([0x1c, 2, 25, 0, 99])));
    const jpeg = withSegments(await plainJpeg(), broken);
    expect(field(jpeg, "iptc:record")?.value).toMatch(/runs past/);
    expect(parseContainer(editMetadata(jpeg, { remove: ["iptc:record"] }).bytes).blocks.some((b) => b.kind === "iptc")).toBe(false);
  });
});

describe("ICC profiles", () => {
  it("summarizes a profile and removes it as a whole", async () => {
    const jpeg = await fullJpeg();
    expect(field(jpeg, "icc:ColorSpace")?.value).toBe("RGB");
    expect(field(jpeg, "icc:DeviceClass")?.value).toBe("Display Device");
    expect(field(jpeg, "icc:Version")?.value).toMatch(/^\d\.\d\.\d$/);
    const out = editMetadata(jpeg, { remove: ["icc:ColorSpace"] });
    expect(out.removed.filter((f) => f.group === "icc").length).toBeGreaterThan(5);
    expect(out.warnings.join(" ")).toMatch(/colors may look different/);
    expect(parseContainer(out.bytes).blocks.some((b) => b.kind === "icc")).toBe(false);
    expect(() => editMetadata(jpeg, { set: { "icc:ColorSpace": "x" } })).toThrow(/read-only|not writable/);
  });

  it("reassembles profiles split over several APP2 segments", async () => {
    const profile = iccProfile(parseContainer(await fullJpeg()).blocks)!;
    const half = Math.floor(profile.length / 2);
    const seg = (seq: number, part: Uint8Array) => jpegSegment(0xe2, concat("ICC_PROFILE\0", new Uint8Array([seq, 2]), part));
    const jpeg = withSegments(await plainJpeg(), seg(2, profile.subarray(half)), seg(1, profile.subarray(0, half)));
    expect(iccProfile(parseContainer(jpeg).blocks)).toEqual(profile);
    expect(field(jpeg, "icc:ColorSpace")?.value).toBe("RGB");
    const out = editMetadata(jpeg, { remove: ["icc"] });
    expect(parseContainer(out.bytes).blocks.filter((b) => b.kind === "icc")).toHaveLength(0);
  });

  it("reads ICC from PNG (iCCP) and WebP (ICCP), and reports broken profiles", async () => {
    expect(field(await fullPng(), "icc:ColorSpace")?.value).toBe("RGB");
    expect(field(await fullWebp(), "icc:ColorSpace")?.value).toBe("RGB");
    expect(() => parseIcc(new Uint8Array(200))).toThrow(/ICC/);
    const jpeg = withSegments(await plainJpeg(), jpegSegment(0xe2, concat("ICC_PROFILE\0", new Uint8Array([1, 1]), new Uint8Array(50))));
    expect(field(jpeg, "icc:Profile")?.value).toMatch(/Unreadable/);
  });
});

describe("comments, PNG text and other blocks", () => {
  it("lists, edits, creates and removes JPEG comments", async () => {
    const jpeg = withSegments(await plainJpeg(), comSegment("first"), comSegment("second"));
    expect(ids(jpeg)).toEqual(expect.arrayContaining(["comment:COM", "comment:COM#2"]));
    const edited = editMetadata(jpeg, { set: { "comment:COM#2": "changed" } });
    expect(field(edited.bytes, "comment:COM#2")?.value).toBe("changed");
    const removed = editMetadata(jpeg, { remove: ["comment"] });
    expect(ids(removed.bytes).some((id) => id.startsWith("comment:"))).toBe(false);
    const created = editMetadata(await plainJpeg(), { set: { "comment:COM": "new" } });
    expect(field(created.bytes, "comment:COM")?.value).toBe("new");
    const plain = await plainJpeg();
    expect(() => editMetadata(plain, { set: { "png:Comment": "x" } })).toThrow(/does not apply/);
  });

  it("handles PNG text chunks and tIME", async () => {
    const png = await fullPng();
    expect(field(png, "png:Author")?.value).toBe("Ana Silva");
    expect(field(png, "png:Comment")?.value).toBe("Made in Lisbon");
    expect(field(png, "other:tIME")?.value).toBe("2026-05-01 19:42:10 UTC");
    const out = editMetadata(png, { set: { "png:Author": "Anon" }, remove: ["other:tIME"] });
    expect(field(out.bytes, "png:Author")?.value).toBe("Anon");
    expect(field(out.bytes, "other:tIME")).toBeUndefined();
    const created = editMetadata(new Uint8Array(await sharp(await plainJpeg()).png().toBuffer()), { set: { "png:Comment": "hi" } });
    expect(field(created.bytes, "png:Comment")?.value).toBe("hi");
    expect(() => editMetadata(png, { set: { "png:NewKeyword": "x" } })).toThrow(/only comment:COM/);
  });

  it("lists vendor segments as removable, not writable", async () => {
    const jpeg = withSegments(await plainJpeg(), jpegSegment(0xec, concat("Ducky\0", new Uint8Array(8))), jpegSegment(0xe3, "plain text vendor data"));
    const ducky = field(jpeg, "other:APP12")!;
    expect(ducky.name).toBe("APP12 (Ducky)");
    expect(field(jpeg, "other:APP3")?.value).toMatch(/plain text vendor data/);
    expect(() => editMetadata(jpeg, { set: { "other:APP12": "x" } })).toThrow(/not writable/);
    const out = editMetadata(jpeg, { remove: ["other"] });
    expect(ids(out.bytes).some((id) => id.startsWith("other:"))).toBe(false);
  });

  it("marks legacy ImageMagick raw-profile chunks read-only", async () => {
    const { pngChunk, withChunks } = await import("../helpers/fixtures.js");
    const { deflateSync } = await import("node:zlib");
    const png = withChunks(new Uint8Array(await sharp(await plainJpeg()).png().toBuffer()), pngChunk("zTXt", concat("Raw profile type exif\0\0", deflateSync(new TextEncoder().encode("\nexif\n 4\n00000000\n")))));
    const f = field(png, "png:Raw profile type exif")!;
    expect(f.writable).toBe(false);
    expect(f.value).toMatch(/EXIF data written by ImageMagick/);
  });
});
