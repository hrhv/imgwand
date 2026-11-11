import React from "react";
import { render } from "ink";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ImageDocument, VERSION, imageInfo, signC2pa, writeFileAtomic, type C2paSigner } from "@hrhv/imgwand";
import { loadTrustAnchors, resolveSigner } from "../commands/c2pa.js";
import type { CommandContext } from "../commands/shared.js";
import { createStyle, sanitize } from "../style.js";
import type { TuiOptions } from "../program.js";
import { App, type AppDeps } from "./App.js";
import { listDir } from "./fs.js";
import { ImageOverlay, overlayStdout, renderSideImage, type SideImage } from "./overlay.js";

export function defaultDeps(options: Pick<TuiOptions, "config" | "env" | "capabilities"> & { readonly cwd?: string; readonly overlay?: ImageOverlay }): AppDeps {
  const ctx: CommandContext = { cwd: options.cwd ?? process.cwd(), env: options.env, config: options.config, style: createStyle(false), out: () => undefined, err: () => undefined };
  // Read lazily and once; a configured but unreadable file is reported when an image is opened.
  let anchors: Promise<string | undefined> | undefined;
  let sideCache: { bytes: Uint8Array; cols: number; rows: number; image: Promise<SideImage> } | undefined;
  return {
    listDir,
    openDocument: async (path) => {
      anchors ??= loadTrustAnchors(ctx);
      return ImageDocument.open(path, { c2paOptions: { trustAnchors: await anchors } });
    },
    imageInfo: (bytes) => imageInfo(bytes).catch(() => undefined),
    // Cached: coming back to the same image at the same size reuses it (no re-encoding, no erase-and-redraw).
    renderInline: (bytes, box) => {
      if (sideCache && sideCache.bytes === bytes && sideCache.cols === box.cols && sideCache.rows === box.rows) return sideCache.image;
      const image = renderSideImage(bytes, box, options.capabilities);
      const entry = { bytes, cols: box.cols, rows: box.rows, image };
      sideCache = entry;
      image.catch(() => {
        if (sideCache === entry) sideCache = undefined;
      });
      return image;
    },
    overlay: options.overlay,
    writeFile: writeFileAtomic,
    sign: signC2pa,
    // Same rules (and error messages) as `imgwand c2pa sign`; undefined when no signer is configured at all.
    loadSigner: async (): Promise<C2paSigner | undefined> => {
      const configured = options.env.IMGWAND_C2PA_CERT ?? options.config.signer?.cert;
      if (!configured) return undefined;
      return resolveSigner(ctx, {});
    },
  };
}

/** Starts the interactive UI on a directory or an image. Resolves with the exit code. */
export async function launchTui(options: TuiOptions): Promise<number> {
  const target = resolve(options.cwd, options.path);
  const info = await stat(target).catch(() => undefined);
  if (!info) {
    process.stderr.write(`imgwand: ${sanitize(options.path)}: no such file or directory\n`);
    return 1;
  }
  const startDir = info.isDirectory() ? target : dirname(target);
  const startFile = info.isFile() ? target : undefined;
  // Pixel images in the side panel are drawn over Ink's frames: the overlay sees each frame go out (through the
  // stdout proxy) and draws right after it (onRender).
  const overlay = new ImageOverlay((data) => process.stdout.write(data));
  const app = render(
    <App startDir={startDir} startFile={startFile} capabilities={options.capabilities} config={options.config} version={VERSION} deps={defaultDeps({ ...options, cwd: options.cwd, overlay })} />,
    {
      alternateScreen: true,
      exitOnCtrlC: false,
      patchConsole: true,
      stdout: overlayStdout(process.stdout, overlay),
      onRender: () => overlay.afterRender(),
      // Ink turns itself non-interactive (no live redraws) when the CI variable is set, e.g. in dev containers.
      // The UI only starts on a terminal, so a terminal decides.
      interactive: Boolean(process.stdout.isTTY),
    },
  );
  try {
    await app.waitUntilExit();
  } finally {
    overlay.dispose();
  }
  return 0;
}
