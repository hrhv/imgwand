import { ImgwandError } from "../errors.js";
import { Endian, asUint8Array, asciiBytes, concatBytes, copyBytes, decodeText, latin1, utf8 } from "../util/bytes.js";
import {
  POINTERS,
  TAG_EXIF_IFD,
  TAG_GPS_IFD,
  TAG_INTEROP_IFD,
  TAG_MAKERNOTE,
  TAG_THUMBNAIL_LENGTH,
  TAG_THUMBNAIL_OFFSET,
  TYPE_ASCII,
  TYPE_BYTE,
  TYPE_DOUBLE,
  TYPE_FLOAT,
  TYPE_IFD,
  TYPE_LONG,
  TYPE_RATIONAL,
  TYPE_SBYTE,
  TYPE_SHORT,
  TYPE_SIZES,
  TYPE_SLONG,
  TYPE_SRATIONAL,
  TYPE_SSHORT,
  TYPE_UNDEFINED,
  tagDef,
  type IfdName,
} from "./tags.js";

/**
 * A TIFF structure (the payload of an EXIF block) and lossless edits on it.
 *
 * Edits never move existing data: removed entries are dropped from their IFD table (which shrinks in place) and
 * their out-of-line value bytes are zeroed, and new or longer values are appended at the end. That keeps every
 * absolute offset in the block valid, including the private offsets inside vendor MakerNotes, which tools that
 * rebuild the whole TIFF structure routinely break.
 */

export interface TiffEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Offset of the 12-byte entry within the TIFF data. */
  readonly entryOffset: number;
  /** Offset of the value bytes: inside the entry when they fit in 4 bytes, elsewhere otherwise. */
  readonly valueOffset: number;
  readonly byteLength: number;
  readonly inline: boolean;
  /** The value points outside the TIFF data (a corrupt or truncated file). */
  readonly broken: boolean;
  /** The value type is not one TIFF defines; the entry is kept as opaque bytes and cannot be read or written. */
  readonly known: boolean;
}

export interface TiffIfd {
  readonly name: IfdName;
  readonly offset: number;
  readonly entries: readonly TiffEntry[];
  readonly nextOffset: number;
  /** Fewer entries could be read than the table declares; such an IFD is not safe to rewrite. */
  readonly truncated: boolean;
}

export interface Tiff {
  readonly bytes: Uint8Array;
  readonly littleEndian: boolean;
  readonly ifds: ReadonlyMap<IfdName, TiffIfd>;
  readonly warnings: readonly string[];
}

export type Rational = readonly [numerator: number, denominator: number];
export type ExifValue = string | number | readonly number[] | readonly Rational[] | Uint8Array;

const MAX_ENTRIES = 1000;

