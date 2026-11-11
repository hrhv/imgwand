import { readC2pa, c2paFields, type C2paReadOptions, type C2paReport } from "./c2pa/c2pa.js";
import { c2paHandler } from "./c2pa/handler.js";
import { codecFor, parseContainer, samePicture, type BlockEdit, type BlockInsert, type BlockKind, type Container, type ImageFormat } from "./container/index.js";
import { ImgwandError } from "./errors.js";
import { exifHandler } from "./exif/handler.js";
import type { EditRequest, Handler, MetadataField } from "./fields.js";
import { iccHandler } from "./icc/handler.js";
import { iptcHandler } from "./iptc/handler.js";
import { miscHandler } from "./misc/handler.js";
import { resolveSelectors, suggest } from "./selectors.js";
import { xmpHandler } from "./xmp/handler.js";

export const HANDLERS: readonly Handler[] = [exifHandler, xmpHandler, iptcHandler, iccHandler, c2paHandler, miscHandler];

export interface BlockSummary {
  readonly id: number;
  readonly kind: BlockKind;
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export interface MetadataReport {
  readonly format: ImageFormat;
  readonly mimeType: string;
  readonly size: number;
  readonly fields: readonly MetadataField[];
  readonly blocks: readonly BlockSummary[];
  /** Detailed C2PA view; null when the file has no manifest store (or C2PA reading was turned off). */
  readonly c2pa: C2paReport | null;
  readonly warnings: readonly string[];
}

export interface ReadOptions {
  /** Read the C2PA manifest store with the C2PA SDK (default true). */
  readonly c2pa?: boolean;
  readonly c2paOptions?: C2paReadOptions;
}

function summarizeBlocks(container: Container): BlockSummary[] {
  return container.blocks.map((b) => ({ id: b.id, kind: b.kind, name: b.name, offset: b.offset, size: b.raw.length }));
}

/** Container-level fields, synchronously and without the C2PA SDK. */
export function inspect(bytes: Uint8Array): { container: Container; fields: MetadataField[] } {
  const container = parseContainer(bytes);
  const fields = HANDLERS.flatMap((h) => h.fields({ container }));
  return { container, fields };
}

/** Reads every metadata field of an image, including a validated view of its C2PA manifest store. */
export async function readMetadata(bytes: Uint8Array, options: ReadOptions = {}): Promise<MetadataReport> {
  const { container, fields } = inspect(bytes);
  const warnings: string[] = [];
  let c2pa: C2paReport | null = null;
  const c2paBlocks = container.blocks.filter((b) => b.kind === "c2pa");
  let all = fields;
  if (options.c2pa !== false && c2paBlocks.length > 0) {
    try {
      c2pa = await readC2pa(bytes, container.mimeType, options.c2paOptions);
      if (c2pa) all = [...fields, ...c2paFields(c2pa, c2paBlocks.map((b) => b.id))];
    } catch (error) {
      warnings.push(`C2PA: ${(error as Error).message}`);
    }
  }
  return { format: container.format, mimeType: container.mimeType, size: bytes.length, fields: all, blocks: summarizeBlocks(container), c2pa, warnings };
}

export interface EditOptions {
  /** Selectors of fields to remove (see resolveSelectors). */
  readonly remove?: readonly string[];
  /** New values by field id; missing fields are created where the format allows it. */
  readonly set?: Readonly<Record<string, string>>;
}

export interface EditOutcome {
  readonly bytes: Uint8Array;
  readonly changed: boolean;
  /** Fields that are gone afterwards. */
  readonly removed: readonly MetadataField[];
  /** Field ids that were set or created. */
  readonly updated: readonly string[];
  readonly warnings: readonly string[];
  /**
   * True when the file had a C2PA manifest store that survived the edit. Any change to the file breaks the
   * store's hard binding, so it will no longer validate; remove it as well, or re-sign (signC2pa).
   */
  readonly c2paInvalidated: boolean;
}

function dedupe(edits: BlockEdit[]): BlockEdit[] {
  const byId = new Map<number, BlockEdit>();
  for (const e of edits) {
    const prev = byId.get(e.id);
    if (!prev || e.action === "remove") byId.set(e.id, e);
  }
  return [...byId.values()];
}

/**
 * Removes and sets metadata fields without touching the picture. The result is verified: every block holding
 * the picture must come out byte-identical, otherwise the edit is refused (VERIFY_FAILED).
 */
export function editMetadata(bytes: Uint8Array, options: EditOptions): EditOutcome {
  const { container, fields } = inspect(bytes);
  // C2PA detail fields are not part of the container view, but selecting them means removing the store.
  const selectors = (options.remove ?? []).map((s) => (/^!?-?c2pa:/i.test(s) && !fields.some((f) => f.id.toLowerCase() === s.toLowerCase()) ? s.replace(/c2pa:.*/i, "c2pa") : s));
  const { ids, unmatched } = resolveSelectors(fields, selectors);
  if (unmatched.length > 0) {
    const hints = unmatched.flatMap((u) => suggest(fields, u));
    throw new ImgwandError("UNKNOWN_FIELD", `No such field: ${unmatched.join(", ")}${hints.length ? ` (did you mean ${hints.join(", ")}?)` : ""}`);
  }
  const set = new Map(Object.entries(options.set ?? {}));
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const id of set.keys()) {
    const field = byId.get(id);
    if (field && !field.writable) throw new ImgwandError("NOT_WRITABLE", `${id} is not writable`);
    if (ids.has(id)) throw new ImgwandError("INVALID_VALUE", `${id} is both removed and set`);
  }

