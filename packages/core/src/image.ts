import { ImgwandError } from "./errors.js";
import { inflateLimited } from "./container/png.js";
import { parsePng } from "./container/png.js";
import { readU32BE } from "./util/bytes.js";

/**
 * Pixel-level helpers built on sharp (libvips): image facts, scaled renditions for terminal previews, palette
 * quantization for sixel output, and a decoded-pixel comparison used to prove edits are lossless.
 *
 * sharp is imported lazily so that metadata-only users never load the native addon.
 */

type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp> | undefined;
async function loadSharp(): Promise<Sharp> {
  sharpModule ??= import("sharp").then((m) => m.default);
  return sharpModule;
}

/** Refuse absurd dimensions before decoding (sharp's default limit is ~268 megapixels). */
const LIMIT_INPUT_PIXELS = 268_402_689;

export interface ImageInfo {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  /** Width/height after applying EXIF orientation. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly space?: string;
  readonly channels?: number;
  readonly depth?: string;
  readonly density?: number;
  readonly hasAlpha?: boolean;
  readonly hasProfile?: boolean;
  readonly orientation?: number;
  readonly isProgressive?: boolean;
  readonly pages?: number;
  readonly chromaSubsampling?: string;
}

export async function imageInfo(bytes: Uint8Array): Promise<ImageInfo> {
  const sharp = await loadSharp();
  try {
    const m = await sharp(bytes, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
    const rotated = (m.orientation ?? 1) >= 5;
    return {
      format: m.format ?? "unknown",
      width: m.width ?? 0,
      height: m.height ?? 0,
      displayWidth: (rotated ? m.height : m.width) ?? 0,
      displayHeight: (rotated ? m.width : m.height) ?? 0,
      space: m.space,
      channels: m.channels,
      depth: m.depth,
      density: m.density,
      hasAlpha: m.hasAlpha,
      hasProfile: m.hasProfile,
      orientation: m.orientation,
      isProgressive: m.isProgressive,
      pages: m.pages,
      chromaSubsampling: m.chromaSubsampling,
    };
  } catch (error) {
    throw new ImgwandError("CORRUPT_FILE", `Could not decode the image: ${(error as Error).message}`, { cause: error });
  }
}

export interface RenderOptions {
  /** Bounding box in pixels; the image is scaled to fit inside it, keeping its aspect ratio. */
  readonly width: number;
  readonly height: number;
  /** Composite transparent images over this color (default: keep alpha). */
  readonly background?: string;
  /** Never upscale beyond the original size (default true). */
  readonly withoutEnlargement?: boolean;
}

export interface Raster {
  /** RGBA, row-major. */
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

function pipeline(sharp: Sharp, bytes: Uint8Array, options: RenderOptions) {
  let p = sharp(bytes, { limitInputPixels: LIMIT_INPUT_PIXELS, animated: false })
    .rotate() // apply EXIF orientation
    .resize({ width: Math.max(1, Math.floor(options.width)), height: Math.max(1, Math.floor(options.height)), fit: "inside", withoutEnlargement: options.withoutEnlargement ?? true });
  if (options.background) p = p.flatten({ background: options.background });
  return p;
}

/** Decodes and scales an image to RGBA pixels. */
export async function renderRaster(bytes: Uint8Array, options: RenderOptions): Promise<Raster> {
  const sharp = await loadSharp();
  try {
    const { data, info } = await pipeline(sharp, bytes, options).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
  } catch (error) {
    throw new ImgwandError("CORRUPT_FILE", `Could not render the image: ${(error as Error).message}`, { cause: error });
  }
}

/** Scales an image and encodes it as PNG (for terminal graphics protocols that take PNG). */
export async function renderPng(bytes: Uint8Array, options: RenderOptions): Promise<{ png: Uint8Array; width: number; height: number }> {
  const sharp = await loadSharp();
  try {
    const { data, info } = await pipeline(sharp, bytes, options).png({ compressionLevel: 3 }).toBuffer({ resolveWithObject: true });
    return { png: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
  } catch (error) {
    throw new ImgwandError("CORRUPT_FILE", `Could not render the image: ${(error as Error).message}`, { cause: error });
  }
}

export interface PalettedRaster {
  readonly width: number;
  readonly height: number;
  /** One palette index per pixel. */
  readonly indices: Uint8Array;
  /** RGB triples. */
  readonly palette: Uint8Array;
}

/** Undoes PNG scanline filters for indexed data (1 byte per filter unit) and unpacks 1/2/4/8-bit indices. */
function unfilter(data: Uint8Array, width: number, height: number, bitDepth: number): Uint8Array {
  const stride = Math.ceil((width * bitDepth) / 8);
  const rows = new Uint8Array(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[src++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[src++] ?? 0;
      const a = x > 0 ? rows[row + x - 1]! : 0;
      const b = y > 0 ? rows[prev + x]! : 0;
      const c = x > 0 && y > 0 ? rows[prev + x - 1]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new ImgwandError("CORRUPT_FILE", `Unknown PNG filter ${filter}`);
      }
      rows[row + x] = v & 0xff;
    }
  }
  if (bitDepth === 8) return rows;
  const out = new Uint8Array(width * height);
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = rows[y * stride + Math.floor(x / perByte)]!;
      const shift = 8 - bitDepth * ((x % perByte) + 1);
      out[y * width + x] = (byte >> shift) & mask;
    }
  }
  return out;
}