export function parseTiff(input: Uint8Array): Tiff {
  const bytes = asUint8Array(input);
  if (bytes.length < 8) throw new ImgwandError("CORRUPT_FILE", "EXIF data is too short to be a TIFF structure");
  const order = latin1(bytes, 0, 2);
  if (order !== "II" && order !== "MM") throw new ImgwandError("CORRUPT_FILE", "EXIF data has no TIFF byte-order mark");
  const e = new Endian(bytes, order === "II");
  if (e.u16(2) !== 42) throw new ImgwandError("CORRUPT_FILE", "EXIF data has a bad TIFF magic number");

  const ifds = new Map<IfdName, TiffIfd>();
  const warnings: string[] = [];
  const visited = new Set<number>();

  const readIfd = (name: IfdName, offset: number): TiffIfd | undefined => {
    if (offset === 0) return undefined;
    if (visited.has(offset)) {
      warnings.push(`${name} points back at an IFD that was already read (loop); ignored`);
      return undefined;
    }
    if (offset < 8 || offset + 2 > bytes.length) {
      warnings.push(`${name} offset ${offset} is outside the EXIF data; ignored`);
      return undefined;
    }
    visited.add(offset);
    const declared = e.u16(offset);
    const fits = Math.floor((bytes.length - offset - 2) / 12);
    const count = Math.min(declared, fits, MAX_ENTRIES);
    if (count < declared) warnings.push(`${name} declares ${declared} entries but only ${count} fit; the rest were ignored`);
    const entries: TiffEntry[] = [];
    for (let i = 0; i < count; i++) {
      const entryOffset = offset + 2 + i * 12;
      const tag = e.u16(entryOffset);
      const type = e.u16(entryOffset + 2);
      const n = e.u32(entryOffset + 4);
      const size = TYPE_SIZES[type];
      if (size === undefined) {
        // Kept (so edits never drop or overwrite it) but opaque: its value cannot be located or decoded.
        warnings.push(`${name} entry 0x${tag.toString(16)} has unknown type ${type}`);
        entries.push({ tag, type, count: n, entryOffset, valueOffset: entryOffset + 8, byteLength: 0, inline: true, broken: false, known: false });
        continue;
      }
      const byteLength = size * n;
      const inline = byteLength <= 4;
      const valueOffset = inline ? entryOffset + 8 : e.u32(entryOffset + 8);
      const broken = !inline && (byteLength > bytes.length || valueOffset + byteLength > bytes.length);
      entries.push({ tag, type, count: n, entryOffset, valueOffset, byteLength, inline, broken, known: true });
    }
    const nextPos = offset + 2 + count * 12;
    const nextOffset = count === declared && nextPos + 4 <= bytes.length ? e.u32(nextPos) : 0;
    const ifd: TiffIfd = { name, offset, entries, nextOffset, truncated: count < declared };
    ifds.set(name, ifd);
    return ifd;
  };

  const pointer = (ifd: TiffIfd | undefined, tag: number) => {
    const entry = ifd?.entries.find((x) => x.tag === tag);
    if (!entry || entry.broken) return 0;
    return e.u32(entry.valueOffset);
  };

  const ifd0 = readIfd("IFD0", e.u32(4));
  const exif = readIfd("ExifIFD", pointer(ifd0, TAG_EXIF_IFD));
  readIfd("GPS", pointer(ifd0, TAG_GPS_IFD));
  readIfd("Interop", pointer(exif, TAG_INTEROP_IFD));
  if (ifd0 && ifd0.nextOffset) readIfd("IFD1", ifd0.nextOffset);
  return { bytes, littleEndian: e.littleEndian, ifds, warnings };
}

/** Items decoded per entry; more are summarized by count. Keeps hostile files from building huge arrays. */
export const MAX_VALUE_ITEMS = 256;
/** Text decoded per ASCII entry. */
const MAX_TEXT_BYTES = 64 * 1024;

/**
 * Decodes an entry's value. Byte values are returned as views into the TIFF data (not copies), numeric arrays are
 * capped at `limit` items, and text at 64 KB, so one small file cannot make thousands of large copies.
 */
