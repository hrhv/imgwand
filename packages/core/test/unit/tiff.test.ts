import { describe, expect, it } from "vitest";
import { formatExifValue, dmsToDecimal } from "../../src/exif/format.js";
import { TYPE_ASCII, TYPE_DOUBLE, TYPE_FLOAT, TYPE_SLONG, TYPE_SRATIONAL, TYPE_SSHORT, defaultIfdFor, tagByName, tagName } from "../../src/exif/tags.js";
import { emptyTiff, encodeValue, isWritableTag, parseTiff, readValue, removeTiffEntries, setTiffEntry, type Tiff } from "../../src/exif/tiff.js";
import { ImgwandError } from "../../src/errors.js";
import { ascii, buildTiff, cameraTiff, makerNoteIntact, rational, short, undef } from "../helpers/fixtures.js";

const value = (tiff: Tiff, ifd: Parameters<Tiff["ifds"]["get"]>[0], tag: number) => {
  const entry = tiff.ifds.get(ifd)?.entries.find((e) => e.tag === tag);
  return entry ? readValue(tiff, entry) : undefined;
};

describe.each([true, false])("TIFF (littleEndian=%s)", (le) => {
  it("parses every IFD of a camera EXIF block", async () => {
    const tiff = parseTiff(await cameraTiff(le));
    expect(tiff.littleEndian).toBe(le);
    expect([...tiff.ifds.keys()].sort()).toEqual(["ExifIFD", "GPS", "IFD0", "IFD1", "Interop"]);
    expect(value(tiff, "IFD0", 0x010f)).toBe("Fujifilm");
    expect(value(tiff, "ExifIFD", 0x829a)).toEqual([[1, 250]]);
    expect(value(tiff, "ExifIFD", 0x8827)).toBe(400);
    expect(value(tiff, "GPS", 0x0002)).toEqual([[38, 1], [42, 1], [3600, 100]]);
    expect(value(tiff, "Interop", 0x0001)).toBe("R98");
    expect(tiff.warnings).toEqual([]);
  });

  it("removes entries in place: same length, values zeroed, MakerNote offsets intact", async () => {
    const bytes = await cameraTiff(le);
    const tiff = parseTiff(bytes);
    const out = removeTiffEntries(tiff, [{ ifd: "IFD0", tag: 0x013b }, { ifd: "ExifIFD", tag: 0xa431 }]);
    expect(out.length).toBe(bytes.length);
    const after = parseTiff(out);
    expect(value(after, "IFD0", 0x013b)).toBeUndefined();
    expect(value(after, "ExifIFD", 0xa431)).toBeUndefined();
    expect(value(after, "IFD0", 0x010f)).toBe("Fujifilm");
    expect(value(after, "ExifIFD", 0xa435)).toBe("3BA00987");
    expect(new TextDecoder().decode(out)).not.toContain("5CA12345"); // the serial number's bytes are gone
    expect(makerNoteIntact(out, le)).toBe(true);
    expect(bytes).toEqual(await cameraTiff(le)); // input untouched
  });

  it("erases a whole sub-IFD together with its pointer", async () => {
    const tiff = parseTiff(await cameraTiff(le));
    const out = removeTiffEntries(tiff, [{ ifd: "GPS", tag: "*" }]);
    const after = parseTiff(out);
    expect(after.ifds.has("GPS")).toBe(false);
    expect(after.ifds.get("IFD0")!.entries.some((e) => e.tag === 0x8825)).toBe(false);
    expect(after.ifds.has("ExifIFD")).toBe(true);
  });

  it("erases a sub-IFD when its last entry goes, cascading Interop → Exif", async () => {
    const bytes = buildTiff({ littleEndian: le, ifd0: [{ tag: 0x010f, value: ascii("X") }], exif: [{ tag: 0x8827, value: short(100) }], interop: [{ tag: 0x0001, value: ascii("R98") }], gps: [{ tag: 0x0001, value: ascii("N") }] });
    const out = removeTiffEntries(parseTiff(bytes), [{ ifd: "GPS", tag: 0x0001 }, { ifd: "Interop", tag: 0x0001 }, { ifd: "ExifIFD", tag: 0x8827 }]);
    const after = parseTiff(out);
    expect([...after.ifds.keys()]).toEqual(["IFD0"]);
    expect(after.ifds.get("IFD0")!.entries.map((e) => e.tag)).toEqual([0x010f]);
  });

  it("removes the thumbnail IFD and zeroes the thumbnail", async () => {
    const bytes = await cameraTiff(le);
    const tiff = parseTiff(bytes);
    const ifd1 = tiff.ifds.get("IFD1")!;
    const start = readValue(tiff, ifd1.entries.find((e) => e.tag === 0x0201)!) as number;
    const length = readValue(tiff, ifd1.entries.find((e) => e.tag === 0x0202)!) as number;
    expect([bytes[start], bytes[start + 1]]).toEqual([0xff, 0xd8]);
    const out = removeTiffEntries(tiff, [{ ifd: "IFD1", tag: "*" }]);
    const after = parseTiff(out);
    expect(after.ifds.has("IFD1")).toBe(false);
    expect(after.ifds.get("IFD0")!.nextOffset).toBe(0);
    expect(out.subarray(start, start + length).every((b) => b === 0)).toBe(true);
    expect(makerNoteIntact(out, le)).toBe(true);
  });

  it("erasing IFD0 erases everything", async () => {
    const out = removeTiffEntries(parseTiff(await cameraTiff(le)), [{ ifd: "IFD0", tag: "*" }]);
    const after = parseTiff(out);
    expect(after.ifds.size).toBe(0);
  });

  it("keeps value bytes that another surviving entry still uses", () => {
    const bytes = buildTiff({ littleEndian: le, ifd0: [{ tag: 0x010e, value: ascii("shared value!") }, { tag: 0x0131, value: ascii("other value") }] });
    const tiff = parseTiff(bytes);
    // Point Software at the same bytes as ImageDescription.
    const e = tiff.ifds.get("IFD0")!.entries;
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint32(e[1]!.entryOffset + 8, e[0]!.valueOffset, le);
    view.setUint32(e[1]!.entryOffset + 4, e[0]!.count, le);
    const out = removeTiffEntries(parseTiff(bytes), [{ ifd: "IFD0", tag: 0x010e }]);
    expect(value(parseTiff(out), "IFD0", 0x0131)).toBe("shared value!");
  });

  it("sets values in place, shrinking or growing, and creates new tags and IFDs", async () => {
    let bytes = await cameraTiff(le);
    const length = bytes.length;
    bytes = setTiffEntry(parseTiff(bytes), "IFD0", 0x013b, "Bo"); // fits inline now
    expect(value(parseTiff(bytes), "IFD0", 0x013b)).toBe("Bo");
    bytes = setTiffEntry(parseTiff(bytes), "IFD0", 0x0131, "Darkroom"); // shorter: reuses the old space
    expect(bytes.length).toBe(length);
    bytes = setTiffEntry(parseTiff(bytes), "IFD0", 0x0131, "A much longer software name than before");
    expect(bytes.length).toBeGreaterThan(length);
    bytes = setTiffEntry(parseTiff(bytes), "IFD0", 0x010e, "A new description"); // new tag: IFD0 relocates
    bytes = setTiffEntry(parseTiff(bytes), "ExifIFD", 0x8827, 800);
    bytes = setTiffEntry(parseTiff(bytes), "ExifIFD", 0x829a, "1/1000");
    bytes = setTiffEntry(parseTiff(bytes), "IFD1", 0x011a, 96); // existing tag in IFD1
    const t = parseTiff(bytes);
    expect(value(t, "IFD0", 0x0131)).toBe("A much longer software name than before");
    expect(value(t, "IFD0", 0x010e)).toBe("A new description");
    expect(value(t, "ExifIFD", 0x8827)).toBe(800);
    expect(value(t, "ExifIFD", 0x829a)).toEqual([[1, 1000]]);
    expect(value(t, "IFD1", 0x011a)).toEqual([[96, 1]]);
    expect(t.ifds.get("IFD0")!.entries.map((e) => e.tag)).toEqual([...t.ifds.get("IFD0")!.entries.map((e) => e.tag)].sort((a, b) => a - b));
    expect(t.ifds.has("IFD1")).toBe(true); // IFD1 link survived the IFD0 relocation
    expect(makerNoteIntact(bytes, le)).toBe(true);
    expect(t.warnings).toEqual([]);
  });

  it("creates a GPS IFD from nothing, converting decimal degrees", () => {
    let bytes = buildTiff({ littleEndian: le, ifd0: [{ tag: 0x010f, value: ascii("X") }] });
    bytes = setTiffEntry(parseTiff(bytes), "GPS", 0x0002, 38.71);
    bytes = setTiffEntry(parseTiff(bytes), "GPS", 0x0001, "N");
    const t = parseTiff(bytes);
    const lat = value(t, "GPS", 0x0002) as [number, number][];
    expect(dmsToDecimal(lat)).toBeCloseTo(38.71, 4);
    expect(value(t, "GPS", 0x0001)).toBe("N");
    expect(t.ifds.get("IFD0")!.entries.some((e) => e.tag === 0x8825)).toBe(true);
  });

  it("creates an Exif IFD and an Interop IFD inside it", () => {
    let bytes = buildTiff({ littleEndian: le, ifd0: [{ tag: 0x010f, value: ascii("X") }] });
    bytes = setTiffEntry(parseTiff(bytes), "ExifIFD", 0xa434, "Lens");
    bytes = setTiffEntry(parseTiff(bytes), "Interop", 0x0001, "R98");
    const t = parseTiff(bytes);
    expect(value(t, "ExifIFD", 0xa434)).toBe("Lens");
    expect(value(t, "Interop", 0x0001)).toBe("R98");
  });
});

