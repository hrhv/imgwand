import { renderPng, renderPaletted } from "@hrhv/imgwand";
import { type Capabilities, type GraphicsProtocol } from "../terminal/capabilities.js";
import { encodeBlocks, kittyChunks, kittyPlaceholders, sixelFromPaletted, type Box } from "../terminal/encoders.js";

/**
 * Real images inside the Ink layout. Ink renders text only, so for pixel protocols the side panel reserves blank
 * cells and the image is drawn on top of them after every frame Ink writes:
 *
 *   render: App calls request() with what should be on screen (synchronously, so it matches the frame)
 *   write:  the stdout proxy sees Ink's frame; if the image changed or went away, the old one is erased first
 *   commit: Ink's onRender calls afterRender(), which draws the requested image over the frame
 *
 * Drawing happens only after a frame was written (or the request changed), so an idle UI sends nothing.
 */

const ESC = "\x1b";
const SIDE_IMAGE_ID = 0x1d2c3c; // not the full-screen preview's id, so the two never replace each other

export interface SideImage {
  /** The protocol actually used (the panel falls back to blocks where pixels would not survive, e.g. tmux). */
  readonly protocol: GraphicsProtocol;
  /** Cells the image covers. */
  readonly cols: number;
  readonly rows: number;
  /** Text for Ink to render in the panel: colored blocks, kitty placeholders, or nothing (overlays). */
  readonly text: string;
  /** Overlays: draws the image at the cursor. */
  readonly draw?: string;
  /** Sent once before the image is first shown (kitty: the image data). */
  readonly setup?: string;
  /** Removes it (kitty images live on their own layer, so text does not erase them). */
  readonly clear?: string;
}

export interface OverlayRequest {
  readonly image: SideImage;
  /** 1-based screen position of the image's top-left cell. */
  readonly row: number;
  readonly col: number;
}