export function readValue(tiff: Tiff, entry: TiffEntry, limit = MAX_VALUE_ITEMS): ExifValue | undefined {
  if (entry.broken || !entry.known) return undefined;
  const e = new Endian(tiff.bytes, tiff.littleEndian);
  const at = entry.valueOffset;
  const items = Math.min(entry.count, limit);
  const many = <T>(read: (i: number) => T): T | T[] => {
    const values: T[] = [];
    for (let i = 0; i < items; i++) values.push(read(i));
    return entry.count === 1 ? values[0]! : values;
  };
  switch (entry.type) {
    case TYPE_ASCII: {
      const raw = tiff.bytes.subarray(at, at + Math.min(entry.byteLength, MAX_TEXT_BYTES));
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      return decodeText(raw.subarray(0, end));
    }
    case TYPE_BYTE:
    case TYPE_SBYTE:
    case TYPE_UNDEFINED:
      return tiff.bytes.subarray(at, at + entry.byteLength);
    case TYPE_SHORT:
      return many((i) => e.u16(at + i * 2));
    case TYPE_SSHORT:
      return many((i) => e.i16(at + i * 2));
    case TYPE_LONG:
    case TYPE_IFD:
      return many((i) => e.u32(at + i * 4));
    case TYPE_SLONG:
      return many((i) => e.i32(at + i * 4));
    case TYPE_RATIONAL: {
      const out: Rational[] = [];
      for (let i = 0; i < items; i++) out.push([e.u32(at + i * 8), e.u32(at + i * 8 + 4)]);
      return out;
    }
    case TYPE_SRATIONAL: {
      const out: Rational[] = [];
      for (let i = 0; i < items; i++) out.push([e.i32(at + i * 8), e.i32(at + i * 8 + 4)]);
      return out;
    }
    case TYPE_FLOAT:
    case TYPE_DOUBLE: {
      const view = new DataView(tiff.bytes.buffer, tiff.bytes.byteOffset, tiff.bytes.byteLength);
      const size = entry.type === TYPE_FLOAT ? 4 : 8;
      return many((i) => (size === 4 ? view.getFloat32(at + i * 4, tiff.littleEndian) : view.getFloat64(at + i * 8, tiff.littleEndian)));
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Editing

/** A tag to remove. `tag: "*"` removes the whole IFD (for sub-IFDs, together with the pointer to it). */
export interface TiffTarget {
  readonly ifd: IfdName;
  readonly tag: number | "*";
}

const SUB_IFD_PARENT: Partial<Record<IfdName, { parent: IfdName; tag: number }>> = {
  ExifIFD: { parent: "IFD0", tag: TAG_EXIF_IFD },
  GPS: { parent: "IFD0", tag: TAG_GPS_IFD },
  Interop: { parent: "ExifIFD", tag: TAG_INTEROP_IFD },
};

type Range = readonly [start: number, end: number];

function zeroExcept(out: Uint8Array, range: Range, keep: readonly Range[]): void {
  for (let i = range[0]; i < range[1] && i < out.length; i++) {
    if (!keep.some(([s, e]) => i >= s && i < e)) out[i] = 0;
  }
}

function tableRange(ifd: TiffIfd, entryCount = ifd.entries.length): Range {
  return [ifd.offset, ifd.offset + 2 + entryCount * 12 + 4];
}

function thumbnailRange(tiff: Tiff, ifd1: TiffIfd): Range | undefined {
  const off = ifd1.entries.find((x) => x.tag === TAG_THUMBNAIL_OFFSET);
  const len = ifd1.entries.find((x) => x.tag === TAG_THUMBNAIL_LENGTH);
  if (!off || !len) return undefined;
  const start = readValue(tiff, off);
  const length = readValue(tiff, len);
  if (typeof start !== "number" || typeof length !== "number") return undefined;
  return [start, Math.min(tiff.bytes.length, start + length)];
}

/** Removes entries (and whole IFDs) in place. The result has the same length as the input. */
export function removeTiffEntries(tiff: Tiff, targets: readonly TiffTarget[]): Uint8Array {
  const out = copyBytes(tiff.bytes);
  const e = new Endian(out, tiff.littleEndian);

  // Work out which IFDs disappear entirely and which entries go from the IFDs that stay.
  const erased = new Set<IfdName>();
  const removed = new Map<IfdName, Set<number>>();
  const eraseIfd = (name: IfdName): void => {
    if (!tiff.ifds.has(name) || erased.has(name)) return;
    erased.add(name);
    for (const [tag, child] of Object.entries(POINTERS)) {
      if (tiff.ifds.get(name)?.entries.some((x) => x.tag === Number(tag))) eraseIfd(child);
    }
    if (name === "IFD0") eraseIfd("IFD1");
    const link = SUB_IFD_PARENT[name];
    if (link) removeEntry(link.parent, link.tag);
  };
  const removeEntry = (name: IfdName, tag: number): void => {
    const ifd = tiff.ifds.get(name);
    if (!ifd || !ifd.entries.some((x) => x.tag === tag)) return;
    if (!removed.has(name)) removed.set(name, new Set());
    removed.get(name)!.add(tag);
    const child = POINTERS[tag];
    if (child && (name === "IFD0" || name === "ExifIFD")) eraseIfd(child);
  };
  for (const target of targets) {
    if (target.tag === "*") eraseIfd(target.ifd);
    else removeEntry(target.ifd, target.tag);
  }
  // A sub-IFD (or thumbnail IFD) left without entries goes away together with its pointer. Repeat until stable,
  // since erasing Interop can empty ExifIFD.
  for (let changed = true; changed; ) {
    changed = false;
    for (const ifd of tiff.ifds.values()) {
      if (ifd.name === "IFD0" || erased.has(ifd.name)) continue;
      const gone = removed.get(ifd.name);
      const alive = ifd.entries.filter((x) => !gone?.has(x.tag) && !(POINTERS[x.tag] && erased.has(POINTERS[x.tag]!)));
      if (alive.length === 0) {
        eraseIfd(ifd.name);
        changed = true;
      }
    }
  }

  // Bytes that must survive: tables and values of everything that stays (values may be shared between entries).
  const keep: Range[] = [[0, 8]];
  for (const ifd of tiff.ifds.values()) {
    if (erased.has(ifd.name)) continue;
    const gone = removed.get(ifd.name);
    const kept = ifd.entries.filter((x) => !gone?.has(x.tag));
    keep.push(tableRange(ifd, kept.length));
    for (const entry of kept) if (!entry.inline && !entry.broken) keep.push([entry.valueOffset, entry.valueOffset + entry.byteLength]);
    if (ifd.name === "IFD1") {
      const thumb = thumbnailRange(tiff, ifd);
      if (thumb) keep.push(thumb);
    }
  }

  const ifd1Erased = erased.has("IFD1");
  for (const ifd of tiff.ifds.values()) {
    if (erased.has(ifd.name)) {
      for (const entry of ifd.entries) if (!entry.inline && !entry.broken) zeroExcept(out, [entry.valueOffset, entry.valueOffset + entry.byteLength], keep);
      if (ifd.name === "IFD1") {
        const thumb = thumbnailRange(tiff, ifd);
        if (thumb) zeroExcept(out, thumb, keep);
      }
      zeroExcept(out, tableRange(ifd), keep);
      continue;
    }
    const gone = removed.get(ifd.name);
    const unlinkNext = ifd.name === "IFD0" && ifd1Erased;
    if (!gone && !unlinkNext) continue;
    if (ifd.truncated) throw new ImgwandError("CORRUPT_FILE", `${ifd.name} is truncated and cannot be edited safely; remove the whole EXIF block instead`);
    const kept = ifd.entries.filter((x) => !gone?.has(x.tag));
    for (const entry of ifd.entries) {
      if (gone?.has(entry.tag) && !entry.inline && !entry.broken) zeroExcept(out, [entry.valueOffset, entry.valueOffset + entry.byteLength], keep);
    }
    // Rewrite the table in place: count, surviving entries (original bytes, original order), next-IFD offset.
    const original = tiff.bytes;
    e.setU16(ifd.offset, kept.length);
    kept.forEach((entry, i) => out.set(original.subarray(entry.entryOffset, entry.entryOffset + 12), ifd.offset + 2 + i * 12));
    const nextPos = ifd.offset + 2 + kept.length * 12;
    e.setU32(nextPos, unlinkNext ? 0 : ifd.nextOffset);
    out.fill(0, nextPos + 4, ifd.offset + 2 + ifd.entries.length * 12 + 4);
  }
  if (erased.has("IFD0")) e.setU32(4, 0);
  return out;
}

// --- writing values --------------------------------------------------------------------------------------------

export type ExifInput = string | number | readonly number[];

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes[i * 2 + (littleEndian ? 0 : 1)] = c & 0xff;
    bytes[i * 2 + (littleEndian ? 1 : 0)] = c >>> 8;
  }
  return bytes;
}

function toRational(value: number, signed: boolean): Rational {
  if (!Number.isFinite(value)) throw new ImgwandError("INVALID_VALUE", `${value} is not a finite number`);
  if (Number.isInteger(value)) return [value, 1];
  // Continued-fraction approximation with a 32-bit denominator.
  let h1 = 1, h0 = 0, k1 = 0, k0 = 1, x = Math.abs(value);
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > 0xffffffff || h2 > (signed ? 0x7fffffff : 0xffffffff)) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    if (Math.abs(value) - h1 / k1 === 0 || x - a < 1e-12) break;
    x = 1 / (x - a);
  }
  return [value < 0 ? -h1 : h1, k1];
}

