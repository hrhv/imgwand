import { sanitize } from "../style.js";
import { EventEmitter } from "node:events";
import { type Capabilities, type GraphicsProtocol } from "../terminal/capabilities.js";
import { encodeImage, isPixelProtocol, kittyClear } from "../terminal/encoders.js";

/**
 * Full-screen image preview. Runs while Ink has handed the terminal back (suspendTerminal), so the image can be
 * drawn with any protocol without fighting Ink's renderer; Ink redraws everything when it resumes.
 */

export interface FullscreenIo {
  readonly stdout: NodeJS.WriteStream;
  /** Where keys come from (default: stdin, see stdinKeys). */
  readonly openTty?: () => NodeJS.ReadStream | undefined;
}

export interface FullscreenRequest {
  readonly bytes: Uint8Array;
  readonly title: string;
  readonly capabilities: Capabilities;
}

/**
 * Keys for the preview, read from stdin itself while Ink is suspended. Ink only detaches its listener when it
 * suspends; stdin keeps reading, so a second reader on the terminal would lose every key to it (always under Bun,
 * whose stdin keeps a read pending). Like Ink, this attaches a "readable" listener and never pauses or resumes stdin,
 * which would leave Ink unable to read input afterwards.
 */
export function stdinKeys(stdin: NodeJS.ReadStream = process.stdin): NodeJS.ReadStream | undefined {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return undefined;
  const handle = new EventEmitter() as EventEmitter & { setRawMode(on: boolean): void; destroy(): void };
  const onReadable = () => {
    let chunk: string | Buffer | null;
    while ((chunk = stdin.read() as string | Buffer | null) !== null) handle.emit("data", Buffer.from(chunk));
  };
  stdin.on("readable", onReadable);
  // Ink unrefs stdin while suspended; without a ref, Node would exit while the preview waits for a key.
  stdin.ref?.();
  handle.setRawMode = (on: boolean) => {
    stdin.setRawMode(on);
  };
  handle.destroy = () => {
    stdin.removeListener("readable", onReadable);
    stdin.unref?.(); // as Ink left it; Ink refs it again when it resumes
  };
  return handle as unknown as NodeJS.ReadStream;
}

/** Protocols to cycle through with "g": the detected one, then the text fallbacks. */
export function graphicsCycle(detected: GraphicsProtocol): GraphicsProtocol[] {
  return [...new Set<GraphicsProtocol>([detected, "blocks", "ascii"])].filter((p) => p !== "none");
}

function waitForKey(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      stdin.off("data", onData);
      resolve(chunk.toString());
    };
    stdin.on("data", onData);
  });
}

export async function drawFullscreen(io: FullscreenIo, request: FullscreenRequest, protocol: GraphicsProtocol): Promise<void> {
  const { stdout } = io;
  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;
  const caps = { ...request.capabilities, protocol };
  const rendered = await encodeImage(request.bytes, { cols, rows: rows - 1 }, caps);
  const left = Math.max(0, Math.floor((cols - rendered.cols) / 2));
  const top = Math.max(0, Math.floor((rows - 1 - rendered.rows) / 2));
  let out = `${request.capabilities.protocol === "kitty" ? kittyClear(caps) : ""}\x1b[2J`;
  if (isPixelProtocol(protocol) && !(protocol === "kitty" && caps.kittyPlaceholders)) {
    out += `\x1b[${top + 1};${left + 1}H${rendered.output}`;
  } else {
    rendered.output.split("\n").forEach((line, i) => (out += `\x1b[${top + i + 1};${left + 1}H${line}`));
  }
  const status = ` ${sanitize(request.title)}  ·  ${protocol}${protocol === request.capabilities.protocol ? "" : " (fallback)"}  ·  g: cycle graphics  ·  any other key: back `;
  out += `\x1b[${rows};1H\x1b[0m\x1b[7m${status.slice(0, cols).padEnd(cols)}\x1b[0m`;
  stdout.write(out);
}

/** Shows the preview until a key other than "g" is pressed. The caller suspends and resumes Ink around it. */
export async function runFullscreenPreview(io: FullscreenIo, request: FullscreenRequest): Promise<void> {
  const { stdout } = io;
  // Keys come from stdin through a listener of our own (see stdinKeys): never a second reader, never pause/resume.
  const tty = (io.openTty ?? stdinKeys)();
  if (!tty) throw new Error("no terminal to read keys from");
  const cycle = graphicsCycle(request.capabilities.protocol);
  let index = 0;
  stdout.write("\x1b[?1049h\x1b[?25l");
  tty.setRawMode(true);
  try {
    for (;;) {
      await drawFullscreen(io, request, cycle[index]!);
      const key = await waitForKey(tty);
      if (key === "g") index = (index + 1) % cycle.length;
      else break;
    }
  } finally {
    if (request.capabilities.protocol === "kitty") stdout.write(kittyClear(request.capabilities));
    stdout.write("\x1b[2J\x1b[H");
    tty.setRawMode(false);
    tty.destroy();
  }
}
