import { ImgwandError } from "../errors.js";
import { bytesEqual, latin1 } from "../util/bytes.js";
import { jpegCodec } from "./jpeg.js";
import { pngCodec } from "./png.js";
import type { Container, ContainerCodec, ImageFormat } from "./types.js";
import { webpCodec } from "./webp.js";

export * from "./types.js";

export const CODECS: readonly ContainerCodec[] = [jpegCodec, pngCodec, webpCodec];

/** Formats that are recognized but cannot be edited losslessly yet, for a precise error message. */
function sniffUnsupported(bytes: Uint8Array): string | undefined {
  const tag = latin1(bytes, 4, 12);
  if (tag.startsWith("ftyp")) {
    const brand = latin1(bytes, 8, 12);
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "HEIC/HEIF";
    if (/^(avif|avis)$/.test(brand)) return "AVIF";
    return "ISO-BMFF (MP4/MOV/HEIF)";
  }
  const head = latin1(bytes, 0, 4);
  if (head === "II*\0" || head === "MM\0*") return "TIFF/DNG";
  if (head.startsWith("GIF8")) return "GIF";
  if (head.startsWith("BM")) return "BMP";
  return undefined;
}

export function detectFormat(bytes: Uint8Array): ImageFormat {
  const codec = CODECS.find((c) => c.matches(bytes));
  if (codec) return codec.format;
  const known = sniffUnsupported(bytes);
  throw new ImgwandError(
    "UNSUPPORTED_FORMAT",
    known ? `${known} files are not supported yet (supported: JPEG, PNG, WebP)` : "Unrecognized file format (supported: JPEG, PNG, WebP)",
  );
}

export function codecFor(format: ImageFormat): ContainerCodec {
  const codec = CODECS.find((c) => c.format === format);
  if (!codec) throw new ImgwandError("UNSUPPORTED_FORMAT", `Unsupported format: ${format}`);
  return codec;
}

export function parseContainer(bytes: Uint8Array): Container {
  return codecFor(detectFormat(bytes)).parse(bytes);
}

/**
 * Checks that every block holding the picture survived an edit unchanged. This is what makes edits lossless:
 * metadata blocks may disappear or change, picture blocks may not. (WebP's VP8X flags and JPEG MPF offsets are
 * bookkeeping that edits are expected to update, so they are compared structurally instead.)
 */
export function samePicture(before: Container, after: Container): boolean {
  const picture = (c: Container) => c.blocks.filter((b) => b.kind === "structure" && b.name !== "VP8X" && b.name !== "RIFF");
  const a = picture(before);
  const b = picture(after);
  if (a.length !== b.length) return false;
  // WebP chunks are compared by their data: a missing RIFF pad byte may legitimately be added by an edit.
  const bytesOf = (c: Container, block: Container["blocks"][number]) => (c.format === "webp" ? block.payload : block.raw);
  return a.every((block, i) => block.name === b[i]!.name && bytesEqual(bytesOf(before, block), bytesOf(after, b[i]!)));
}