/** Which protocol the side panel uses for a terminal: the detected one, unless it cannot work inside the layout. */
export function sidePanelProtocol(caps: Capabilities): GraphicsProtocol {
  if (caps.protocol === "kitty") return "kitty"; // in tmux, as Unicode placeholders
  // tmux redraws its panes from its own grid and would wipe images it does not track: use text there.
  if ((caps.protocol === "iterm" || caps.protocol === "sixel") && !caps.tmux) return caps.protocol;
  return caps.protocol === "ascii" || caps.protocol === "none" ? caps.protocol : "blocks";
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const wrapTmux = (caps: Capabilities, seq: string) => (caps.tmux ? `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ESC}\\` : seq);

/** Renders an image for the side panel in the best protocol it can use there. */
export async function renderSideImage(bytes: Uint8Array, box: Box, caps: Capabilities): Promise<SideImage> {
  const protocol = sidePanelProtocol(caps);
  const pixels = { width: Math.max(1, box.cols * caps.cell.width), height: Math.max(1, box.rows * caps.cell.height) };
  const cellsFor = (width: number, height: number) => ({
    cols: Math.min(box.cols, Math.max(1, Math.ceil(width / caps.cell.width))),
    rows: Math.min(box.rows, Math.max(1, Math.ceil(height / caps.cell.height))),
  });
  switch (protocol) {
    case "iterm": {
      const { png, width, height } = await renderPng(bytes, pixels);
      const { cols, rows } = cellsFor(width, height);
      // doNotMoveCursor keeps the cursor where it was (newer iTerm2); the overlay also saves and restores it.
      const draw = `${ESC}]1337;File=inline=1;size=${png.length};width=${cols};height=${rows};preserveAspectRatio=1;doNotMoveCursor=1:${base64(png)}\x07`;
      return { protocol, cols, rows, text: "", draw };
    }
    case "sixel": {
      const img = await renderPaletted(bytes, { ...pixels, colors: 256 });
      const { cols, rows } = cellsFor(img.width, img.height);
      return { protocol, cols, rows, text: "", draw: sixelFromPaletted(img) };
    }
    case "kitty": {
      const { png, width, height } = await renderPng(bytes, pixels);
      const { cols, rows } = cellsFor(width, height);
      const id = SIDE_IMAGE_ID;
      const transmit = kittyChunks(`a=t,f=100,i=${id},q=2`, base64(png)).map((s) => wrapTmux(caps, s)).join("");
      if (caps.kittyPlaceholders || caps.tmux) {
        // Placeholder cells are ordinary text, so Ink lays them out and tmux keeps them; the data goes ahead of it.
        const place = wrapTmux(caps, `${ESC}_Ga=p,U=1,i=${id},c=${cols},r=${rows},q=2${ESC}\\`);
        return { protocol, cols, rows, text: kittyPlaceholders(id, cols, rows), setup: transmit + place, clear: wrapTmux(caps, `${ESC}_Ga=d,d=i,i=${id},q=2${ESC}\\`) };
      }
      return {
        protocol,
        cols,
        rows,
        text: "",
        setup: transmit,
        draw: `${ESC}_Ga=p,i=${id},p=1,c=${cols},r=${rows},C=1,q=2${ESC}\\`,
        clear: `${ESC}_Ga=d,d=i,i=${id},q=2${ESC}\\`,
      };
    }
    case "none":
      return { protocol, cols: 0, rows: 0, text: "" };
    default: {
      const r = await encodeBlocks(bytes, box, caps, protocol === "ascii");
      return { protocol: r.protocol, cols: r.cols, rows: r.rows, text: r.output };
    }
  }
}

export class ImageOverlay {
  private requested?: OverlayRequest;
  private drawn?: OverlayRequest;
  private setupSent?: SideImage;
  private framesWritten = 0;
  private framesAtDraw = -1;

  constructor(private readonly write: (data: string) => void) {}

  /** What should be on screen with the frame being rendered (undefined: nothing). Call during render. */
  request(next: OverlayRequest | undefined): void {
    this.requested = next && (next.image.draw || next.image.setup) ? next : undefined;
  }

  /** Called by the stdout proxy just before Ink writes a frame: returns what has to go out ahead of it. */
  beforeFrame(): string {
    this.framesWritten++;
    let out = "";
    const { drawn, requested } = this;
    if (drawn && !sameRequest(drawn, requested)) {
      out += erase(drawn);
      this.drawn = undefined;
    }
    // Kitty placeholders are part of the frame text: their image data must be there first.
    if (requested?.image.setup && this.setupSent !== requested.image && !requested.image.draw) {
      out += requested.image.setup;
      this.setupSent = requested.image;
      this.drawn = requested;
    }
    return out;
  }

  /** Called after Ink wrote a frame (Ink's onRender): draws the requested image over it. */
  afterRender(): void {
    const { requested } = this;
    if (!requested) {
      if (this.drawn) {
        // The request went away without a new frame (nothing else changed on screen).
        this.write(erase(this.drawn));
        this.drawn = undefined;
      }
      return;
    }
    if (!requested.image.draw) return; // placeholders: drawn by the frame itself
    if (this.drawn && sameRequest(this.drawn, requested) && this.framesAtDraw === this.framesWritten) return;
    let out = this.drawn && !sameRequest(this.drawn, requested) ? erase(this.drawn) : "";
    if (requested.image.setup && this.setupSent !== requested.image) {
      out += requested.image.setup;
      this.setupSent = requested.image;
    }
    out += `${ESC}7${ESC}[${requested.row};${requested.col}H${requested.image.draw}${ESC}8`;
    this.write(out);
    this.drawn = requested;
    this.framesAtDraw = this.framesWritten;
  }

  /** Forget what is on screen (after something else took over the terminal, e.g. the full-screen preview). */
  reset(): void {
    this.drawn = undefined;
    this.setupSent = undefined;
    this.framesAtDraw = -1;
  }

  /** Removes the image for good (on exit). */
  dispose(): void {
    if (this.drawn) this.write(erase(this.drawn));
    this.drawn = undefined;
    this.requested = undefined;
  }
}

function sameRequest(a: OverlayRequest, b: OverlayRequest | undefined): boolean {
  return !!b && a.image === b.image && a.row === b.row && a.col === b.col;
}

/** Erases a drawn image: kitty by deleting its placement, cell-based protocols by writing spaces over it. */
function erase(r: OverlayRequest): string {
  if (r.image.clear) return r.image.clear;
  let out = `${ESC}7${ESC}[0m`;
  for (let i = 0; i < r.image.rows; i++) out += `${ESC}[${r.row + i};${r.col}H${" ".repeat(r.image.cols)}`;
  return `${out}${ESC}8`;
}

/**
 * A stdout for Ink that lets the overlay put its erase sequence ahead of each frame. Everything else (size, resize
 * events, isTTY) is the real stream's.
 */
export function overlayStdout(stdout: NodeJS.WriteStream, overlay: ImageOverlay): NodeJS.WriteStream {
  return new Proxy(stdout, {
    get(target, property) {
      if (property === "write") {
        return (chunk: string | Uint8Array, ...rest: unknown[]) => {
          const before = overlay.beforeFrame();
          if (before) target.write(before);
          return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
