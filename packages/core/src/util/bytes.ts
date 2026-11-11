/** Small helpers for working with binary image data. Everything operates on Uint8Array (Buffer is a subclass). */

/**
 * A copy of the bytes. Never use `.slice()` for this: on a Node Buffer it returns a view of the same memory, so
 * writing to the "copy" would modify the caller's data.
 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** A plain Uint8Array view of the same memory (so that Buffer's view-returning slice() can never sneak in). */
export function asUint8Array(bytes: Uint8Array): Uint8Array {
  return Object.getPrototypeOf(bytes) === Uint8Array.prototype ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when `bytes` contains `prefix` starting at `offset`. */
export function startsWith(bytes: Uint8Array, prefix: Uint8Array | string, offset = 0): boolean {
  const p = typeof prefix === "string" ? asciiBytes(prefix) : prefix;
  if (offset + p.length > bytes.length) return false;
  for (let i = 0; i < p.length; i++) if (bytes[offset + i] !== p[i]) return false;
  return true;
}

export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  // Buffer's "latin1" is true ISO-8859-1 (TextDecoder's "latin1" label means windows-1252), and decodes natively.
  const from = Math.min(Math.max(0, start), bytes.length);
  const to = Math.min(Math.max(from, end), bytes.length);
  return Buffer.from(bytes.buffer, bytes.byteOffset + from, to - from).toString("latin1");
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

/** Decodes UTF-8, falling back to Latin-1 for byte sequences that are not valid UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return latin1(bytes);
  }
}

export function utf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

export function readU16BE(b: Uint8Array, o: number): number {
  return ((b[o]! << 8) | b[o + 1]!) >>> 0;
}

export function readU32BE(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

export function readU16LE(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8)) >>> 0;
}

export function readU32LE(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

export function writeU16BE(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
}

export function writeU32BE(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

export function writeU32LE(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

/** Endian-aware reader/writer over a TIFF-style buffer. */
export class Endian {
  constructor(
    readonly bytes: Uint8Array,
    readonly littleEndian: boolean,
  ) {}

  u8(o: number): number {
    this.check(o, 1);
    return this.bytes[o]!;
  }

  u16(o: number): number {
    this.check(o, 2);
    return this.littleEndian ? readU16LE(this.bytes, o) : readU16BE(this.bytes, o);
  }

  u32(o: number): number {
    this.check(o, 4);
    return this.littleEndian ? readU32LE(this.bytes, o) : readU32BE(this.bytes, o);
  }

  i16(o: number): number {
    const v = this.u16(o);
    return v & 0x8000 ? v - 0x10000 : v;
  }

  i32(o: number): number {
    return this.u32(o) | 0;
  }

  setU16(o: number, v: number): void {
    this.check(o, 2);
    if (this.littleEndian) {
      this.bytes[o] = v & 0xff;
      this.bytes[o + 1] = (v >>> 8) & 0xff;
    } else writeU16BE(this.bytes, o, v);
  }

  setU32(o: number, v: number): void {
    this.check(o, 4);
    if (this.littleEndian) writeU32LE(this.bytes, o, v);
    else writeU32BE(this.bytes, o, v);
  }

  private check(o: number, n: number): void {
    if (o < 0 || o + n > this.bytes.length) throw new RangeError(`read of ${n} bytes at ${o} is outside a ${this.bytes.length}-byte buffer`);
  }
}

export function hex(n: number, width = 4): string {
  return `0x${n.toString(16).toUpperCase().padStart(width, "0")}`;
}

/** Human-readable byte size: 512 B, 1.2 KB, 3.4 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
