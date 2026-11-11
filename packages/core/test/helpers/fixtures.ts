import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import sharp from "sharp";

/**
 * Test images built from first principles (independently of the code under test where it matters): TIFF/EXIF is
 * assembled byte by byte, segments and chunks are framed by hand, and the pictures come from sharp.
 */

export const CERT_DIR = fileURLToPath(new URL("../fixtures/certs/", import.meta.url));
export const testSigner = (alg: "es256" | "ps256" | "ed25519" = "es256") => ({
  certificate: readFileSync(`${CERT_DIR}${alg}.pub`),
  privateKey: readFileSync(`${CERT_DIR}${alg}.pem`),
  algorithm: alg,
});

// --- pictures ----------------------------------------------------------------------------------------------------

const SCENE = (w: number, h: number) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 640 400">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2a6b"/><stop offset="0.45" stop-color="#c2477a"/><stop offset="0.75" stop-color="#ff9f43"/><stop offset="1" stop-color="#ffd27a"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff6c2"/><stop offset="1" stop-color="#ffb347"/></radialGradient>
  </defs>
  <rect width="640" height="400" fill="url(#sky)"/>
  <circle cx="420" cy="250" r="70" fill="url(#sun)"/>
  <path d="M0 300 L90 210 L170 280 L260 170 L360 290 L450 220 L540 280 L640 200 L640 400 L0 400 Z" fill="#2d1b3d"/>
  <path d="M0 340 L120 270 L230 330 L330 260 L470 340 L560 300 L640 330 L640 400 L0 400 Z" fill="#160d22"/>
  <rect y="360" width="640" height="40" fill="#0c0714"/>