describe("TIFF robustness", () => {
  it("rejects data that is not TIFF", () => {
    expect(() => parseTiff(new Uint8Array(4))).toThrow(/too short/);
    expect(() => parseTiff(new TextEncoder().encode("XX*\0\0\0\0\x08"))).toThrow(/byte-order/);
    expect(() => parseTiff(new Uint8Array([0x49, 0x49, 0x2b, 0, 8, 0, 0, 0]))).toThrow(/magic/);
  });

  it("survives loops, bad offsets, unknown types and truncated tables", () => {
    const bytes = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("Make!") }, { tag: 0x0110, value: ascii("Model") }], exif: [{ tag: 0x8827, value: short(1) }] });
    const tiff = parseTiff(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const ifd0 = tiff.ifds.get("IFD0")!;
    // IFD0's next pointer → IFD0 itself (a loop); Exif pointer → out of range; Model gets an unknown type.
    view.setUint32(ifd0.offset + 2 + ifd0.entries.length * 12, ifd0.offset, true);
    const exifPtr = ifd0.entries.find((e) => e.tag === 0x8769)!;
    view.setUint32(exifPtr.entryOffset + 8, 0xfffff, true);
    view.setUint16(ifd0.entries[1]!.entryOffset + 2, 99, true);
    // Make's value points past the end.
    view.setUint32(ifd0.entries[0]!.entryOffset + 8, 0xffff, true);
    const broken = parseTiff(bytes);
    expect(broken.warnings.join(" ")).toMatch(/loop/);
    expect(broken.warnings.join(" ")).toMatch(/outside/);
    expect(broken.warnings.join(" ")).toMatch(/unknown type/);
    const make = broken.ifds.get("IFD0")!.entries.find((e) => e.tag === 0x010f)!;
    expect(make.broken).toBe(true);
    expect(readValue(broken, make)).toBeUndefined();
    // Removal still works and leaves a parseable structure.
    expect(() => parseTiff(removeTiffEntries(broken, [{ ifd: "IFD0", tag: 0x010f }]))).not.toThrow();

    const table = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("M") }] });
    new DataView(table.buffer, table.byteOffset).setUint16(8, 500, true); // claims 500 entries
    expect(parseTiff(table).warnings.join(" ")).toMatch(/declares 500 entries/);
  });

  it("decodes every value type", () => {
    const bytes = buildTiff({ ifd0: [{ tag: 0x9c9b, value: { type: 1, data: [72, 0, 105, 0, 0, 0] } }] });
    let t = parseTiff(bytes);
    for (const [type, input, expected] of [
      [TYPE_SSHORT, [-5], -5],
      [TYPE_SLONG, [-70000], -70000],
      [TYPE_SRATIONAL, [-0.5], [[-1, 2]]],
      [TYPE_FLOAT, [1.5], 1.5],
      [TYPE_DOUBLE, [2.25], 2.25],
    ] as const) {
      const enc = encodeValue("IFD0", 0x9999, type, input as unknown as number[], true);
      expect(enc.type).toBe(type);
      const entry = { tag: 0x9999, type, count: enc.count, entryOffset: 0, valueOffset: 0, byteLength: enc.bytes.length, inline: true, broken: false, known: true };
      expect(readValue({ ...t, bytes: enc.bytes }, entry)).toEqual(expected);
    }
    t = parseTiff(bytes);
    expect(formatExifValue("IFD0", 0x9c9b, value(t, "IFD0", 0x9c9b), true)).toBe("Hi");
  });

  it("encodes values with validation", () => {
    expect(() => encodeValue("ExifIFD", 0x829a, 5, -1, true)).toThrow(/negative/);
    expect(() => encodeValue("ExifIFD", 0x8827, 3, "abc", true)).toThrow(/not a number/);
    expect(() => encodeValue("ExifIFD", 0x8827, 3, Number.POSITIVE_INFINITY as unknown as number, true)).toThrow(/finite/);
    expect(() => encodeValue("ExifIFD", 0x829a, 5, Number.NaN, true)).toThrow(/finite/);
    const uc = encodeValue("ExifIFD", 0x9286, 7, "café", false);
    expect(new TextDecoder().decode(uc.bytes.subarray(0, 8))).toBe("UNICODE\0");
    expect([...uc.bytes.subarray(8, 10)]).toEqual([0, 0x63]); // big-endian UTF-16
    const xp = encodeValue("IFD0", 0x9c9d, 1, "Ana", false);
    expect([...xp.bytes]).toEqual([65, 0, 110, 0, 97, 0, 0, 0]); // always UTF-16LE
    const undefBytes = encodeValue("ExifIFD", 0xa302, 7, "1, 2, 3", true);
    expect([...undefBytes.bytes]).toEqual([0x31, 0x2c, 0x20, 0x32, 0x2c, 0x20, 0x33]);
    expect(encodeValue("IFD0", 0x010f, TYPE_ASCII, "Cam", true).count).toBe(4);
    expect(encodeValue("ExifIFD", 0x829d, 5, "28/10", true).bytes.length).toBe(8);
  });

  it("refuses to write structural tags and unknown new tags", () => {
    const t = parseTiff(emptyTiff());
    expect(isWritableTag("IFD0", 0x8769)).toBe(false);
    expect(isWritableTag("IFD0", 0x0111)).toBe(false);
    expect(isWritableTag("ExifIFD", 0x927c)).toBe(false);
    expect(isWritableTag("GPS", 0x0002)).toBe(true);
    expect(() => setTiffEntry(t, "IFD0", 0x8769, 1)).toThrow(ImgwandError);
    expect(() => setTiffEntry(t, "IFD0", 0xbeef, "x")).toThrow(/type is not known/);
    expect(() => setTiffEntry(t, "IFD1", 0x011a, 72)).toThrow(/thumbnail/);
  });

  it("names tags and finds them by name", () => {
    expect(tagName("IFD0", 0x010f)).toBe("Make");
    expect(tagName("IFD0", 0x829a)).toBe("ExposureTime"); // EXIF tag misplaced in IFD0 still gets a name
    expect(tagName("GPS", 0xbeef)).toBe("0xbeef");
    expect(tagByName("ExifIFD", "exposuretime")).toBe(0x829a);
    expect(tagByName("IFD0", "0x010F")).toBe(0x010f);
    expect(tagByName("GPS", "Nope")).toBeUndefined();
    expect(defaultIfdFor("GPSLatitude")).toBe("GPS");
    expect(defaultIfdFor("Make")).toBe("IFD0");
    expect(defaultIfdFor("nonsense")).toBeUndefined();
  });
});

