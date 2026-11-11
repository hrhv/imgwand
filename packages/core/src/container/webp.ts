import { ImgwandError } from "../errors.js";
import { asUint8Array, asciiBytes, concatBytes, copyBytes, latin1, readU32LE, writeU32LE } from "../util/bytes.js";
import type { Block, BlockEdit, BlockInsert, BlockKind, Container, ContainerCodec } from "./types.js";

/**
 * WebP: a RIFF container. Metadata chunks (ICCP, EXIF, "XMP ", C2PA) sit next to the bitstream chunks and are
 * announced by flag bits in the VP8X chunk, which is kept in sync when chunks are removed or added.
 */

const FLAG_ICC = 0x20;
const FLAG_ALPHA = 0x10;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;

const STRUCTURE = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const padded = data.length + (data.length & 1);
  const out = new Uint8Array(8 + padded);
  out.set(asciiBytes(fourcc), 0);
  writeU32LE(out, 4, data.length);
  out.set(data, 8);
  return out;
}

export function parseWebp(input: Uint8Array): Container {
  const bytes = asUint8Array(input);
  if (bytes.length < 12 || latin1(bytes, 0, 4) !== "RIFF" || latin1(bytes, 8, 12) !== "WEBP") {
    throw new ImgwandError("CORRUPT_FILE", "Not a WebP file (bad RIFF header)");
  }
  const riffEnd = Math.min(bytes.length, 8 + readU32LE(bytes, 4));
  const blocks: Block[] = [{ id: 0, kind: "structure", name: "RIFF", offset: 0, raw: bytes.subarray(0, 12), payload: bytes.subarray(0, 12), info: {} }];
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const fourcc = latin1(bytes, pos, pos + 4);
    const size = readU32LE(bytes, pos + 4);
    const dataEnd = pos + 8 + size;
    const end = dataEnd + (size & 1);
    if (dataEnd > riffEnd) throw new ImgwandError("CORRUPT_FILE", `Corrupt WebP: ${fourcc} chunk at byte ${pos} runs past the end of the file`);
    const data = bytes.subarray(pos + 8, dataEnd);
    let kind: BlockKind = "other";
    let payload: Uint8Array = data;
    if (STRUCTURE.has(fourcc)) kind = "structure";
    else if (fourcc === "ICCP") kind = "icc";
    else if (fourcc === "EXIF") {
      kind = "exif";
      if (latin1(data, 0, 6) === "Exif\0\0") payload = data.subarray(6);
    } else if (fourcc === "XMP ") kind = "xmp";
    else if (fourcc === "C2PA") kind = "c2pa";
    blocks.push({ id: blocks.length, kind, name: fourcc, offset: pos, raw: bytes.subarray(pos, Math.min(end, riffEnd)), payload, info: { fourcc } });
    pos = Math.min(end, riffEnd);
  }
  if (pos < bytes.length) {
    blocks.push({ id: blocks.length, kind: "structure", name: "trailer", offset: pos, raw: bytes.subarray(pos), payload: bytes.subarray(pos), info: {} });
  }
  return { format: "webp", mimeType: "image/webp", blocks, size: bytes.length };
}

/** Canvas size and alpha of a simple (non-VP8X) WebP, needed to synthesize a VP8X chunk. */
function bitstreamInfo(blocks: readonly Block[]): { width: number; height: number; alpha: boolean } {
  const vp8l = blocks.find((b) => b.name === "VP8L");
  if (vp8l) {
    const d = vp8l.payload;
    if (d[0] !== 0x2f || d.length < 5) throw new ImgwandError("CORRUPT_FILE", "Corrupt WebP: bad VP8L header");
    const bits = d[1]! | (d[2]! << 8) | (d[3]! << 16) | (d[4]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1 };
  }
  const vp8 = blocks.find((b) => b.name === "VP8 ");
  if (vp8 && vp8.payload.length >= 10) {
    const d = vp8.payload;
    return { width: (d[6]! | (d[7]! << 8)) & 0x3fff, height: (d[8]! | (d[9]! << 8)) & 0x3fff, alpha: false };
  }
  throw new ImgwandError("CORRUPT_FILE", "Corrupt WebP: no image bitstream");
}

