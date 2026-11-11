import { renderPaletted, renderPng, renderRaster, type PalettedRaster, type Raster } from "@hrhv/imgwand";
import { tmuxWrap, type Capabilities, type GraphicsProtocol } from "./capabilities.js";
import { DIACRITICS } from "./diacritics.js";

/** Encoders that turn an image into terminal output for each graphics protocol. */

export interface Box {
  /** Size of the area to draw into, in character cells. */
  readonly cols: number;
  readonly rows: number;
}

export interface Rendered {
  /** Text to write at the cursor position (images are drawn from the top-left of the box). */
  readonly output: string;
  /** Cells the image actually covers. */
  readonly cols: number;
  readonly rows: number;
  readonly protocol: GraphicsProtocol;
}

const ESC = "\x1b";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Pixel size of the box, and the cell footprint of an image scaled to fit it. */
function fit(box: Box, cell: Capabilities["cell"]) {
  return { width: Math.max(1, box.cols * cell.width), height: Math.max(1, box.rows * cell.height) };
}

function cellsFor(width: number, height: number, cell: Capabilities["cell"], box: Box) {
  return { cols: Math.min(box.cols, Math.max(1, Math.ceil(width / cell.width))), rows: Math.min(box.rows, Math.max(1, Math.ceil(height / cell.height))) };
}

// --- kitty ---------------------------------------------------------------------------------------------------

/** Splits a kitty graphics payload into the protocol's 4096-byte chunks. */
export function kittyChunks(control: string, payload: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < payload.length || i === 0; i += 4096) {
    const part = payload.slice(i, i + 4096);
    const more = i + 4096 < payload.length ? 1 : 0;
    chunks.push(i === 0 ? `${ESC}_G${control},m=${more};${part}${ESC}\\` : `${ESC}_Gm=${more};${part}${ESC}\\`);
  }
  return chunks;
}

/** Placeholder text for a kitty virtual placement: one U+10EEEE per cell, colored with the image id. */
export function kittyPlaceholders(id: number, cols: number, rows: number): string {
  const r = (id >> 16) & 0xff, g = (id >> 8) & 0xff, b = id & 0xff;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    // The first cell carries explicit row and column diacritics; the rest of the row is inferred.
    const first = `\u{10EEEE}${String.fromCodePoint(DIACRITICS[row] ?? DIACRITICS[0]!)}${String.fromCodePoint(DIACRITICS[0]!)}`;
    lines.push(`${ESC}[38;2;${r};${g};${b}m${first}${"\u{10EEEE}".repeat(Math.max(0, cols - 1))}${ESC}[39m`);
  }
  return lines.join("\n");
}

export async function encodeKitty(bytes: Uint8Array, box: Box, caps: Capabilities, imageId = 0x1d2c3b): Promise<Rendered> {
  const { png, width, height } = await renderPng(bytes, fit(box, caps.cell));
  const { cols, rows } = cellsFor(width, height, caps.cell, box);
  const data = base64(png);
  const wrap = (s: string) => (caps.tmux ? tmuxWrap(s) : s);
  if (caps.kittyPlaceholders) {
    // Transmit, then create a virtual placement that the placeholder cells below refer to.
    const transmit = kittyChunks(`a=t,f=100,i=${imageId},q=2`, data).map(wrap).join("");
    const place = wrap(`${ESC}_Ga=p,U=1,i=${imageId},c=${cols},r=${rows},q=2${ESC}\\`);
    return { output: transmit + place + kittyPlaceholders(imageId, cols, rows), cols, rows, protocol: "kitty" };
  }
  const output = kittyChunks(`a=T,f=100,i=${imageId},c=${cols},r=${rows},C=1,q=2`, data).map(wrap).join("");
  return { output, cols, rows, protocol: "kitty" };
}

/** Deletes every kitty image placement (used when leaving a preview). */
export function kittyClear(caps: Capabilities): string {
  const seq = `${ESC}_Ga=d,d=A,q=2${ESC}\\`;
  return caps.tmux ? tmuxWrap(seq) : seq;
}

// --- iTerm2 --------------------------------------------------------------------------------------------------

export async function encodeIterm(bytes: Uint8Array, box: Box, caps: Capabilities): Promise<Rendered> {
  const { png, width, height } = await renderPng(bytes, fit(box, caps.cell));
  const { cols, rows } = cellsFor(width, height, caps.cell, box);
  const seq = `${ESC}]1337;File=inline=1;size=${png.length};width=${cols};height=${rows};preserveAspectRatio=1:${base64(png)}\x07`;
  return { output: caps.tmux ? tmuxWrap(seq) : seq, cols, rows, protocol: "iterm" };
}

// --- sixel ---------------------------------------------------------------------------------------------------

