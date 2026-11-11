import { arch, platform, release } from "node:os";
import { GROUPS, PRESETS, runtimeVersions, VERSION } from "@hrhv/imgwand";
import { configPath } from "../config.js";
import type { Capabilities } from "../terminal/capabilities.js";
import type { CommandContext } from "./shared.js";

export interface NativeInfo {
  /** Where a standalone binary extracted its native libraries. */
  readonly cacheDir?: string;
  readonly c2paVersion?: string;
}

/** `imgwand -v`: versions, platform, native libraries and terminal graphics (include it in bug reports). */
export async function infoCommand(ctx: CommandContext, caps: Capabilities, native: NativeInfo = {}): Promise<number> {
  const { style } = ctx;
  const v = await runtimeVersions();
  const runtime = typeof (globalThis as { Bun?: { version: string } }).Bun !== "undefined" ? `Bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version} (standalone binary)` : `Node.js ${process.versions.node}`;
  const ok = (value: string | undefined) => (value ? `${style.green("✓")} ${value}` : `${style.red("✗")} not available`);
  const lines = [
    `imgwand ${VERSION}`,
    `${platform()}-${arch()} (${release()}), ${runtime}`,
    "",
    style.bold("Libraries"),
    `  sharp      ${ok(v.sharp && `${v.sharp} (libvips ${v.libvips})`)}`,
    `  c2pa-node  ${ok(native.c2paVersion ?? v.c2pa)}`,
    ...(native.cacheDir ? [`  native     ${native.cacheDir}`] : []),
    "",
    style.bold("Terminal"),
    `  terminal   ${caps.terminal}`,
    `  graphics   ${caps.protocol} — ${caps.reason}`,
    `  truecolor  ${caps.truecolor ? "yes" : "no"}`,
    `  cell size  ${caps.cell.width}×${caps.cell.height}px${caps.cell.measured ? "" : " (assumed)"}`,
  ];
  if (caps.tmux) {
    lines.push(`  tmux       ${caps.tmux.version ?? "?"}, client ${caps.tmux.clientTermName ?? "?"} (${caps.tmux.clientTermType ?? "?"}), passthrough ${caps.tmux.passthrough ? "on" : "off"}`);
    if (caps.kittyPlaceholders) lines.push("             kitty images use Unicode placeholders inside tmux");
  }
  for (const hint of caps.hints) lines.push(`  ${style.yellow("!")} ${hint}`);
  lines.push("", style.bold("Config"), `  ${configPath(ctx.env)}`);
  ctx.out(`${lines.join("\n")}\n`);
  return 0;
}

export function fieldsHelp(): string {
  return [
    "Selectors (for strip -f, and the TUI's : command line):",
    "",
    "  exif:GPS:GPSLatitude      an exact field id (see `imgwand show --json` for ids)",
    "  GPSLatitude               a field name",
    "  exif:GPS:*   xmp:dc:*     a glob over field ids",
    `  ${GROUPS.join(" ")}`,
    "                            a whole group",
    ...Object.entries(PRESETS).map(([k, v]) => `  ${k.padEnd(26)}${v}`),
    "  !icc  !exif:IFD0:Orientation",
    "                            exclude (applied last), e.g. -f all -f '!icc'",
    "",
    "Field ids:",
    "  exif:<IFD0|ExifIFD|GPS|Interop|IFD1>:<Tag>   xmp:<prefix>:<name>   iptc:<Dataset>",
    "  photoshop:<Resource>   icc:<Field>   c2pa:<Field>   comment:COM   png:<Keyword>   other:<Block>",
  ].join("\n");
}