function makeVp8x(width: number, height: number, flags: number): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = flags;
  const w = width - 1;
  const h = height - 1;
  data[4] = w & 0xff;
  data[5] = (w >>> 8) & 0xff;
  data[6] = (w >>> 16) & 0xff;
  data[7] = h & 0xff;
  data[8] = (h >>> 8) & 0xff;
  data[9] = (h >>> 16) & 0xff;
  return riffChunk("VP8X", data);
}

export function rebuildWebp(container: Container, edits: readonly BlockEdit[], inserts: readonly BlockInsert[] = []): Uint8Array {
  const byId = new Map(edits.map((e) => [e.id, e]));
  const chunks: { kind: BlockKind; name: string; bytes: Uint8Array }[] = [];
  for (const block of container.blocks.slice(1)) {
    if (block.name === "trailer") continue;
    const edit = byId.get(block.id);
    if (edit?.action === "remove") {
      if (block.kind === "structure") throw new ImgwandError("NOT_REMOVABLE", `WebP ${block.name} is part of the picture and cannot be removed`);
      continue;
    }
    if (edit?.action === "replace") {
      if (block.kind !== "exif" && block.kind !== "xmp") throw new ImgwandError("NOT_WRITABLE", `WebP ${block.name} chunks cannot be rewritten`);
      chunks.push({ kind: block.kind, name: block.name, bytes: riffChunk(block.name, edit.payload) });
    } else {
      // RIFF chunks are padded to an even length; a final chunk stored without its pad byte gets one, or anything
      // appended after it would start at an odd offset.
      const raw = block.raw.length & 1 ? concatBytes([block.raw, new Uint8Array(1)]) : block.raw;
      chunks.push({ kind: block.kind, name: block.name, bytes: raw });
    }
  }
  for (const insert of [...inserts].sort((a, b) => (a.kind === "exif" ? -1 : b.kind === "exif" ? 1 : 0))) {
    if (insert.kind === "comment") throw new ImgwandError("NOT_WRITABLE", "WebP has no comment chunk");
    if (insert.kind === "iptc") throw new ImgwandError("NOT_WRITABLE", "WebP has no IPTC chunk; use XMP (Iptc4xmpCore) instead");
    const name = insert.kind === "exif" ? "EXIF" : "XMP ";
    chunks.push({ kind: insert.kind, name, bytes: riffChunk(name, insert.payload) });
  }

  const has = (kind: BlockKind) => chunks.some((c) => c.kind === kind);
  const vp8xIndex = chunks.findIndex((c) => c.name === "VP8X");
  const needsVp8x = has("icc") || has("exif") || has("xmp") || has("c2pa");
  const setFlags = (flags: number) =>
    (flags & ~(FLAG_ICC | FLAG_EXIF | FLAG_XMP)) | (has("icc") ? FLAG_ICC : 0) | (has("exif") ? FLAG_EXIF : 0) | (has("xmp") ? FLAG_XMP : 0);
  if (vp8xIndex >= 0) {
    const vp8x = copyBytes(chunks[vp8xIndex]!.bytes);
    vp8x[8] = setFlags(vp8x[8]!);
    chunks[vp8xIndex] = { ...chunks[vp8xIndex]!, bytes: vp8x };
  } else if (needsVp8x) {
    const { width, height, alpha } = bitstreamInfo(container.blocks);
    chunks.unshift({ kind: "structure", name: "VP8X", bytes: makeVp8x(width, height, setFlags(alpha ? FLAG_ALPHA : 0)) });
  }

  const body = concatBytes(chunks.map((c) => c.bytes));
  const header = new Uint8Array(12);
  header.set(asciiBytes("RIFF"), 0);
  writeU32LE(header, 4, body.length + 4);
  header.set(asciiBytes("WEBP"), 8);
  const trailer = container.blocks.find((b) => b.name === "trailer");
  return concatBytes(trailer ? [header, body, trailer.raw] : [header, body]);
}

export const webpCodec: ContainerCodec = {
  format: "webp",
  mimeType: "image/webp",
  matches: (bytes) => bytes.length >= 12 && latin1(bytes, 0, 4) === "RIFF" && latin1(bytes, 8, 12) === "WEBP",
  parse: parseWebp,
  rebuild: rebuildWebp,
};