/** Encodes paletted pixels as a sixel image (with run-length encoding). */
export function sixelFromPaletted(img: PalettedRaster): string {
  const { width, height, indices, palette } = img;
  const colors = palette.length / 3;
  const parts: string[] = [`${ESC}Pq"1;1;${width};${height}`];
  for (let i = 0; i < colors; i++) {
    const pct = (v: number) => Math.round((v * 100) / 255);
    parts.push(`#${i};2;${pct(palette[i * 3]!)};${pct(palette[i * 3 + 1]!)};${pct(palette[i * 3 + 2]!)}`);
  }
  const run = (char: string, count: number) => (count > 3 ? `!${count}${char}` : char.repeat(count));
  for (let band = 0; band < height; band += 6) {
    const bandHeight = Math.min(6, height - band);
    // Which colors appear in this band, and their sixel bit patterns per column.
    const used = new Map<number, Uint8Array>();
    for (let dy = 0; dy < bandHeight; dy++) {
      const row = (band + dy) * width;
      for (let x = 0; x < width; x++) {
        const c = indices[row + x]!;
        let bits = used.get(c);
        if (!bits) used.set(c, (bits = new Uint8Array(width)));
        bits[x]! |= 1 << dy;
      }
    }
    let first = true;
    for (const [color, bits] of used) {
      if (!first) parts.push("$");
      first = false;
      parts.push(`#${color}`);
      let prev = -1;
      let count = 0;
      let line = "";
      for (let x = 0; x < width; x++) {
        const v = bits[x]!;
        if (v === prev) count++;
        else {
          if (count > 0) line += run(String.fromCharCode(63 + prev), count);
          prev = v;
          count = 1;
        }
      }
      if (count > 0) line += run(String.fromCharCode(63 + prev), count);
      parts.push(line);
    }
    parts.push("-");
  }
  parts.push(`${ESC}\\`);
  return parts.join("");
}

export async function encodeSixel(bytes: Uint8Array, box: Box, caps: Capabilities): Promise<Rendered> {
  const img = await renderPaletted(bytes, { ...fit(box, caps.cell), colors: 256 });
  const { cols, rows } = cellsFor(img.width, img.height, caps.cell, box);
  // tmux 3.4+ understands sixel itself, so it is sent as-is (no passthrough wrapping).
  return { output: sixelFromPaletted(img), cols, rows, protocol: "sixel" };
}

// --- text fallbacks ------------------------------------------------------------------------------------------

/** Two pixels per cell with the upper half block: fg = top pixel, bg = bottom pixel. */
export function blocksFromRaster(img: Raster, truecolor = true): string {
  const { data, width, height } = img;
  const color = (i: number, fg: boolean) => {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    if (truecolor) return `${ESC}[${fg ? 38 : 48};2;${r};${g};${b}m`;
    const q = (v: number) => Math.round((v / 255) * 5);
    return `${ESC}[${fg ? 38 : 48};5;${16 + 36 * q(r) + 6 * q(g) + q(b)}m`;
  };
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = (y * width + x) * 4;
      const hasBottom = y + 1 < height;
      const bottom = ((y + 1) * width + x) * 4;
      const topOpaque = data[top + 3]! >= 128;
      const bottomOpaque = hasBottom && data[bottom + 3]! >= 128;
      if (topOpaque && bottomOpaque) line += `${color(top, true)}${color(bottom, false)}▀`;
      else if (topOpaque) line += `${ESC}[49m${color(top, true)}▀`;
      else if (bottomOpaque) line += `${ESC}[49m${color(bottom, true)}▄`;
      else line += `${ESC}[0m `;
    }
    lines.push(`${line}${ESC}[0m`);
  }
  return lines.join("\n");
}

const RAMP = " .:-=+*#%@";

export function asciiFromRaster(img: Raster): string {
  const { data, width, height } = img;
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) * (data[i + 3]! / 255);
      line += RAMP[Math.min(RAMP.length - 1, Math.floor((lum / 256) * RAMP.length))];
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export async function encodeBlocks(bytes: Uint8Array, box: Box, caps: Pick<Capabilities, "truecolor">, ascii = false): Promise<Rendered> {
  // One cell is one pixel wide and two pixels tall; terminal cells are about twice as tall as wide.
  const img = await renderRaster(bytes, { width: box.cols, height: box.rows * 2 });
  const output = ascii ? asciiFromRaster(img) : blocksFromRaster(img, caps.truecolor);
  return { output, cols: img.width, rows: Math.ceil(img.height / 2), protocol: ascii ? "ascii" : "blocks" };
}

export async function encodeImage(bytes: Uint8Array, box: Box, caps: Capabilities): Promise<Rendered> {
  switch (caps.protocol) {
    case "kitty":
      return encodeKitty(bytes, box, caps);
    case "iterm":
      return encodeIterm(bytes, box, caps);
    case "sixel":
      return encodeSixel(bytes, box, caps);
    case "ascii":
      return encodeBlocks(bytes, box, caps, true);
    case "none":
      return { output: "", cols: 0, rows: 0, protocol: "none" };
    default:
      return encodeBlocks(bytes, box, caps);
  }
}

/** Whether a protocol draws pixels on top of the text grid (and so has to be positioned and cleared by hand). */
export function isPixelProtocol(protocol: GraphicsProtocol): boolean {
  return protocol === "kitty" || protocol === "iterm" || protocol === "sixel";
}