function parseNumbers(input: ExifInput): number[] {
  if (typeof input === "number") return [input];
  if (Array.isArray(input)) return [...input];
  const parts = String(input).split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) throw new ImgwandError("INVALID_VALUE", "A number is required");
  return parts.map((p) => {
    const fraction = /^(-?\d+)\/(\d+)$/.exec(p);
    const n = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(p);
    if (!Number.isFinite(n)) throw new ImgwandError("INVALID_VALUE", `"${p}" is not a number`);
    return n;
  });
}

/** Decimal degrees become degrees/minutes/seconds (the sign goes in the Ref tag, set by the caller). */
export function gpsDms(value: number): number[] {
  // Round once, in units of 1/10000 s, so 10.99999999° becomes 11° 0' 0" rather than 10° 59' 60".
  const total = Math.round(Math.abs(value) * 3600 * 10000);
  const deg = Math.floor(total / (3600 * 10000));
  const min = Math.floor((total % (3600 * 10000)) / (60 * 10000));
  const sec = (total % (60 * 10000)) / 10000;
  return [deg, min, sec];
}

const INTEGER_RANGES: Record<number, readonly [number, number]> = {
  [TYPE_BYTE]: [0, 0xff],
  [TYPE_SBYTE]: [-0x80, 0x7f],
  [TYPE_SHORT]: [0, 0xffff],
  [TYPE_SSHORT]: [-0x8000, 0x7fff],
  [TYPE_LONG]: [0, 0xffffffff],
  [TYPE_SLONG]: [-0x80000000, 0x7fffffff],
  [TYPE_IFD]: [0, 0xffffffff],
};