describe("EXIF value formatting", () => {
  const f = (ifd: "IFD0" | "ExifIFD" | "GPS", tag: number, v: Parameters<typeof formatExifValue>[2]) => formatExifValue(ifd, tag, v, true);
  it("formats photographic values", () => {
    expect(f("ExifIFD", 0x829a, [[1, 200]])).toBe("1/200 s");
    expect(f("ExifIFD", 0x829a, [[2, 1]])).toBe("2 s");
    expect(f("ExifIFD", 0x829d, [[28, 10]])).toBe("f/2.8");
    expect(f("ExifIFD", 0x9202, [[297, 100]])).toBe("2.97 APEX");
    expect(f("ExifIFD", 0x920a, [[50, 1]])).toBe("50 mm");
    expect(f("ExifIFD", 0x9204, [[-1, 3]])).toBe("-0.33 EV");
    expect(f("ExifIFD", 0xa432, [[24, 1], [70, 1], [28, 10], [28, 10]])).toBe("24-70 mm f/2.8-2.8");
    expect(f("ExifIFD", 0x9209, 0x19)).toBe("Auto, Fired");
    expect(f("ExifIFD", 0x9209, 0x7777)).toBe("30583");
    expect(f("ExifIFD", 0x9101, Uint8Array.of(1, 2, 3, 0))).toBe("Y, Cb, Cr, -");
    expect(f("ExifIFD", 0xa300, Uint8Array.of(3))).toBe("Digital camera");
    expect(f("ExifIFD", 0x927c, new Uint8Array(2048))).toBe("(2.0 KB of vendor data)");
    expect(f("ExifIFD", 0xa302, Uint8Array.of(0, 1, 2, 3))).toBe("(4 B binary data)");
    expect(f("ExifIFD", 0x9000, new TextEncoder().encode("0232"))).toBe("0232");
    expect(f("ExifIFD", 0x9286, new TextEncoder().encode("ASCII\0\0\0hello\0"))).toBe("hello");
    expect(f("ExifIFD", 0x9286, Uint8Array.of(85, 78, 73, 67, 79, 68, 69, 0, 0x41, 0))).toBe("A");
    expect(f("IFD0", 0x0112, 6)).toBe("Rotate 90 CW");
    expect(f("IFD0", 0x011a, [[300, 1]])).toBe("300");
    expect(f("IFD0", 0x011a, undefined)).toMatch(/invalid/);
    expect(f("IFD0", 0x0102, [8, 8, 8])).toBe("8, 8, 8");
    expect(f("IFD0", 0x0111, Array.from({ length: 20 }, (_, i) => i))).toMatch(/… \(20 values\)$/);
  });

  it("formats GPS values", () => {
    expect(f("GPS", 0x0002, [[38, 1], [42, 1], [3600, 100]])).toBe(`38° 42' 36" (38.71)`);
    expect(f("GPS", 0x0006, [[4570, 100]])).toBe("45.7 m");
    expect(f("GPS", 0x0007, [[19, 1], [42, 1], [10, 1]])).toBe("19:42:10");
    expect(f("GPS", 0x0000, Uint8Array.of(2, 3, 0, 0))).toBe("2.3.0.0");
    expect(f("GPS", 0x0005, Uint8Array.of(1))).toBe("Below sea level");
    expect(f("GPS", 0x001b, new TextEncoder().encode("ASCII\0\0\0GPS"))).toBe("GPS");
    expect(dmsToDecimal([[10, 1], [30, 1], [0, 1]])).toBe(10.5);
    expect(f("ExifIFD", 0x829a, [[1, 0]])).toBe("undefined s");
  });
});

it("UserComment fixtures round-trip through the builder", () => {
  const bytes = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("X") }], exif: [{ tag: 0x9286, value: undef("ASCII\0\0\0hey") }, { tag: 0x829a, value: rational([1, 8]) }] });
  const t = parseTiff(bytes);
  expect(formatExifValue("ExifIFD", 0x9286, value(t, "ExifIFD", 0x9286), true)).toBe("hey");
});
