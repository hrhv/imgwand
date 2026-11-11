import { deflateSync, inflateSync } from "node:zlib";
import { ImgwandError } from "../errors.js";
import { asUint8Array, asciiBytes, concatBytes, latin1, readU32BE, utf8, writeU32BE, decodeText } from "../util/bytes.js";
import { crc32 } from "../util/crc32.js";
import type { Block, BlockEdit, BlockInsert, BlockKind, Container, ContainerCodec } from "./types.js";

/**
 * PNG: an 8-byte signature followed by length/type/data/CRC chunks. Metadata lives in ancillary chunks (eXIf,
 * iTXt/tEXt/zTXt, iCCP, tIME, caBX) that can be dropped or rewritten without touching IHDR/PLTE/IDAT.
 */

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
export const XMP_KEYWORD = "XML:com.adobe.xmp";
/**
 * Upper bound for one decompressed text/profile chunk; protects against decompression bombs. Real metadata is far
 * smaller (large ICC profiles are a few MB, XMP rarely more than a few hundred KB).
 */
const MAX_INFLATE = 16 * 1024 * 1024;
/** Upper bound for everything decompressed while parsing one file (many small bombs add up). */
const MAX_INFLATE_TOTAL = 32 * 1024 * 1024;

const STRUCTURE = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "cICP", "mDCV", "cLLI", "sBIT", "bKGD", "pHYs", "hIST", "sPLT",
  "acTL", "fcTL", "fdAT",
]);

export function inflateLimited(data: Uint8Array, limit = MAX_INFLATE): Uint8Array {
  try {
    return asUint8Array(inflateSync(data, { maxOutputLength: Math.max(1, limit) }));
  } catch (error) {
    throw new ImgwandError("CORRUPT_FILE", `Could not decompress PNG chunk data: ${(error as Error).message}`, { cause: error });
  }
}

interface TextChunk {
  keyword: string;
  text: string;
  compressed: boolean;
  language?: string;
  translated?: string;
}

/** Decodes tEXt, zTXt and iTXt chunk data. */
export function decodeTextChunk(type: string, data: Uint8Array, limit = MAX_INFLATE): TextChunk {
  const nul = data.indexOf(0);
  if (nul < 0) throw new ImgwandError("CORRUPT_FILE", `Corrupt PNG ${type} chunk: missing keyword terminator`);
  const keyword = latin1(data, 0, nul);
  if (type === "tEXt") return { keyword, text: latin1(data, nul + 1), compressed: false };
  if (type === "zTXt") return { keyword, text: latin1(inflateLimited(data.subarray(nul + 2), limit)), compressed: true };
  // iTXt: keyword \0 compressionFlag compressionMethod language \0 translatedKeyword \0 text
  const flag = data[nul + 1];
  const langEnd = data.indexOf(0, nul + 3);
  const transEnd = langEnd < 0 ? -1 : data.indexOf(0, langEnd + 1);
  if (flag === undefined || langEnd < 0 || transEnd < 0) throw new ImgwandError("CORRUPT_FILE", "Corrupt PNG iTXt chunk");
  const language = latin1(data, nul + 3, langEnd);
  const translated = decodeText(data.subarray(langEnd + 1, transEnd));
  const body = data.subarray(transEnd + 1);
  const text = decodeText(flag === 1 ? inflateLimited(body, limit) : body);
  return { keyword, text, compressed: flag === 1, language, translated };
}

function encodeITXt(keyword: string, text: string, language = "", translated = ""): Uint8Array {
  return concatBytes([asciiBytes(keyword), Uint8Array.of(0, 0, 0), asciiBytes(language), Uint8Array.of(0), utf8(translated), Uint8Array.of(0), utf8(text)]);
}