export function encodeValue(ifd: IfdName, tag: number, type: number, input: ExifInput, littleEndian: boolean): { type: number; count: number; bytes: Uint8Array } {
  const name = tagDef(ifd, tag)?.name ?? "";
  if (type === TYPE_ASCII) {
    const bytes = concatBytes([utf8(String(input)), Uint8Array.of(0)]);
    return { type, count: bytes.length, bytes };
  }
  if (name.startsWith("XP") && type === TYPE_BYTE) {
    // Windows XP tags are always UTF-16LE, NUL-terminated, regardless of the TIFF byte order.
    const bytes = concatBytes([utf16(String(input), true), Uint8Array.of(0, 0)]);
    return { type, count: bytes.length, bytes };
  }
  if (type === TYPE_UNDEFINED) {
    if (name === "UserComment") {
      const text = String(input);
      const ascii = /^[\x00-\x7f]*$/.test(text);
      const body = ascii ? asciiBytes(text) : utf16(text, littleEndian);
      const bytes = concatBytes([asciiBytes(ascii ? "ASCII\0\0\0" : "UNICODE\0"), body]);
      return { type, count: bytes.length, bytes };
    }
    const bytes = typeof input === "string" ? utf8(input) : Uint8Array.from(parseNumbers(input));
    return { type, count: bytes.length, bytes };
  }
  let numbers = parseNumbers(input);
  if (/^GPS(Dest)?(Latitude|Longitude)$/.test(name) && numbers.length === 1) numbers = gpsDms(numbers[0]!);
  const size = TYPE_SIZES[type];
  if (size === undefined) throw new ImgwandError("NOT_WRITABLE", `Unsupported TIFF type ${type}`);
  const range = INTEGER_RANGES[type];
  for (const n of numbers) {
    if (!Number.isFinite(n)) throw new ImgwandError("INVALID_VALUE", `${n} is not a finite number`);
    if (range && (!Number.isInteger(n) || n < range[0] || n > range[1])) {
      throw new ImgwandError("INVALID_VALUE", `${name || "This tag"} needs whole numbers from ${range[0]} to ${range[1]} (got ${n})`);
    }
    if ((type === TYPE_RATIONAL && Math.abs(n) > 0xffffffff) || (type === TYPE_SRATIONAL && Math.abs(n) > 0x7fffffff)) {
      throw new ImgwandError("INVALID_VALUE", `${n} is too large for ${name || "this tag"}`);
    }
  }
  const bytes = new Uint8Array(numbers.length * size);
  const e = new Endian(bytes, littleEndian);
  const view = new DataView(bytes.buffer);
  numbers.forEach((n, i) => {
    const at = i * size;
    switch (type) {
      case TYPE_BYTE:
      case TYPE_SBYTE:
        bytes[at] = n & 0xff;
        break;
      case TYPE_SHORT:
      case TYPE_SSHORT:
        e.setU16(at, n & 0xffff);
        break;
      case TYPE_LONG:
      case TYPE_SLONG:
      case TYPE_IFD:
        e.setU32(at, n >>> 0);
        break;
      case TYPE_RATIONAL:
      case TYPE_SRATIONAL: {
        if (type === TYPE_RATIONAL && n < 0) throw new ImgwandError("INVALID_VALUE", `${name || "This tag"} cannot be negative`);
        const [num, den] = toRational(n, type === TYPE_SRATIONAL);
        e.setU32(at, num >>> 0);
        e.setU32(at + 4, den >>> 0);
        break;
      }
      case TYPE_FLOAT:
        view.setFloat32(at, n, littleEndian);
        break;
      case TYPE_DOUBLE:
        view.setFloat64(at, n, littleEndian);
        break;
    }
  });
  return { type, count: numbers.length, bytes };
}

