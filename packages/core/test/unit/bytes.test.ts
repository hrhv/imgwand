import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  Endian,
  asUint8Array,
  asciiBytes,
  bytesEqual,
  concatBytes,
  copyBytes,
  decodeText,
  formatBytes,
  hex,
  latin1,
  readU16BE,
  readU16LE,
  readU32BE,
  readU32LE,
  startsWith,
  utf8,
  writeU16BE,
  writeU32BE,
  writeU32LE,
} from "../../src/util/bytes.js";
import { crc32 } from "../../src/util/crc32.js";

describe("byte helpers", () => {
  it("copyBytes really copies, even for Buffers (whose slice() is a view)", () => {
    const buffer = Buffer.from([1, 2, 3]);
    const view = buffer.slice();
    view[0] = 9;
    expect(buffer[0]).toBe(9); // the trap copyBytes exists for
    const copy = copyBytes(buffer);
    copy[1] = 7;
    expect(buffer[1]).toBe(2);
  });

  it("asUint8Array turns a Buffer into a plain view of the same memory", () => {
    const buffer = Buffer.from([1, 2, 3, 4]).subarray(1);
    const plain = asUint8Array(buffer);
    expect(Object.getPrototypeOf(plain)).toBe(Uint8Array.prototype);
    expect([...plain]).toEqual([2, 3, 4]);
    plain[0] = 5;
    expect(buffer[0]).toBe(5);
    const already = new Uint8Array(2);
    expect(asUint8Array(already)).toBe(already);
  });

  it("concatenates, compares and matches prefixes", () => {
    expect([...concatBytes([Uint8Array.of(1), Uint8Array.of(), Uint8Array.of(2, 3)])]).toEqual([1, 2, 3]);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
    expect(startsWith(asciiBytes("Exif\0\0rest"), "Exif\0\0")).toBe(true);
    expect(startsWith(asciiBytes("Exi"), "Exif")).toBe(false);
    expect(startsWith(asciiBytes("xxExif"), asciiBytes("Exif"), 2)).toBe(true);
  });

  it("decodes UTF-8 and falls back to Latin-1", () => {
    expect(decodeText(utf8("café ✓"))).toBe("café ✓");
    expect(decodeText(Uint8Array.of(0x63, 0x61, 0x66, 0xe9))).toBe("café");
    expect(latin1(Uint8Array.of(0x41, 0x42, 0x43), 1)).toBe("BC");
    // Bounds are clamped to the view: never read the neighbouring bytes of a pooled buffer.
    const view = Buffer.from("XXABYY").subarray(2, 4);
    expect(latin1(view, 0, 10)).toBe("AB");
    expect(latin1(view, 5, 12)).toBe("");
    expect(latin1(Uint8Array.of(0x80, 0x9b, 0xe9))).toBe("\u0080\u009bé"); // ISO-8859-1, not windows-1252
  });

  it("reads and writes both byte orders", () => {
    const b = new Uint8Array(8);
    writeU16BE(b, 0, 0x1234);
    writeU32BE(b, 2, 0xdeadbeef);
    expect(readU16BE(b, 0)).toBe(0x1234);
    expect(readU32BE(b, 2)).toBe(0xdeadbeef);
    writeU32LE(b, 4, 0x01020304);
    expect(readU32LE(b, 4)).toBe(0x01020304);
    expect(readU16LE(b, 4)).toBe(0x0304);
  });

  it("Endian reads signed values and refuses out-of-range access", () => {
    const b = new Uint8Array(8);
    const le = new Endian(b, true);
    le.setU16(0, 0xfffe);
    le.setU32(2, 0xffffffff);
    expect(le.i16(0)).toBe(-2);
    expect(le.i32(2)).toBe(-1);
    expect(le.u8(0)).toBe(0xfe);
    const be = new Endian(b, false);
    be.setU16(0, 0x0102);
    expect([b[0], b[1]]).toEqual([1, 2]);
    expect(() => le.u32(6)).toThrow(RangeError);
    expect(() => le.u16(-1)).toThrow(RangeError);
  });

  it("formats sizes and hex", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(hex(0x10f)).toBe("0x010F");
    expect(hex(7, 2)).toBe("0x07");
  });
});

describe("crc32", () => {
  it("matches the standard check value and zlib", () => {
    expect(crc32(asciiBytes("123456789"))).toBe(0xcbf43926);
    const data = utf8("The quick brown fox jumps over the lazy dog");
    expect(crc32(data)).toBe(zlibCrc32(data));
  });

  it("accepts the data in several parts", () => {
    expect(crc32(asciiBytes("1234"), asciiBytes("56789"))).toBe(0xcbf43926);
    expect(crc32()).toBe(0);
  });
});
