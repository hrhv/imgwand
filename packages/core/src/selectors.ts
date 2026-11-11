import { ImgwandError } from "./errors.js";
import type { FieldGroup, MetadataField } from "./fields.js";
import { XMP_PROVENANCE_ID } from "./xmp/handler.js";

/**
 * Selectors pick fields to remove:
 *   exif:GPS:GPSLatitude     an exact field id (case-insensitive)
 *   GPSLatitude              a field name
 *   exif:GPS:*  xmp:dc:*     a glob over ids (* and ?)
 *   gps  exif  xmp  iptc  icc  c2pa  comment  thumbnail  photoshop  other   a group
 *   all  privacy             presets
 *   !exif:IFD0:Orientation   exclude (also "-" prefix): applied after everything else
 */

export const GROUPS: readonly FieldGroup[] = ["exif", "gps", "thumbnail", "xmp", "iptc", "photoshop", "icc", "c2pa", "comment", "other"];

export const PRESETS = {
  all: "every removable metadata field, including the ICC profile and C2PA",
  privacy: "location, serial numbers, names, comments, thumbnails and other identifying fields",
} as const;

const GROUP_ALIASES: Record<string, FieldGroup> = { comments: "comment", text: "comment", thumbnails: "thumbnail", location: "gps", "content-credentials": "c2pa" };

export interface Resolution {
  /** Field ids to remove, after expanding block-level and group-level removals. */
  readonly ids: ReadonlySet<string>;
  /** Selectors that matched nothing (groups and globs that matched nothing are not listed). */
  readonly unmatched: readonly string[];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchOne(fields: readonly MetadataField[], selector: string): { matched: MetadataField[]; strict: boolean } {
  const s = selector.trim();
  const lower = s.toLowerCase();
  const removable = fields.filter((f) => f.removal !== "none");
  if (lower === "all") return { matched: removable, strict: false };
  if (lower === "privacy") {
    // Content Credentials and the color profile are never "privacy" removals: one is provenance the user may
    // want to keep (it can only go as a whole), the other changes how the picture looks.
    return {
      matched: removable.filter((f) => f.group !== "c2pa" && f.group !== "icc" && (f.sensitive || f.group === "gps" || f.group === "thumbnail" || f.group === "comment")),
      strict: false,
    };
  }
  const group = (GROUPS as readonly string[]).includes(lower) ? (lower as FieldGroup) : GROUP_ALIASES[lower];
  if (group) {
    // "exif" and "xmp" mean the whole block, including the GPS properties that are grouped separately for display.
    if (group === "exif" || group === "xmp") return { matched: removable.filter((f) => f.id.startsWith(`${group}:`)), strict: false };
    if (group === "c2pa") return { matched: removable.filter((f) => f.group === "c2pa" || f.id === XMP_PROVENANCE_ID), strict: false };
    return { matched: removable.filter((f) => f.group === group), strict: false };
  }
  if (s.includes("*") || s.includes("?")) {
    const re = globToRegExp(s);
    return { matched: removable.filter((f) => re.test(f.id)), strict: false };
  }
  if (s.includes(":")) return { matched: removable.filter((f) => f.id.toLowerCase() === lower), strict: true };
  return { matched: removable.filter((f) => f.name.toLowerCase() === lower), strict: true };
}

interface Index {
  readonly byId: ReadonlyMap<string, MetadataField>;
  /** Fields per (group, block) pair: what "block" and "group" removals take along. */
  readonly byGroupBlock: ReadonlyMap<string, MetadataField[]>;
}

function indexFields(fields: readonly MetadataField[]): Index {
  const byId = new Map<string, MetadataField>();
  const byGroupBlock = new Map<string, MetadataField[]>();
  for (const f of fields) {
    byId.set(f.id, f);
    for (const blockId of f.blockIds) {
      const key = `${f.group}\u0000${blockId}`;
      const list = byGroupBlock.get(key);
      if (list) list.push(f);
      else byGroupBlock.set(key, [f]);
    }
  }
  return { byId, byGroupBlock };
}

/** Fields that go together with `field` because they share its block or its group (thumbnail IFD). */
function companions(index: Index, field: MetadataField): MetadataField[] {
  if (field.removal === "block") {
    const seen = new Set<MetadataField>();
    for (const blockId of field.blockIds) for (const f of index.byGroupBlock.get(`${field.group}\u0000${blockId}`) ?? []) seen.add(f);
    return [...seen];
  }
  if (field.removal === "group") return index.byGroupBlock.get(`${field.group}\u0000${field.blockIds[0]}`) ?? [field];
  return [field];
}

export function resolveSelectors(fields: readonly MetadataField[], selectors: readonly string[]): Resolution {
  const index = indexFields(fields);
  const include = new Set<string>();
  const exclude = new Set<string>();
  const unmatched: string[] = [];
  for (const raw of selectors) {
    if (!raw.trim()) continue;
    const negative = raw.startsWith("!") || raw.startsWith("-");
    const selector = negative ? raw.slice(1) : raw;
    const { matched, strict } = matchOne(fields, selector);
    if (matched.length === 0 && strict && !negative) {
      const lower = selector.toLowerCase();
      const exists = fields.find((f) => f.id.toLowerCase() === lower || f.name.toLowerCase() === lower);
      if (exists && exists.removal === "none") throw new ImgwandError("NOT_REMOVABLE", `${exists.id} cannot be removed`);
      unmatched.push(raw);
    }
    for (const f of matched) (negative ? exclude : include).add(f.id);
  }
  // Excluding part of something that can only be removed as a whole keeps the whole thing.
  for (const id of include) {
    const group = companions(index, index.byId.get(id)!);
    if (group.some((g) => exclude.has(g.id))) for (const g of group) exclude.add(g.id);
  }
  const ids = new Set<string>();
  for (const id of include) {
    if (exclude.has(id)) continue;
    for (const f of companions(index, index.byId.get(id)!)) if (!exclude.has(f.id)) ids.add(f.id);
  }
  return { ids, unmatched };
}

/** Suggests field ids close to an unknown selector, for error messages. */
export function suggest(fields: readonly MetadataField[], selector: string): string[] {
  const needle = selector.toLowerCase().replace(/^.*:/, "");
  return fields.filter((f) => f.id.toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle)).slice(0, 5).map((f) => f.id);
}