/** Tags that hold offsets into the data or vendor-private blobs: rewriting them would corrupt the file. */
export function isWritableTag(ifd: IfdName, tag: number): boolean {
  if (POINTERS[tag] !== undefined) return false;
  if (tag === TAG_THUMBNAIL_OFFSET || tag === TAG_THUMBNAIL_LENGTH || tag === TAG_MAKERNOTE) return false;
  if (ifd === "IFD0" || ifd === "IFD1") return ![0x0111, 0x0117, 0x0144, 0x0145, 0x014a].includes(tag); // strip/tile offsets, SubIFDs
  return true;
}

function align(n: number): number {
  return n + (n & 1);
}

/** A minimal, empty big-endian TIFF structure with an IFD0 and no entries. */
export function emptyTiff(): Uint8Array {
  return Uint8Array.of(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}

/**
 * Sets a tag to a new value, creating the tag (and its IFD) when needed. Returns the new TIFF bytes; data that is
 * not part of the edited tag never moves.
 */
export function setTiffEntry(tiff: Tiff, ifdName: IfdName, tag: number, input: ExifInput): Uint8Array {
  if (!isWritableTag(ifdName, tag)) throw new ImgwandError("NOT_WRITABLE", `EXIF tag 0x${tag.toString(16)} in ${ifdName} is not writable`);
  const ifd = tiff.ifds.get(ifdName);
  const existing = ifd?.entries.find((x) => x.tag === tag);
  const type = existing?.type ?? tagDef(ifdName, tag)?.type;
  if (type === undefined) throw new ImgwandError("NOT_WRITABLE", `Unknown EXIF tag 0x${tag.toString(16)}: its type is not known, so it cannot be created`);
  const encoded = encodeValue(ifdName, tag, type, input, tiff.littleEndian);
  const fits = encoded.bytes.length <= 4;

  if (existing && ifd) {
    let out: Uint8Array = copyBytes(tiff.bytes);
    const e = () => new Endian(out, tiff.littleEndian);
    const oldRange: Range | undefined = existing.inline || existing.broken ? undefined : [existing.valueOffset, existing.valueOffset + existing.byteLength];
    let valueField: number;
    if (fits) {
      valueField = -1;
    } else if (oldRange && encoded.bytes.length <= existing.byteLength) {
      valueField = existing.valueOffset;
    } else {
      valueField = align(out.length);
      out = concatBytes([out, new Uint8Array(valueField - out.length), encoded.bytes]);
    }
    if (oldRange) out.fill(0, oldRange[0], oldRange[1]);
    e().setU16(existing.entryOffset + 2, encoded.type);
    e().setU32(existing.entryOffset + 4, encoded.count);
    if (fits) {
      out.fill(0, existing.entryOffset + 8, existing.entryOffset + 12);
      out.set(encoded.bytes, existing.entryOffset + 8);
    } else {
      out.set(encoded.bytes, valueField);
      e().setU32(existing.entryOffset + 8, valueField);
    }
    return out;
  }

  // The tag is new: write a new copy of its IFD (old entries + this one, sorted) at the end and repoint to it.
  if (!ifd) {
    if (ifdName === "IFD1") throw new ImgwandError("NOT_WRITABLE", "Cannot create a thumbnail IFD");
    if (!SUB_IFD_PARENT[ifdName]) throw new ImgwandError("CORRUPT_FILE", "EXIF data has no IFD0");
    return appendIfd(tiff, ifdName, tag, encoded);
  }
  return relocateWithEntry(tiff, ifd, tag, encoded);
}

type Encoded = { type: number; count: number; bytes: Uint8Array };

/** Writes a new one-entry IFD at the end and links it into its parent (creating the parent too if needed). */
function appendIfd(tiff: Tiff, ifdName: IfdName, tag: number, encoded: Encoded): Uint8Array {
  const link = SUB_IFD_PARENT[ifdName]!;
  const fits = encoded.bytes.length <= 4;
  const at = align(tiff.bytes.length);
  const table = new Uint8Array(2 + 12 + 4 + (fits ? 0 : encoded.bytes.length));
  const te = new Endian(table, tiff.littleEndian);
  te.setU16(0, 1);
  te.setU16(2, tag);
  te.setU16(4, encoded.type);
  te.setU32(6, encoded.count);
  if (fits) table.set(encoded.bytes, 10);
  else {
    te.setU32(10, at + 18);
    table.set(encoded.bytes, 18);
  }
  const grown = parseTiff(concatBytes([tiff.bytes, new Uint8Array(at - tiff.bytes.length), table]));
  const pointer: Encoded = { type: TYPE_LONG, count: 1, bytes: new Uint8Array(4) };
  new Endian(pointer.bytes, tiff.littleEndian).setU32(0, at);
  const parent = grown.ifds.get(link.parent);
  if (!parent) {
    // e.g. an Interop tag in a file without an Exif IFD: create the Exif IFD holding just the pointer.
    if (!SUB_IFD_PARENT[link.parent]) throw new ImgwandError("CORRUPT_FILE", `EXIF data has no ${link.parent}`);
    return appendIfd(grown, link.parent, link.tag, pointer);
  }
  const existing = parent.entries.find((x) => x.tag === link.tag);
  if (existing) {
    const out = copyBytes(grown.bytes);
    const e = new Endian(out, tiff.littleEndian);
    e.setU16(existing.entryOffset + 2, TYPE_LONG);
    e.setU32(existing.entryOffset + 4, 1);
    e.setU32(existing.entryOffset + 8, at);
    return out;
  }
  return relocateWithEntry(grown, parent, link.tag, pointer);
}

function relocateWithEntry(tiff: Tiff, ifd: TiffIfd, tag: number, encoded: Encoded): Uint8Array {
  if (ifd.truncated) throw new ImgwandError("CORRUPT_FILE", `${ifd.name} is truncated and cannot be edited safely`);
  const fits = encoded.bytes.length <= 4;
  const valueAt = align(tiff.bytes.length);
  const withValue = fits ? tiff.bytes : concatBytes([tiff.bytes, new Uint8Array(valueAt - tiff.bytes.length), encoded.bytes]);
  const tableAt = align(withValue.length);
  const entries = [...ifd.entries.map((x) => ({ tag: x.tag, bytes: tiff.bytes.subarray(x.entryOffset, x.entryOffset + 12) })), { tag, bytes: new Uint8Array(12) }];
  const fresh = entries[entries.length - 1]!.bytes;
  const fe = new Endian(fresh, tiff.littleEndian);
  fe.setU16(0, tag);
  fe.setU16(2, encoded.type);
  fe.setU32(4, encoded.count);
  if (fits) fresh.set(encoded.bytes, 8);
  else fe.setU32(8, valueAt);
  entries.sort((a, b) => a.tag - b.tag);

  const table = new Uint8Array(2 + entries.length * 12 + 4);
  const te = new Endian(table, tiff.littleEndian);
  te.setU16(0, entries.length);
  entries.forEach((x, i) => table.set(x.bytes, 2 + i * 12));
  te.setU32(2 + entries.length * 12, ifd.nextOffset);

  const out = concatBytes([withValue, new Uint8Array(tableAt - withValue.length), table]);
  const e = new Endian(out, tiff.littleEndian);
  // Repoint whoever referenced the old table, then clear the old table.
  if (ifd.name === "IFD0") e.setU32(4, tableAt);
  else if (ifd.name === "IFD1") {
    const ifd0 = tiff.ifds.get("IFD0")!;
    e.setU32(ifd0.offset + 2 + ifd0.entries.length * 12, tableAt);
  } else {
    const link = SUB_IFD_PARENT[ifd.name]!;
    const parent = tiff.ifds.get(link.parent)!;
    const ptr = parent.entries.find((x) => x.tag === link.tag)!;
    e.setU32(ptr.entryOffset + 8, tableAt);
  }
  out.fill(0, ifd.offset, ifd.offset + 2 + ifd.entries.length * 12 + 4);
  return out;
}