/**
 * Scales and quantizes an image to at most `colors` colors (libimagequant via sharp, with dithering): the input
 * sixel encoding needs. Transparent pixels are composited over `background`.
 */
export async function renderPaletted(bytes: Uint8Array, options: RenderOptions & { readonly colors?: number }): Promise<PalettedRaster> {
  const sharp = await loadSharp();
  const colors = Math.min(256, Math.max(2, options.colors ?? 256));
  let png: Buffer;
  try {
    png = await pipeline(sharp, bytes, { ...options, background: options.background ?? "#000000" })
      .png({ palette: true, colours: colors, dither: 1, compressionLevel: 0, effort: 1 })
      .toBuffer();
  } catch (error) {
    throw new ImgwandError("CORRUPT_FILE", `Could not render the image: ${(error as Error).message}`, { cause: error });
  }
  const container = parsePng(png);
  const ihdr = container.blocks.find((b) => b.name === "IHDR")!.payload;
  const width = readU32BE(ihdr, 0);
  const height = readU32BE(ihdr, 4);
  const bitDepth = ihdr[8]!;
  if (![1, 2, 4, 8].includes(bitDepth) || ihdr[9] !== 3 || ihdr[12] !== 0) throw new ImgwandError("CORRUPT_FILE", "Unexpected PNG layout from the quantizer");
  const palette = new Uint8Array(container.blocks.find((b) => b.name === "PLTE")!.payload);
  const idat = container.blocks.filter((b) => b.name === "IDAT").map((b) => b.payload);
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let at = 0;
  for (const d of idat) (joined.set(d, at), (at += d.length));
  return { width, height, indices: unfilter(inflateLimited(joined), width, height, bitDepth), palette };
}

/** True when two files decode to exactly the same pixels (used to prove metadata edits are lossless). */
export async function samePixels(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const sharp = await loadSharp();
  // Decode the stored samples as they are: no ICC conversion (profiles may be what was removed) and no rotation.
  const decode = (bytes: Uint8Array) => sharp(bytes, { limitInputPixels: LIMIT_INPUT_PIXELS, ignoreIcc: true }).raw().toBuffer({ resolveWithObject: true });
  let x: Awaited<ReturnType<typeof decode>>, y: Awaited<ReturnType<typeof decode>>;
  try {
    [x, y] = await Promise.all([decode(a), decode(b)]);
  } catch (error) {
    throw new ImgwandError("CORRUPT_FILE", `Could not decode the image: ${(error as Error).message}`, { cause: error });
  }
  return x.info.width === y.info.width && x.info.height === y.info.height && x.info.channels === y.info.channels && Buffer.compare(x.data, y.data) === 0;
}