</svg>`;

/** A small sunset scene (looks like a photo in previews, compresses well). */
export function scene(width = 320, height = 200): ReturnType<typeof sharp> {
  return sharp(Buffer.from(SCENE(width, height)));
}

export async function plainJpeg(width = 64, height = 48): Promise<Uint8Array> {
  return new Uint8Array(await scene(width, height).jpeg({ quality: 85 }).toBuffer());
}

// --- TIFF / EXIF builder -------------------------------------------------------------------------------------------

type Value = { type: number; data: number[] | string | Uint8Array };
interface Entry {
  tag: number;
  value: Value;
}

const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };

export const ascii = (s: string): Value => ({ type: 2, data: `${s}\0` });
export const short = (...n: number[]): Value => ({ type: 3, data: n });
export const long = (...n: number[]): Value => ({ type: 4, data: n });
export const rational = (...pairs: [number, number][]): Value => ({ type: 5, data: pairs.flat() });
export const undef = (bytes: Uint8Array | string): Value => ({ type: 7, data: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes });
export const byte = (...n: number[]): Value => ({ type: 1, data: n });

/**
 * Builds a TIFF structure with IFD0, an Exif IFD (with Interop), a GPS IFD and an optional IFD1 thumbnail.
 * Layout: header | IFD0 | ExifIFD | InteropIFD | GPS | IFD1 | values | thumbnail | MakerNote.
 * The MakerNote contains an absolute offset (to its own payload) like Canon/Nikon notes do.
 */
export function buildTiff(options: {
  littleEndian?: boolean;
  ifd0: Entry[];
  exif?: Entry[];
  interop?: Entry[];
  gps?: Entry[];
  ifd1?: Entry[];
  thumbnail?: Uint8Array;
  makerNote?: boolean;
}): Uint8Array {
  const le = options.littleEndian ?? true;
  const buf = new Uint8Array(64 * 1024);
  const view = new DataView(buf.buffer);
  const u16 = (o: number, v: number) => view.setUint16(o, v, le);
  const u32 = (o: number, v: number) => view.setUint32(o, v, le);
  buf.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  u16(2, 42);
  u32(4, 8);

  const ifds: { name: string; entries: Entry[] }[] = [{ name: "IFD0", entries: [...options.ifd0] }];
  if (options.exif) ifds.push({ name: "Exif", entries: [...options.exif] });
  if (options.interop) ifds.push({ name: "Interop", entries: [...options.interop] });
  if (options.gps) ifds.push({ name: "GPS", entries: [...options.gps] });
  if (options.ifd1) ifds.push({ name: "IFD1", entries: [...options.ifd1] });
  // Pointer entries (values patched once offsets are known).
  if (options.exif) ifds[0]!.entries.push({ tag: 0x8769, value: long(0) });
  if (options.gps) ifds[0]!.entries.push({ tag: 0x8825, value: long(0) });
  if (options.interop) ifds.find((i) => i.name === "Exif")!.entries.push({ tag: 0xa005, value: long(0) });
  if (options.makerNote) ifds.find((i) => i.name === "Exif")!.entries.push({ tag: 0x927c, value: undef(new Uint8Array(32)) });
  if (options.ifd1 && options.thumbnail) ifds.find((i) => i.name === "IFD1")!.entries.push({ tag: 0x0201, value: long(0) }, { tag: 0x0202, value: long(options.thumbnail.length) });
  for (const ifd of ifds) ifd.entries.sort((a, b) => a.tag - b.tag);

  let pos = 8;
  const offsets: Record<string, number> = {};
  for (const ifd of ifds) {
    offsets[ifd.name] = pos;
    pos += 2 + ifd.entries.length * 12 + 4;
  }
  let valuePos = pos;
  const entryAt: Record<string, number> = {};
  for (const ifd of ifds) {
    let p = offsets[ifd.name]!;
    u16(p, ifd.entries.length);
    p += 2;
    for (const { tag, value } of ifd.entries) {
      const bytes = typeof value.data === "string" ? new TextEncoder().encode(value.data) : value.data instanceof Uint8Array ? value.data : null;
      const count = bytes ? bytes.length : (value.data as number[]).length / (value.type === 5 ? 2 : 1);
      const size = SIZES[value.type]! * count;
      u16(p, tag);
      u16(p + 2, value.type);
      u32(p + 4, count);
      let at = p + 8;
      if (size > 4) {
        valuePos += valuePos & 1;
        u32(p + 8, valuePos);
        at = valuePos;
        valuePos += size;
      }
      entryAt[`${ifd.name}:${tag}`] = at;
      if (bytes) buf.set(bytes, at);
      else (value.data as number[]).forEach((n, i) => (value.type === 1 ? (buf[at + i] = n) : value.type === 3 ? u16(at + i * 2, n) : u32(at + i * 4, n)));
      p += 12;
    }
    u32(p, 0);
  }
  if (options.exif) u32(entryAt["IFD0:34665"]!, offsets.Exif!);
  if (options.gps) u32(entryAt["IFD0:34853"]!, offsets.GPS!);
  if (options.interop) u32(entryAt["Exif:40965"]!, offsets.Interop!);
  if (options.ifd1) u32(offsets.IFD0! + 2 + ifds[0]!.entries.length * 12, offsets.IFD1!);
  if (options.ifd1 && options.thumbnail) {
    valuePos += valuePos & 1;
    u32(entryAt["IFD1:513"]!, valuePos);
    buf.set(options.thumbnail, valuePos);
    valuePos += options.thumbnail.length;
  }
  if (options.makerNote) {
    // "IMGW" + absolute offset to a 4-byte payload at the end of the note + payload "MNOK".
    const at = entryAt["Exif:37500"]!;
    buf.set(new TextEncoder().encode("IMGW"), at);
    u32(at + 4, at + 28);
    buf.set(new TextEncoder().encode("MNOK"), at + 28);
  }
  return buf.slice(0, valuePos);
}

/** Reads the fixture MakerNote's absolute pointer and checks its payload is still where it says. */
export function makerNoteIntact(tiff: Uint8Array, littleEndian = true): boolean {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  for (let i = 0; i + 8 <= tiff.length; i++) {
    if (tiff[i] === 0x49 && tiff[i + 1] === 0x4d && tiff[i + 2] === 0x47 && tiff[i + 3] === 0x57) {
      const target = view.getUint32(i + 4, littleEndian);
      return new TextDecoder().decode(tiff.subarray(target, target + 4)) === "MNOK";
    }
  }
  return false;
}

// --- framing -------------------------------------------------------------------------------------------------------

export function jpegSegment(marker: number, body: Uint8Array | string): Uint8Array {
  const data = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(4 + data.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = ((data.length + 2) >> 8) & 0xff;
  out[3] = (data.length + 2) & 0xff;
  out.set(data, 4);
  return out;
}

export function concat(...parts: (Uint8Array | string)[]): Uint8Array {
  const arrays = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) (out.set(a, o), (o += a.length));
  return out;
}

/** Inserts segments right after SOI (and after APP0 when present). */
export function withSegments(jpeg: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4]! << 8) | jpeg[5]!);
  return concat(jpeg.subarray(0, at), ...segments, jpeg.subarray(at));
}

export function exifSegment(tiff: Uint8Array): Uint8Array {
  return jpegSegment(0xe1, concat(new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), tiff));
}

export const XMP_PACKET = (props = "") => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
 xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
 xmp:CreatorTool="Darkroom 4.2" xmp:Rating="4" photoshop:City="Lisbon" exif:GPSLatitude="38,42.6N" xmpMM:DocumentID="xmp.did:1234"${props}>
 <dc:creator><rdf:Seq><rdf:li>Ana Silva</rdf:li></rdf:Seq></dc:creator>
 <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Sunset over Alfama</rdf:li></rdf:Alt></dc:title>
 <dc:subject><rdf:Bag><rdf:li>sunset</rdf:li><rdf:li>travel</rdf:li></rdf:Bag></dc:subject>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

export function xmpSegment(xml: string): Uint8Array {
  return jpegSegment(0xe1, concat("http://ns.adobe.com/xap/1.0/\0", xml));
}

/** An APP13 Photoshop block with IPTC (keywords, by-line, city, caption) and a resolution resource. */
export function iptcSegment(withDigest = true): Uint8Array {
  const ds = (record: number, dataset: number, text: string) => {
    const data = new TextEncoder().encode(text);
    return concat(new Uint8Array([0x1c, record, dataset, (data.length >> 8) & 0xff, data.length & 0xff]), data);
  };
  const iptc = concat(ds(1, 90, "\x1b%G"), ds(2, 25, "sunset"), ds(2, 25, "lisbon"), ds(2, 80, "Ana Silva"), ds(2, 90, "Lisbon"), ds(2, 120, "Golden hour over the river"), ds(2, 116, "© Ana Silva"));
  const resource = (id: number, data: Uint8Array) => {
    const head = new Uint8Array([0x38, 0x42, 0x49, 0x4d, (id >> 8) & 0xff, id & 0xff, 0, 0, 0, 0, 0, 0]);
    new DataView(head.buffer).setUint32(8, data.length);
    return concat(head, data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
  };
  const resolution = new Uint8Array(16);
  new DataView(resolution.buffer).setUint32(0, 300 * 65536);
  new DataView(resolution.buffer).setUint16(4, 1);
  new DataView(resolution.buffer).setUint32(8, 300 * 65536);
  const digest = new Uint8Array(16).fill(0xab); // deliberately stale: imgwand must recompute it
  return jpegSegment(0xed, concat("Photoshop 3.0\0", resource(0x03ed, resolution), resource(0x0404, iptc), ...(withDigest ? [resource(0x0425, digest)] : [])));
}

export function comSegment(text: string): Uint8Array {
  return jpegSegment(0xfe, text);
}

/** A complete "camera" EXIF with GPS, a thumbnail and a MakerNote. */
export async function cameraTiff(littleEndian = true): Promise<Uint8Array> {
  const thumbnail = new Uint8Array(await scene(32, 20).jpeg({ quality: 60 }).toBuffer());
  return buildTiff({
    littleEndian,
    ifd0: [
      { tag: 0x010f, value: ascii("Fujifilm") },
      { tag: 0x0110, value: ascii("X-T5") },
      { tag: 0x0112, value: short(1) },
      { tag: 0x011a, value: rational([72, 1]) },
      { tag: 0x011b, value: rational([72, 1]) },
      { tag: 0x0128, value: short(2) },
      { tag: 0x0131, value: ascii("Darkroom 4.2") },
      { tag: 0x0132, value: ascii("2026:05:01 19:42:10") },
      { tag: 0x013b, value: ascii("Ana Silva") },
      { tag: 0x8298, value: ascii("(c) Ana Silva") },
    ],
    exif: [
      { tag: 0x829a, value: rational([1, 250]) },
      { tag: 0x829d, value: rational([56, 10]) },
      { tag: 0x8827, value: short(400) },
      { tag: 0x9000, value: undef("0232") },
      { tag: 0x9003, value: ascii("2026:05:01 19:42:10") },
      { tag: 0x920a, value: rational([230, 10]) },
      { tag: 0x9286, value: undef(concat("ASCII\0\0\0", "Shot from the miradouro")) },
      { tag: 0xa430, value: ascii("Ana Silva") },
      { tag: 0xa431, value: ascii("5CA12345") },
      { tag: 0xa434, value: ascii("XF23mmF1.4 R LM WR") },
      { tag: 0xa435, value: ascii("3BA00987") },
    ],
    interop: [{ tag: 0x0001, value: ascii("R98") }],
    gps: [
      { tag: 0x0000, value: byte(2, 3, 0, 0) },
      { tag: 0x0001, value: ascii("N") },
      { tag: 0x0002, value: rational([38, 1], [42, 1], [3600, 100]) },
      { tag: 0x0003, value: ascii("W") },
      { tag: 0x0004, value: rational([9, 1], [8, 1], [1200, 100]) },
      { tag: 0x0006, value: rational([4570, 100]) },
    ],
    ifd1: [
      { tag: 0x0103, value: short(6) },
      { tag: 0x011a, value: rational([72, 1]) },
      { tag: 0x011b, value: rational([72, 1]) },
      { tag: 0x0128, value: short(2) },
    ],
    thumbnail,
    makerNote: true,
  });
}

/** A JPEG with EXIF (GPS, thumbnail, MakerNote), XMP, IPTC, ICC and a comment. */
export async function fullJpeg(options: { width?: number; height?: number; littleEndian?: boolean } = {}): Promise<Uint8Array> {
  const base = new Uint8Array(await scene(options.width ?? 320, options.height ?? 200).withIccProfile("p3").jpeg({ quality: 88 }).toBuffer());
  return withSegments(base, exifSegment(await cameraTiff(options.littleEndian ?? true)), xmpSegment(XMP_PACKET()), iptcSegment(), comSegment("Edited on a train"));
}

// --- PNG / WebP ----------------------------------------------------------------------------------------------------

function crc(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array | string): Uint8Array {
  const body = concat(type, typeof data === "string" ? new TextEncoder().encode(data) : data);
  const out = new Uint8Array(4 + body.length + 4);
  new DataView(out.buffer).setUint32(0, body.length - 4);
  out.set(body, 4);
  new DataView(out.buffer).setUint32(4 + body.length, crc(body));
  return out;
}

/** Inserts chunks right after IHDR. */
export function withChunks(png: Uint8Array, ...chunks: Uint8Array[]): Uint8Array {
  const ihdrEnd = 8 + 8 + 13 + 4;
  return concat(png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd));
}

export async function fullPng(): Promise<Uint8Array> {
  const base = new Uint8Array(await scene(240, 150).png().toBuffer());
  const latin = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  const tiff = buildTiff({ ifd0: [{ tag: 0x010f, value: ascii("Pixel") }, { tag: 0x0110, value: ascii("Pixel 10") }], gps: [{ tag: 0x0001, value: ascii("S") }, { tag: 0x0002, value: rational([33, 1], [52, 1], [0, 1]) }] });
  const icc = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).withIccProfile("p3").jpeg().toBuffer());
  const profile = (await import("../../src/container/jpeg.js")).parseJpeg(icc).blocks.find((b) => b.kind === "icc")!.payload;
  return withChunks(
    base,
    pngChunk("iCCP", concat("Display P3\0\0", deflateSync(profile))),
    pngChunk("eXIf", tiff),
    pngChunk("tEXt", concat(latin("Author\0"), latin("Ana Silva"))),
    pngChunk("tEXt", concat(latin("Software\0"), latin("Darkroom 4.2"))),
    pngChunk("zTXt", concat(latin("Comment\0\0"), deflateSync(latin("Made in Lisbon")))),
    pngChunk("iTXt", concat("XML:com.adobe.xmp\0\0\0\0\0", XMP_PACKET())),
    pngChunk("tIME", new Uint8Array([0x07, 0xea, 5, 1, 19, 42, 10])),
  );
}

export async function fullWebp(): Promise<Uint8Array> {
  return new Uint8Array(
    await scene(240, 150)
      .withExif({ IFD0: { Make: "Google", Model: "Pixel 10", Artist: "Ana Silva" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "38/1 42/1 36/1" } })
      .withXmp(XMP_PACKET())
      .withIccProfile("p3")
      .webp({ quality: 80 })
      .toBuffer(),
  );
}