  const request: EditRequest = { remove: ids, set };
  const edits: BlockEdit[] = [];
  const inserts: BlockInsert[] = [];
  const handled = new Set<string>();
  for (const handler of HANDLERS) {
    const result = handler.edit({ container }, fields, request);
    edits.push(...result.edits);
    inserts.push(...result.inserts);
    for (const id of result.handledSets) handled.add(id);
  }
  const unhandled = [...set.keys()].filter((id) => !handled.has(id));
  if (unhandled.length > 0) throw new ImgwandError("UNKNOWN_FIELD", `Don't know how to set ${unhandled.join(", ")}`);

  const finalEdits = dedupe(edits);
  if (finalEdits.length === 0 && inserts.length === 0) {
    return { bytes, changed: false, removed: [], updated: [], warnings: [], c2paInvalidated: false };
  }
  const output = codecFor(container.format).rebuild(container, finalEdits, inserts);
  const after = parseContainer(output);
  if (!samePicture(container, after)) {
    throw new ImgwandError("VERIFY_FAILED", "Refusing to write: the edit would have changed the picture data (this is a bug, please report it)");
  }

  // Every handler either removes what it was asked to or throws, so the request is the answer. (Comparing ids
  // before and after would be wrong when a file has several blocks of one kind: ids are positional.)
  const removed = fields.filter((f) => ids.has(f.id));
  const warnings: string[] = [];
  const c2paBlocks = container.blocks.filter((b) => b.kind === "c2pa");
  const c2paRemoved = c2paBlocks.length > 0 && c2paBlocks.every((b) => finalEdits.some((e) => e.id === b.id && e.action === "remove"));
  const c2paInvalidated = c2paBlocks.length > 0 && !c2paRemoved;
  if (c2paInvalidated) warnings.push("The C2PA manifest store no longer matches the file and will fail validation; remove it too (c2pa) or re-sign it");
  if (removed.some((f) => f.id === "exif:IFD0:Orientation")) warnings.push("Orientation was removed: viewers may now show the image rotated");
  if (removed.some((f) => f.group === "icc")) warnings.push("The ICC profile was removed: colors may look different unless the image is sRGB");
  return { bytes: output, changed: true, removed, updated: [...set.keys()], warnings, c2paInvalidated };
}

/** Removes the fields matched by the selectors and returns the new file. */
export function removeMetadata(bytes: Uint8Array, selectors: readonly string[]): Uint8Array {
  return editMetadata(bytes, { remove: selectors }).bytes;
}

/** Sets (or creates) fields and returns the new file. */
export function setMetadata(bytes: Uint8Array, values: Readonly<Record<string, string>>): Uint8Array {
  return editMetadata(bytes, { set: values }).bytes;
}

/** Removes the embedded C2PA manifest store (and the XMP pointer to a remote one). */
export function removeC2pa(bytes: Uint8Array): Uint8Array {
  return removeMetadata(bytes, ["c2pa"]);
}

export interface StripOptions {
  /** Keep the ICC profile so colors stay the same (default true). */
  readonly keepIcc?: boolean;
  /** Keep the EXIF Orientation tag so the image stays upright (default true). */
  readonly keepOrientation?: boolean;
  /** Keep the C2PA manifest store (default false). Note that stripping anything else invalidates it. */
  readonly keepC2pa?: boolean;
}

/** Removes all metadata, by default keeping what affects how the picture looks (ICC profile, Orientation). */
export function stripAll(bytes: Uint8Array, options: StripOptions = {}): EditOutcome {
  const selectors = ["all"];
  if (options.keepIcc !== false) selectors.push("!icc");
  if (options.keepOrientation !== false) selectors.push("!exif:IFD0:Orientation");
  if (options.keepC2pa) selectors.push("!c2pa");
  return editMetadata(bytes, { remove: selectors });
}

export type { C2paReport };
