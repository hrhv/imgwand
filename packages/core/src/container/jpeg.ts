import { ImgwandError } from "../errors.js";
import { Endian, asUint8Array, asciiBytes, concatBytes, copyBytes, readU16BE, readU32BE, startsWith, writeU16BE } from "../util/bytes.js";
import type { Block, BlockEdit, BlockInsert, BlockKind, Container, ContainerCodec } from "./types.js";

/**
 * JPEG: a sequence of marker segments. Every APPn/COM segment is self-contained (2-byte marker, 2-byte length,
 * payload), so metadata can be dropped or replaced without touching the compressed picture: SOF/DHT/DQT/SOS and
 * the entropy-coded scan data are copied through byte for byte.
 */

const EXIF_HEADER = asciiBytes("Exif\0\0");
const XMP_HEADER = asciiBytes("http://ns.adobe.com/xap/1.0/\0");
const XMP_EXT_HEADER = asciiBytes("http://ns.adobe.com/xmp/extension/\0");
const ICC_HEADER = asciiBytes("ICC_PROFILE\0");
const MPF_HEADER = asciiBytes("MPF\0");
const PHOTOSHOP_HEADER = asciiBytes("Photoshop 3.0\0");
const ADOBE_HEADER = asciiBytes("Adobe");
const JUMBF_HEADER = asciiBytes("JP");
/** Largest payload a single segment can carry (the length field is 16 bits and counts itself). */
export const MAX_SEGMENT_PAYLOAD = 0xffff - 2;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP11 = 0xeb;
const APP13 = 0xed;
const APP14 = 0xee;
const COM = 0xfe;

function markerName(marker: number): string {
  if (marker >= 0xe0 && marker <= 0xef) return `APP${marker - 0xe0}`;
  if (marker >= 0xd0 && marker <= 0xd7) return `RST${marker - 0xd0}`;
  const names: Record<number, string> = {
    0xd8: "SOI", 0xd9: "EOI", 0xda: "SOS", 0xdb: "DQT", 0xc4: "DHT", 0xdd: "DRI", 0xfe: "COM", 0xcc: "DAC", 0xdc: "DNL",
  };
  if (names[marker]) return names[marker];
  if (marker >= 0xc0 && marker <= 0xcf) return `SOF${marker - 0xc0}`;
  return `0x${marker.toString(16).toUpperCase()}`;
}

function isStandalone(marker: number): boolean {
  return marker === SOI || marker === EOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

interface Classified {
  kind: BlockKind;
  /** Bytes of the segment body (after the length field) that precede the payload. */
  headerLength: number;
  info?: Record<string, string | number | boolean>;
}

function classify(marker: number, body: Uint8Array): Classified {
  switch (marker) {
    case APP1:
      if (startsWith(body, EXIF_HEADER)) return { kind: "exif", headerLength: EXIF_HEADER.length };
      // Some writers use "Exif\0\xff" as the padding byte; accept it too.
      if (startsWith(body, "Exif\0")) return { kind: "exif", headerLength: 6 };
      if (startsWith(body, XMP_HEADER)) return { kind: "xmp", headerLength: XMP_HEADER.length };
      if (startsWith(body, XMP_EXT_HEADER)) return { kind: "xmp-extended", headerLength: XMP_EXT_HEADER.length };
      return { kind: "other", headerLength: 0 };
    case APP2:
      if (startsWith(body, ICC_HEADER) && body.length >= 14) {
        return { kind: "icc", headerLength: 14, info: { sequence: body[12]!, count: body[13]! } };
      }
      if (startsWith(body, MPF_HEADER)) return { kind: "mpf", headerLength: MPF_HEADER.length };
      return { kind: "other", headerLength: 0 };
    case APP11:
      if (startsWith(body, JUMBF_HEADER) && body.length >= 8) {
        return { kind: "jumbf", headerLength: 8, info: { instance: readU16BE(body, 2), sequence: readU32BE(body, 4) } };
      }
      return { kind: "other", headerLength: 0 };
    case APP13:
      if (startsWith(body, PHOTOSHOP_HEADER)) return { kind: "iptc", headerLength: PHOTOSHOP_HEADER.length };
      return { kind: "other", headerLength: 0 };
    case APP14:
      // The Adobe segment tells decoders how to interpret YCCK/CMYK data: it is part of the picture.
      return { kind: startsWith(body, ADOBE_HEADER) ? "structure" : "other", headerLength: 0 };
    case APP0:
      // JFIF/JFXX: density and the JFIF marker itself; decoders rely on it.
      return { kind: "structure", headerLength: 0 };
    case COM:
      return { kind: "comment", headerLength: 0 };
    default:
      if (marker >= 0xe0 && marker <= 0xef) return { kind: "other", headerLength: 0 };
      return { kind: "structure", headerLength: 0 };
  }
}

/** Finds the end of entropy-coded data that starts at `pos` (the first marker that is not a stuffed byte or RSTn). */
function scanEnd(bytes: Uint8Array, pos: number): number {
  let i = pos;
  while (i < bytes.length - 1) {
    if (bytes[i] === 0xff) {
      const next = bytes[i + 1]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        i += 2;
        continue;
      }
      if (next === 0xff) {
        i += 1;
        continue;
      }
      return i;
    }
    i++;
  }
  return bytes.length;
}

