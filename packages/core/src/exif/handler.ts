import { ImgwandError } from "../errors.js";
import type { Block } from "../container/types.js";
import { emptyResult, type EditRequest, type EditResult, type Handler, type HandlerContext, type MetadataField } from "../fields.js";
import { formatExifValue } from "./format.js";
import { POINTERS, TAG_ORIENTATION, TAG_THUMBNAIL_LENGTH, TAG_THUMBNAIL_OFFSET, tagByName, tagDef, tagName, type IfdName } from "./tags.js";
import { MAX_VALUE_ITEMS, emptyTiff, isWritableTag, parseTiff, readValue, removeTiffEntries, setTiffEntry, type Tiff, type TiffTarget } from "./tiff.js";

const IFD_ORDER: readonly IfdName[] = ["IFD0", "ExifIFD", "GPS", "Interop", "IFD1"];

function sectionLabel(ifd: IfdName): string {
  return ifd === "IFD1" ? "IFD1 (thumbnail)" : ifd;
}

/**
 * Parses "exif:<IFD>:<Tag>[#<blockId>]". The suffix names the EXIF block when a file has more than one (the
 * first block's fields carry no suffix).
 */
export function parseExifId(id: string): { ifd: IfdName; tag: number; blockId?: number } | undefined {
  const m = /^exif:(IFD0|ExifIFD|GPS|Interop|IFD1):([^#]+)(?:#(\d+))?$/.exec(id);
  if (!m) return undefined;
  const ifd = m[1] as IfdName;
  const tag = tagByName(ifd, m[2]!);
  return tag === undefined ? undefined : { ifd, tag, blockId: m[3] === undefined ? undefined : Number(m[3]) };
}

function exifBlocks(ctx: HandlerContext): Block[] {
  return ctx.container.blocks.filter((b) => b.kind === "exif");
}

function fieldsFor(block: Block, tiff: Tiff, suffix: string): MetadataField[] {
  const fields: MetadataField[] = [];
  for (const ifdName of IFD_ORDER) {
    const ifd = tiff.ifds.get(ifdName);
    if (!ifd) continue;
    for (const entry of ifd.entries) {
      // Pointer tags are plumbing; their IFD's own fields stand for them.
      if (POINTERS[entry.tag] !== undefined && (ifdName === "IFD0" || ifdName === "ExifIFD")) continue;
      const def = tagDef(ifdName, entry.tag);
      const name = tagName(ifdName, entry.tag);
      const group = ifdName === "GPS" ? "gps" : ifdName === "IFD1" ? "thumbnail" : "exif";
      let note: string | undefined;
      if (ifdName === "IFD1") note = "Part of the embedded thumbnail; removing any thumbnail field removes the whole thumbnail";
      else if (entry.tag === TAG_ORIENTATION && ifdName === "IFD0") note = "Viewers use this to rotate the picture; removing it may show the image sideways";
      let value: string;
      let raw: unknown;
      if (!entry.known) {
        value = `(value of unknown TIFF type ${entry.type})`;
      } else {
        const decoded = readValue(tiff, entry);
        value = formatExifValue(ifdName, entry.tag, decoded, tiff.littleEndian, entry.count);
        raw = decoded instanceof Uint8Array || entry.count > MAX_VALUE_ITEMS ? undefined : decoded;
      }
      fields.push({
        id: `exif:${ifdName}:${name}${suffix}`,
        group,
        section: sectionLabel(ifdName),
        name,
        value,
        raw,
        removal: ifdName === "IFD1" ? "group" : "field",
        writable: ifdName !== "IFD1" && entry.known && !entry.broken && isWritableTag(ifdName, entry.tag),
        sensitive: group === "gps" || Boolean(def?.sensitive),
        note,
        blockIds: [block.id],
      });
    }
  }
  tiff.warnings.forEach((warning, i) => {
    fields.push({
      id: `exif:warning:${i}${suffix}`,
      group: "exif",
      section: "Warnings",
      name: "Warning",
      value: warning,
      removal: "none",
      writable: false,
      sensitive: false,
      blockIds: [block.id],
    });
  });
  return fields;
}

const GPS_REF: Record<string, [string, string]> = {
  GPSLatitude: ["GPSLatitudeRef", "N/S"],
  GPSLongitude: ["GPSLongitudeRef", "E/W"],
  GPSDestLatitude: ["GPSDestLatitudeRef", "N/S"],
  GPSDestLongitude: ["GPSDestLongitudeRef", "E/W"],
};

/**
 * Applies sets to one EXIF block. A coordinate given as signed decimal degrees also sets its hemisphere Ref
 * (unless the Ref is set explicitly), since EXIF stores the magnitude and the sign separately.
 */
function applySets(bytes: Uint8Array, sets: readonly (readonly [string, string])[]): Uint8Array {
  let current = bytes;
  const explicit = new Set(sets.map(([id]) => parseExifId(id)).filter(Boolean).map((p) => `${p!.ifd}:${p!.tag}`));
  for (const [id, value] of sets) {
    const parsed = parseExifId(id);
    if (!parsed) throw new ImgwandError("UNKNOWN_FIELD", `Unknown EXIF field "${id}" (expected exif:<IFD0|ExifIFD|GPS|Interop>:<TagName>)`);
    if (parsed.tag === TAG_THUMBNAIL_OFFSET || parsed.tag === TAG_THUMBNAIL_LENGTH) throw new ImgwandError("NOT_WRITABLE", "Thumbnail offsets are not writable");
    if (parsed.ifd === "IFD1") throw new ImgwandError("NOT_WRITABLE", "Thumbnail fields are not writable");
    current = setTiffEntry(parseTiff(current), parsed.ifd, parsed.tag, value);
    const ref = GPS_REF[tagName(parsed.ifd, parsed.tag)];
    const number = Number(value.trim());
    if (ref && parsed.ifd === "GPS" && value.trim() !== "" && Number.isFinite(number)) {
      const refTag = tagByName("GPS", ref[0])!;
      if (!explicit.has(`GPS:${refTag}`)) {
        const [positive, negative] = ref[1].split("/") as [string, string];
        current = setTiffEntry(parseTiff(current), "GPS", refTag, number < 0 ? negative : positive);
      }
    }
  }
  return current;
}

export const exifHandler: Handler = {
  kinds: ["exif"],
  owns: (id) => id.startsWith("exif:"),

  fields(ctx) {
    const blocks = exifBlocks(ctx);
    const out: MetadataField[] = [];
    for (const block of blocks) {
      const suffix = block === blocks[0] ? "" : `#${block.id}`;
      try {
        out.push(...fieldsFor(block, parseTiff(block.payload), suffix));
      } catch (error) {
        out.push({
          id: `exif:block#${block.id}`,
          group: "exif",
          section: "Unreadable",
          name: "EXIF",
          value: `Unreadable EXIF block (${(error as Error).message})`,
          removal: "block",
          writable: false,
          sensitive: false,
          blockIds: [block.id],
        });
      }
    }
    return out;
  },

  edit(ctx, fields, request): EditResult {
    const result = emptyResult();
    const blocks = exifBlocks(ctx);
    const primary = blocks[0];
    const removeIds = [...request.remove].filter((id) => id.startsWith("exif:"));
    const setIds = [...request.set.keys()].filter((id) => id.startsWith("exif:"));
    if (removeIds.length === 0 && setIds.length === 0) return result;

    const plans = new Map<number, { targets: TiffTarget[]; drop: boolean; sets: [string, string][] }>();
    const plan = (id: number) => plans.get(id) ?? plans.set(id, { targets: [], drop: false, sets: [] }).get(id)!;
    const byId = new Map(fields.map((f) => [f.id, f]));
    for (const id of removeIds) {
      const field = byId.get(id);
      if (!field) continue;
      const blockId = field.blockIds[0]!;
      if (field.removal === "block") {
        plan(blockId).drop = true;
        continue;
      }
      const parsed = parseExifId(id);
      if (!parsed) throw new ImgwandError("UNKNOWN_FIELD", `Cannot resolve EXIF field "${id}"`);
      plan(blockId).targets.push(parsed.ifd === "IFD1" ? { ifd: "IFD1", tag: "*" } : { ifd: parsed.ifd, tag: parsed.tag });
    }
    const newBlockSets: [string, string][] = [];
    for (const id of setIds) {
      const parsed = parseExifId(id);
      if (!parsed) throw new ImgwandError("UNKNOWN_FIELD", `Unknown EXIF field "${id}" (expected exif:<IFD0|ExifIFD|GPS|Interop>:<TagName>)`);
      const blockId = parsed.blockId ?? primary?.id;
      if (parsed.blockId !== undefined && !blocks.some((b) => b.id === parsed.blockId)) throw new ImgwandError("UNKNOWN_FIELD", `No EXIF block #${parsed.blockId}`);
      if (blockId === undefined) newBlockSets.push([id, request.set.get(id)!]);
      else plan(blockId).sets.push([id, request.set.get(id)!]);
    }

    for (const [blockId, p] of plans) {
      const block = ctx.container.blocks[blockId]!;
      if (p.drop) {
        if (p.sets.length > 0) throw new ImgwandError("INVALID_VALUE", "Cannot set EXIF fields while removing the whole EXIF block");
        result.edits.push({ id: blockId, action: "remove" });
        continue;
      }
      let bytes = p.targets.length > 0 ? removeTiffEntries(parseTiff(block.payload), p.targets) : block.payload;
      if (p.sets.length > 0) bytes = applySets(bytes, p.sets);
      // When nothing is left, drop the block instead of keeping an empty TIFF shell.
      const after = parseTiff(bytes);
      const remaining = [...after.ifds.values()].reduce((n, ifd) => n + ifd.entries.filter((x) => POINTERS[x.tag] === undefined).length, 0);
      result.edits.push(remaining === 0 ? { id: blockId, action: "remove" } : { id: blockId, action: "replace", payload: bytes });
    }
    if (newBlockSets.length > 0) result.inserts.push({ kind: "exif", payload: applySets(emptyTiff(), newBlockSets) });
    result.handledSets.push(...setIds);
    return result;
  },
};

export type { EditRequest };
