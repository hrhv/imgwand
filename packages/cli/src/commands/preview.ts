import { resolve } from "node:path";
import { ImgwandError, readImageFile } from "@hrhv/imgwand";
import { PROTOCOLS, type Capabilities, type GraphicsProtocol } from "../terminal/capabilities.js";
import { encodeImage } from "../terminal/encoders.js";
import type { CommandContext } from "./shared.js";

export interface PreviewOptions {
  readonly width?: string;
  readonly height?: string;
}

/** Prints an image to the terminal using the best protocol available (or the one forced with --graphics). */
export async function previewCommand(ctx: CommandContext, file: string, options: PreviewOptions, caps: Capabilities, size: { cols: number; rows: number }): Promise<number> {
  const cols = options.width ? Number(options.width) : size.cols;
  const rows = options.height ? Number(options.height) : Math.max(4, size.rows - 2);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new ImgwandError("INVALID_VALUE", "--width and --height must be positive whole numbers of cells");
  const bytes = await readImageFile(resolve(ctx.cwd, file));
  const rendered = await encodeImage(bytes, { cols, rows }, caps);
  if (rendered.protocol === "none") return 0;
  // Leave the cursor below the image so the shell prompt does not land on it. Kitty images (C=1) do not move the
  // cursor at all, so skip their height; the other protocols leave it after the image already.
  const skip = rendered.protocol === "kitty" && !caps.kittyPlaceholders ? "\n".repeat(rendered.rows) : "\n";
  ctx.out(`${rendered.output}${skip}`);
  return 0;
}

export function parseGraphics(value: string | undefined): GraphicsProtocol | "auto" | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || (PROTOCOLS as readonly string[]).includes(value)) return value as GraphicsProtocol | "auto";
  throw new ImgwandError("INVALID_VALUE", `--graphics must be one of auto, ${PROTOCOLS.join(", ")}`);
}
