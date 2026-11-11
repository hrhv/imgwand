import { ImgwandError } from "../errors.js";
import type { Block } from "../container/types.js";
import { emptyResult, type EditResult, type Handler, type HandlerContext, type MetadataField } from "../fields.js";
import { concatBytes, formatBytes, latin1, readU16BE, readU32BE } from "../util/bytes.js";

/** ICC color profiles: read-only summary; removable only as a whole. */

const DEVICE_CLASS: Record<string, string> = {
  scnr: "Input Device", mntr: "Display Device", prtr: "Output Device", link: "Device Link", spac: "Color Space", abst: "Abstract", nmcl: "Named Color",
};
const PLATFORM: Record<string, string> = { APPL: "Apple", MSFT: "Microsoft", "SGI ": "Silicon Graphics", SUNW: "Sun Microsystems", TGNT: "Taligent" };

export interface IccSummary {
  size: number;
  cmm: string;
  version: string;
  deviceClass: string;
  colorSpace: string;
  connectionSpace: string;
  created?: string;
  platform: string;
  manufacturer: string;
  creator: string;
  description?: string;
  copyright?: string;
}

/** The ICC profile bytes, reassembled from JPEG APP2 chunks in sequence order when needed. */
export function iccProfile(blocks: readonly Block[]): Uint8Array | undefined {
  const icc = blocks.filter((b) => b.kind === "icc");
  if (icc.length === 0) return undefined;
  if (icc.length === 1) return icc[0]!.payload;
  const sorted = [...icc].sort((a, b) => Number(a.info.sequence ?? 0) - Number(b.info.sequence ?? 0));
  return concatBytes(sorted.map((b) => b.payload));
}

function sig(bytes: Uint8Array, at: number): string {
  return latin1(bytes, at, at + 4).replace(/\0/g, "").trim();
}

function textTag(profile: Uint8Array, offset: number, size: number): string | undefined {
  if (offset + size > profile.length || size < 8) return undefined;
  const type = latin1(profile, offset, offset + 4);
  if (type === "desc") {
    const n = readU32BE(profile, offset + 8);
    return latin1(profile, offset + 12, Math.min(offset + 12 + n, offset + size)).replace(/\0+$/, "");
  }
  if (type === "text") return latin1(profile, offset + 8, offset + size).replace(/\0+$/, "");
  if (type === "mluc") {
    const records = readU32BE(profile, offset + 8);
    if (records === 0) return undefined;
    const length = readU32BE(profile, offset + 20);
    const at = offset + readU32BE(profile, offset + 24);
    let s = "";
    for (let i = 0; i + 1 < length && at + i + 1 < profile.length; i += 2) s += String.fromCharCode(readU16BE(profile, at + i));
    return s.replace(/\0+$/, "");
  }
  return undefined;
}

export function parseIcc(profile: Uint8Array): IccSummary {
  if (profile.length < 132 || latin1(profile, 36, 40) !== "acsp") throw new ImgwandError("CORRUPT_FILE", "Not a valid ICC profile");
  const v = profile[8]!;
  const minor = profile[9]! >> 4;
  const bugfix = profile[9]! & 0x0f;
  const year = readU16BE(profile, 24);
  const created = year
    ? `${year}-${String(readU16BE(profile, 26)).padStart(2, "0")}-${String(readU16BE(profile, 28)).padStart(2, "0")} ${String(readU16BE(profile, 30)).padStart(2, "0")}:${String(readU16BE(profile, 32)).padStart(2, "0")}:${String(readU16BE(profile, 34)).padStart(2, "0")}`
    : undefined;
  const summary: IccSummary = {
    size: readU32BE(profile, 0),
    cmm: sig(profile, 4),
    version: `${v}.${minor}.${bugfix}`,
    deviceClass: DEVICE_CLASS[latin1(profile, 12, 16)] ?? sig(profile, 12),
    colorSpace: sig(profile, 16),
    connectionSpace: sig(profile, 20),
    created,
    platform: PLATFORM[latin1(profile, 40, 44)] ?? sig(profile, 40),
    manufacturer: sig(profile, 48),
    creator: sig(profile, 80),
  };
  const count = Math.min(readU32BE(profile, 128), Math.floor((profile.length - 132) / 12));
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12;
    const tag = latin1(profile, at, at + 4);
    const offset = readU32BE(profile, at + 4);
    const size = readU32BE(profile, at + 8);
    if (tag === "desc") summary.description = textTag(profile, offset, size);
    if (tag === "cprt") summary.copyright = textTag(profile, offset, size);
  }
  return summary;
}

export const iccHandler: Handler = {
  kinds: ["icc"],
  owns: (id) => id.startsWith("icc:"),

  fields(ctx: HandlerContext) {
    const blocks = ctx.container.blocks.filter((b) => b.kind === "icc");
    const profile = iccProfile(ctx.container.blocks);
    if (!profile) return [];
    const blockIds = blocks.map((b) => b.id);
    const note = "Removing the profile removes the whole profile; colors may then look different (unless the image is sRGB)";
    const make = (key: string, name: string, value: string | undefined): MetadataField | undefined =>
      value === undefined || value === "" ? undefined : { id: `icc:${key}`, group: "icc", section: "ICC Profile", name, value, removal: "block", writable: false, sensitive: false, note, blockIds };
    try {
      const s = parseIcc(profile);
      return [
        make("ProfileDescription", "Profile Description", s.description),
        make("ColorSpace", "Color Space", s.colorSpace),
        make("DeviceClass", "Device Class", s.deviceClass),
        make("ConnectionSpace", "Connection Space", s.connectionSpace),
        make("Version", "Version", s.version),
        make("CMM", "Preferred CMM", s.cmm),
        make("Platform", "Primary Platform", s.platform),
        make("Manufacturer", "Device Manufacturer", s.manufacturer),
        make("Creator", "Profile Creator", s.creator),
        make("CreationDate", "Creation Date", s.created),
        make("Copyright", "Copyright", s.copyright),
        make("Size", "Profile Size", formatBytes(profile.length)),
      ].filter((f): f is MetadataField => f !== undefined);
    } catch (error) {
      return [make("Profile", "ICC Profile", `Unreadable profile (${(error as Error).message})`)!];
    }
  },

  edit(ctx, _fields, request): EditResult {
    const result = emptyResult();
    if ([...request.set.keys()].some((id) => id.startsWith("icc:"))) throw new ImgwandError("NOT_WRITABLE", "ICC profile fields are read-only");
    if ([...request.remove].some((id) => id.startsWith("icc:"))) {
      for (const b of ctx.container.blocks) if (b.kind === "icc") result.edits.push({ id: b.id, action: "remove" });
    }
    return result;
  },
};