/** A JUMBF superbox labelled "c2pa" marks a C2PA manifest store. */
function looksLikeC2pa(payload: Uint8Array): boolean {
  const window = payload.subarray(0, Math.min(payload.length, 96));
  for (let i = 0; i + 4 <= window.length; i++) {
    if (window[i] === 0x63 && window[i + 1] === 0x32 && window[i + 2] === 0x70 && window[i + 3] === 0x61) return true;
  }
  return false;
}

export function parseJpeg(input: Uint8Array): Container {
  const bytes = asUint8Array(input);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) {
    throw new ImgwandError("CORRUPT_FILE", "Not a JPEG file (missing SOI marker)");
  }
  const blocks: Block[] = [];
  const push = (kind: BlockKind, name: string, start: number, end: number, payloadStart: number, info: Record<string, string | number | boolean> = {}) => {
    blocks.push({
      id: blocks.length,
      kind,
      name,
      offset: start,
      raw: bytes.subarray(start, end),
      payload: bytes.subarray(payloadStart, end),
      info,
    });
  };

  push("structure", "SOI", 0, 2, 2);
  let pos = 2;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) {
      throw new ImgwandError("CORRUPT_FILE", `Corrupt JPEG: expected a marker at byte ${pos}`);
    }
    let m = pos;
    while (m + 1 < bytes.length && bytes[m + 1] === 0xff) m++; // fill bytes
    if (m + 1 >= bytes.length) throw new ImgwandError("CORRUPT_FILE", "Corrupt JPEG: truncated marker");
    const marker = bytes[m + 1]!;

    if (isStandalone(marker)) {
      push("structure", markerName(marker), pos, m + 2, m + 2);
      pos = m + 2;
      if (marker === EOI) break;
      continue;
    }
    if (m + 4 > bytes.length) throw new ImgwandError("CORRUPT_FILE", `Corrupt JPEG: truncated ${markerName(marker)} segment`);
    const length = readU16BE(bytes, m + 2);
    const bodyStart = m + 4;
    let end = m + 2 + length;
    if (length < 2 || end > bytes.length) {
      throw new ImgwandError("CORRUPT_FILE", `Corrupt JPEG: ${markerName(marker)} segment at byte ${pos} runs past the end of the file`);
    }
    if (marker === SOS) {
      end = scanEnd(bytes, end);
      push("structure", "SOS", pos, end, bodyStart);
      pos = end;
      continue;
    }
    const body = bytes.subarray(bodyStart, end);
    const c = classify(marker, body);
    push(c.kind, markerName(marker), pos, end, bodyStart + c.headerLength, { ...c.info, marker, headerLength: c.headerLength });
    pos = end;
  }
  if (pos < bytes.length) {
    // Data after EOI: multi-picture (MPF) secondary images, vendor trailers. Part of the file, never touched.
    push("structure", "trailer", pos, bytes.length, pos);
  }

  // JUMBF segments belong to box instances; an instance whose superbox is labelled c2pa is a C2PA manifest store.
  const c2paInstances = new Set<number>();
  for (const b of blocks) if (b.kind === "jumbf" && looksLikeC2pa(b.payload)) c2paInstances.add(b.info.instance as number);
  const final = blocks.map((b) => (b.kind === "jumbf" && c2paInstances.has(b.info.instance as number) ? { ...b, kind: "c2pa" as const } : b));
  return { format: "jpeg", mimeType: "image/jpeg", blocks: final, size: bytes.length };
}

function segment(marker: number, header: Uint8Array, payload: Uint8Array): Uint8Array {
  const bodyLength = header.length + payload.length;
  if (bodyLength > MAX_SEGMENT_PAYLOAD) {
    throw new ImgwandError(
      "SEGMENT_TOO_LARGE",
      `${markerName(marker)} payload is ${bodyLength} bytes; a JPEG segment holds at most ${MAX_SEGMENT_PAYLOAD}`,
    );
  }
  const out = new Uint8Array(4 + bodyLength);
  out[0] = 0xff;
  out[1] = marker;
  writeU16BE(out, 2, bodyLength + 2);
  out.set(header, 4);
  out.set(payload, 4 + header.length);
  return out;
}

