import type { BlockEdit, BlockInsert, BlockKind, Container } from "./container/types.js";

/** UI/grouping families. GPS is split out of EXIF because it is what people most often want gone. */
export type FieldGroup = "exif" | "gps" | "thumbnail" | "xmp" | "iptc" | "photoshop" | "icc" | "c2pa" | "comment" | "other";

/**
 * How a field is removed:
 *  - "field": just this field.
 *  - "group": together with related fields (named in `note`), e.g. a thumbnail's IFD.
 *  - "block": together with the whole block it lives in (ICC profile, C2PA manifest store).
 *  - "none": cannot be removed on its own.
 */
export type Removal = "field" | "group" | "block" | "none";

export interface MetadataField {
  /** Stable, selector-friendly id, e.g. "exif:GPS:GPSLatitude", "xmp:dc:creator", "iptc:Keywords". */
  readonly id: string;
  readonly group: FieldGroup;
  /** Sub-heading within the group, e.g. "IFD0", "ExifIFD", "dc", "IPTC", "Manifest". */
  readonly section: string;
  readonly name: string;
  /** Human-readable value. */
  readonly value: string;
  /** Machine-readable value, when there is a natural one. */
  readonly raw?: unknown;
  readonly removal: Removal;
  /** Whether `set` can change this field. */
  readonly writable: boolean;
  /** Location, identifiers, names or free text: candidates for the "privacy" preset. */
  readonly sensitive: boolean;
  /** Extra context shown with the field (side effects of removing it, etc). */
  readonly note?: string;
  readonly blockIds: readonly number[];
}

/** Everything a handler needs to know about the file. */
export interface HandlerContext {
  readonly container: Container;
}

export interface EditRequest {
  /** Ids of fields to remove (already resolved from selectors). */
  readonly remove: ReadonlySet<string>;
  /** New values by field id. Ids that do not exist yet are created when the handler knows how. */
  readonly set: ReadonlyMap<string, string>;
}

export interface EditResult {
  readonly edits: BlockEdit[];
  readonly inserts: BlockInsert[];
  /** Ids from `set` this handler took care of. */
  readonly handledSets: string[];
}

/** One metadata family: turns blocks into fields and field edits into block edits. */
export interface Handler {
  readonly kinds: readonly BlockKind[];
  fields(ctx: HandlerContext): MetadataField[];
  /** Whether this handler owns a field id prefix (used to route `set` for fields that do not exist yet). */
  owns(id: string): boolean;
  edit(ctx: HandlerContext, fields: readonly MetadataField[], request: EditRequest): EditResult;
}

export function emptyResult(): EditResult {
  return { edits: [], inserts: [], handledSets: [] };
}