/** Re-encodes a text chunk with new text, keeping its type when the text still fits that type. */
function encodeTextChunk(type: string, keyword: string, text: string, language = "", translated = ""): { type: string; data: Uint8Array } {
  const latin1Safe = /^[\u0000-ÿ]*$/.test(text);
  if (type === "tEXt" && latin1Safe) return { type, data: concatBytes([asciiBytes(keyword), Uint8Array.of(0), asciiBytes(text)]) };
  if (type === "zTXt" && latin1Safe) {
    return { type, data: concatBytes([asciiBytes(keyword), Uint8Array.of(0, 0), deflateSync(asciiBytes(text))]) };
  }
  return { type: "iTXt", data: encodeITXt(keyword, text, language, translated) };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiBytes(type);
  const out = new Uint8Array(12 + data.length);
  writeU32BE(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  writeU32BE(out, 8 + data.length, crc32(typeBytes, data));
  return out;
}

export function parsePng(input: Uint8Array): Container {
  const bytes = asUint8Array(input);
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new ImgwandError("CORRUPT_FILE", "Not a PNG file (bad signature)");
  }
  const blocks: Block[] = [];
  blocks.push({ id: 0, kind: "structure", name: "signature", offset: 0, raw: bytes.subarray(0, 8), payload: bytes.subarray(0, 8), info: {} });
  let pos = 8;
  let inflated = 0;
  while (pos < bytes.length) {
    if (pos + 12 > bytes.length) throw new ImgwandError("CORRUPT_FILE", `Corrupt PNG: truncated chunk at byte ${pos}`);
    const length = readU32BE(bytes, pos);
    const type = latin1(bytes, pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > bytes.length) {
      throw new ImgwandError("CORRUPT_FILE", `Corrupt PNG: chunk at byte ${pos} is invalid or runs past the end of the file`);
    }
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    const crcOk = crc32(bytes.subarray(pos + 4, pos + 8), data) === readU32BE(bytes, pos + 8 + length);
    let kind: BlockKind = "other";
    let payload: Uint8Array = data;
    const info: Record<string, string | number | boolean> = { type, crcOk };
    if (STRUCTURE.has(type) || (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90)) {
      kind = "structure";
    } else if (type === "eXIf") {
      kind = "exif";
      // A few writers prefix the TIFF data with the JPEG "Exif\0\0" header.
      if (latin1(data, 0, 6) === "Exif\0\0") payload = data.subarray(6);
    } else if (type === "iCCP") {
      kind = "icc";
      const nul = data.indexOf(0);
      info.profileName = latin1(data, 0, Math.max(0, nul));
      try {
        payload = nul >= 0 ? inflateLimited(data.subarray(nul + 2), Math.min(MAX_INFLATE, MAX_INFLATE_TOTAL - inflated)) : new Uint8Array(0);
        inflated += payload.length;
      } catch {
        // A broken profile is still a removable ICC block; its fields report it as unreadable.
        payload = new Uint8Array(0);
        info.corrupt = true;
      }
    } else if (type === "caBX") {
      kind = "c2pa";
    } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      try {
        const text = decodeTextChunk(type, data, Math.min(MAX_INFLATE, MAX_INFLATE_TOTAL - inflated));
        if (text.compressed) inflated += text.text.length;
        info.keyword = text.keyword;
        if (text.language) info.language = text.language;
        if (text.translated) info.translated = text.translated;
        kind = type === "iTXt" && text.keyword === XMP_KEYWORD ? "xmp" : "text";
        payload = utf8(text.text);
      } catch {
        // Undecodable text: listed (and removable) as an opaque chunk instead of making the whole file unreadable.
        kind = "other";
        info.corrupt = true;
      }
    }
    blocks.push({ id: blocks.length, kind, name: type, offset: pos, raw: bytes.subarray(pos, end), payload, info });
    pos = end;
    if (type === "IEND") break;
  }
  if (pos < bytes.length) {
    blocks.push({ id: blocks.length, kind: "structure", name: "trailer", offset: pos, raw: bytes.subarray(pos), payload: bytes.subarray(pos), info: {} });
  }
  return { format: "png", mimeType: "image/png", blocks, size: bytes.length };
}

function replacement(block: Block, payload: Uint8Array): Uint8Array {
  switch (block.kind) {
    case "exif":
      return chunk("eXIf", payload);
    case "xmp":
      return chunk("iTXt", encodeITXt(XMP_KEYWORD, decodeText(payload), String(block.info.language ?? ""), String(block.info.translated ?? "")));
    case "text": {
      const encoded = encodeTextChunk(block.name, String(block.info.keyword), decodeText(payload), String(block.info.language ?? ""), String(block.info.translated ?? ""));
      return chunk(encoded.type, encoded.data);
    }
    default:
      throw new ImgwandError("NOT_WRITABLE", `PNG ${block.name} chunks cannot be rewritten`);
  }
}

function insertion(insert: BlockInsert): Uint8Array {
  switch (insert.kind) {
    case "exif":
      return chunk("eXIf", insert.payload);
    case "xmp":
      return chunk("iTXt", encodeITXt(XMP_KEYWORD, decodeText(insert.payload)));
    case "comment":
      return chunk("tEXt", concatBytes([asciiBytes("Comment"), Uint8Array.of(0), insert.payload]));
    case "iptc":
      throw new ImgwandError("NOT_WRITABLE", "PNG has no standard IPTC block; use XMP (Iptc4xmpCore) instead");
  }
}

export function rebuildPng(container: Container, edits: readonly BlockEdit[], inserts: readonly BlockInsert[] = []): Uint8Array {
  const byId = new Map(edits.map((e) => [e.id, e]));
  const out: Uint8Array[] = [];
  // New metadata goes before the image data, where every reader looks for it: before Apple's iDOT chunk (which
  // records IDAT offsets and must stay next to them) when there is one, otherwise before the first IDAT.
  const firstIdat = container.blocks.findIndex((b) => b.name === "iDOT" || b.name === "IDAT");
  if (inserts.length > 0 && firstIdat < 0) throw new ImgwandError("CORRUPT_FILE", "PNG has no image data (IDAT); cannot add metadata");
  for (let i = 0; i < container.blocks.length; i++) {
    const block = container.blocks[i]!;
    if (i === firstIdat) for (const insert of inserts) out.push(insertion(insert));
    const edit = byId.get(block.id);
    if (edit?.action === "remove") {
      if (block.kind === "structure") throw new ImgwandError("NOT_REMOVABLE", `PNG ${block.name} is part of the picture and cannot be removed`);
      continue;
    }
    out.push(edit?.action === "replace" ? replacement(block, edit.payload) : block.raw);
  }
  return concatBytes(out);
}

export const pngCodec: ContainerCodec = {
  format: "png",
  mimeType: "image/png",
  matches: (bytes) => bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b),
  parse: parsePng,
  rebuild: rebuildPng,
};