/** Re-wraps a replacement payload with the same marker and header the original block had. */
function rewrap(block: Block, payload: Uint8Array): Uint8Array {
  const marker = block.info.marker as number;
  const headerLength = block.info.headerLength as number;
  const payloadStart = block.payload.byteOffset - block.raw.byteOffset;
  return segment(marker, block.raw.subarray(payloadStart - headerLength, payloadStart), payload);
}

function insertSegment(insert: BlockInsert): Uint8Array {
  switch (insert.kind) {
    case "exif":
      return segment(APP1, EXIF_HEADER, insert.payload);
    case "xmp":
      return segment(APP1, XMP_HEADER, insert.payload);
    case "iptc":
      return segment(APP13, PHOTOSHOP_HEADER, insert.payload);
    case "comment":
      return segment(COM, new Uint8Array(0), insert.payload);
  }
}

/**
 * Multi-picture files (MPF) store the offsets of secondary images relative to the MPF segment's TIFF header.
 * When edits change the distance between that header and the trailer, the offsets must move by the same amount.
 */
function patchMpf(payload: Uint8Array, delta: number): Uint8Array {
  const out = copyBytes(payload);
  if (out.length < 8) return out;
  const little = out[0] === 0x49;
  const e = new Endian(out, little);
  try {
    const ifd = e.u32(4);
    const count = e.u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (e.u16(entry) !== 0xb002) continue; // MPEntry
      const n = e.u32(entry + 4) / 16;
      const data = e.u32(entry + 8);
      for (let k = 0; k < n; k++) {
        const offsetField = data + k * 16 + 8;
        const value = e.u32(offsetField);
        if (value !== 0) e.setU32(offsetField, value + delta);
      }
    }
  } catch {
    return copyBytes(payload); // malformed MPF: leave it exactly as it was
  }
  return out;
}

export function rebuildJpeg(container: Container, edits: readonly BlockEdit[], inserts: readonly BlockInsert[] = []): Uint8Array {
  const byId = new Map(edits.map((e) => [e.id, e]));
  const out: Uint8Array[] = [];
  // Where new segments go: Exif right after SOI/APP0 (JFIF must stay first), XMP and comments after the existing APPn run.
  const blocks = container.blocks;
  let afterApp0 = 1;
  if (blocks[1]?.name === "APP0") afterApp0 = 2;
  let afterAppRun = afterApp0;
  while (afterAppRun < blocks.length && (blocks[afterAppRun]!.name.startsWith("APP") || blocks[afterAppRun]!.name === "COM")) afterAppRun++;

  const exifInserts = inserts.filter((i) => i.kind === "exif").map(insertSegment);
  const laterInserts = inserts.filter((i) => i.kind !== "exif").map(insertSegment);

  let mpfIndex = -1;
  let trailerIndex = -1;
  const positions: number[] = [];
  let size = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i === afterApp0) for (const s of exifInserts) (out.push(s), (size += s.length));
    if (i === afterAppRun) for (const s of laterInserts) (out.push(s), (size += s.length));
    const block = blocks[i]!;
    const edit = byId.get(block.id);
    positions[i] = size;
    if (edit?.action === "remove") {
      if (block.kind === "structure" || block.kind === "mpf") {
        throw new ImgwandError("NOT_REMOVABLE", `${block.name} is part of the picture and cannot be removed`);
      }
      continue;
    }
    const bytes = edit?.action === "replace" ? rewrap(block, edit.payload) : block.raw;
    if (block.kind === "mpf") mpfIndex = out.length;
    if (block.name === "trailer") trailerIndex = i;
    out.push(bytes);
    size += bytes.length;
  }
  if (afterAppRun >= blocks.length) for (const s of laterInserts) out.push(s);

  if (mpfIndex >= 0 && trailerIndex >= 0) {
    const mpfBlock = blocks.find((b) => b.kind === "mpf")!;
    const oldDistance = blocks[trailerIndex]!.offset - (mpfBlock.offset + 8);
    const mpfPos = positions[mpfBlock.id]!;
    const newDistance = positions[trailerIndex]! - (mpfPos + 8);
    const delta = newDistance - oldDistance;
    if (delta !== 0) out[mpfIndex] = rewrap(mpfBlock, patchMpf(mpfBlock.payload, delta));
  }
  return concatBytes(out);
}

export const jpegCodec: ContainerCodec = {
  format: "jpeg",
  mimeType: "image/jpeg",
  matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  parse: parseJpeg,
  rebuild: rebuildJpeg,
};
