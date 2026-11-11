import { basename, resolve } from "node:path";
import { c2paVerdict, imageInfo, readImageFile, readMetadata, formatBytes, type ImageInfo, type MetadataField, type MetadataReport } from "@hrhv/imgwand";
import { safeJson, sanitize, truncate, type Style } from "../style.js";
import { c2paStateStyle, loadTrustAnchors } from "./c2pa.js";
import type { CommandContext } from "./shared.js";

export const GROUP_TITLES: Record<string, string> = {
  exif: "EXIF",
  gps: "GPS",
  thumbnail: "Thumbnail",
  xmp: "XMP",
  iptc: "IPTC",
  photoshop: "Photoshop",
  icc: "ICC Profile",
  c2pa: "C2PA Content Credentials",
  comment: "Comments & Text",
  other: "Other",
};
export const GROUP_ORDER = ["c2pa", "exif", "gps", "thumbnail", "xmp", "iptc", "photoshop", "icc", "comment", "other"];

export function groupFields(fields: readonly MetadataField[]): { group: string; fields: MetadataField[] }[] {
  return GROUP_ORDER.map((group) => ({ group, fields: fields.filter((f) => f.group === group) })).filter((g) => g.fields.length > 0);
}

export function describeImage(info: ImageInfo | undefined, report: MetadataReport): string {
  const parts = [report.format.toUpperCase()];
  if (info) parts.push(`${info.displayWidth}×${info.displayHeight}`);
  parts.push(formatBytes(report.size));
  if (info?.space) parts.push(info.space);
  return parts.join("  ");
}

export function c2paBadge(report: MetadataReport, style: Style): string {
  if (!report.c2pa) return report.fields.some((f) => f.group === "c2pa") ? style.yellow("C2PA: unreadable") : style.dim("no C2PA");
  const verdict = c2paVerdict(report.c2pa);
  return c2paStateStyle(verdict.label, style)(`C2PA: ${verdict.label}`);
}

export function formatReport(file: string, report: MetadataReport, info: ImageInfo | undefined, style: Style, width = 100): string {
  const lines: string[] = [];
  lines.push(`${style.bold(sanitize(basename(file)))}  ${style.dim(describeImage(info, report))}  ${c2paBadge(report, style)}`);
  if (report.fields.length === 0) lines.push(style.dim("  No metadata."));
  const nameWidth = Math.min(32, Math.max(10, ...report.fields.map((f) => f.name.length)));
  for (const { group, fields } of groupFields(report.fields)) {
    lines.push("", style.cyan(style.bold(GROUP_TITLES[group] ?? group)));
    let section = "";
    for (const f of fields) {
      if (f.section !== section && group !== "gps" && group !== "c2pa") {
        section = f.section;
        lines.push(style.dim(`  ${sanitize(section)}`));
      } else if (f.section !== section) section = f.section;
      const marker = f.sensitive ? style.yellow("●") : " ";
      const name = sanitize(f.name).padEnd(nameWidth);
      const value = truncate(sanitize(f.value), Math.max(20, width - nameWidth - 8));
      lines.push(`  ${marker} ${name}  ${value}`);
    }
  }
  for (const warning of report.warnings) lines.push("", style.yellow(`! ${sanitize(warning)}`));
  if (report.fields.some((f) => f.sensitive)) lines.push("", style.dim(`${style.yellow("●")} personal or identifying (removed by the "privacy" preset)`));
  return lines.join("\n");
}

export function reportJson(file: string, report: MetadataReport, info: ImageInfo | undefined) {
  return {
    file,
    format: report.format,
    mimeType: report.mimeType,
    size: report.size,
    image: info,
    fields: report.fields.map((f) => ({ id: f.id, group: f.group, section: f.section, name: f.name, value: f.value, raw: f.raw, removal: f.removal, writable: f.writable, sensitive: f.sensitive, note: f.note })),
    c2pa: report.c2pa,
    blocks: report.blocks,
    warnings: report.warnings,
  };
}

export interface ShowOptions {
  readonly json?: boolean;
  readonly group?: string[];
  readonly c2pa?: boolean;
  /** Width to lay the report out for (the terminal's). */
  readonly width?: number;
}

export async function showCommand(ctx: CommandContext, files: string[], options: ShowOptions): Promise<number> {
  const results: unknown[] = [];
  let failures = 0;
  // Read once, and only when C2PA is being read at all.
  const trustAnchors = options.c2pa !== false ? await loadTrustAnchors(ctx) : undefined;
  for (const file of files) {
    const path = resolve(ctx.cwd, file);
    try {
      const bytes = await readImageFile(path);
      const report = await readMetadata(bytes, { c2pa: options.c2pa !== false, c2paOptions: { trustAnchors } });
      const info = await imageInfo(bytes).catch(() => undefined);
      const filtered = options.group?.length ? { ...report, fields: report.fields.filter((f) => options.group!.includes(f.group)) } : report;
      if (options.json) results.push(reportJson(file, filtered, info));
      else ctx.out(`${formatReport(file, filtered, info, ctx.style, options.width ?? 100)}\n${files.length > 1 ? "\n" : ""}`);
    } catch (error) {
      failures++;
      if (options.json) results.push({ file, error: (error as Error).message });
      else ctx.err(`${ctx.style.red("error")} ${sanitize(file)}: ${sanitize((error as Error).message)}\n`);
    }
  }
  if (options.json) ctx.out(`${safeJson(files.length === 1 ? results[0] : results)}\n`);
  return failures > 0 ? 1 : 0;
}
