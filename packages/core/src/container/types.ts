export type ImageFormat = "jpeg" | "png" | "webp";

/**
 * What a block of the file holds. "structure" blocks carry the picture itself or information needed to decode it
 * (JPEG SOF/DHT/SOS + scan data, PNG IHDR/IDAT, WebP VP8*) and are never modified.
 */
export type BlockKind =
  | "exif"
  | "xmp"
  | "xmp-extended"
  | "iptc"
  | "icc"
  | "c2pa"
  | "jumbf"
  | "comment"
  | "text"
  | "mpf"
  | "other"
  | "structure";

export interface Block {
  /** Position of the block in the file (0-based, in file order). Stable for a given parse. */
  readonly id: number;
  readonly kind: BlockKind;
  /** Container-level name, e.g. "APP1", "COM", "eXIf", "iTXt", "XMP ". */
  readonly name: string;
  /** Byte offset of the whole block (marker/chunk header included) in the file. */
  readonly offset: number;
  /** The whole block exactly as stored in the file. */
  readonly raw: Uint8Array;
  /** The metadata payload without container framing (TIFF bytes for EXIF, XML text for XMP, ...). */
  readonly payload: Uint8Array;
  /** Format-specific details: PNG text keyword, ICC chunk sequence, JUMBF box instance, ... */
  readonly info: Readonly<Record<string, string | number | boolean>>;
}

export interface Container {
  readonly format: ImageFormat;
  readonly mimeType: string;
  readonly blocks: readonly Block[];
  /** Total size of the parsed file. */
  readonly size: number;
}

/** A change to one block. Blocks without an edit are copied through byte for byte. */
export type BlockEdit =
  | { readonly id: number; readonly action: "remove" }
  | { readonly id: number; readonly action: "replace"; readonly payload: Uint8Array };

/** A metadata block to add to the file (used when creating metadata that does not exist yet). */
export interface BlockInsert {
  readonly kind: "exif" | "xmp" | "iptc" | "comment";
  readonly payload: Uint8Array;
}

export interface ContainerCodec {
  readonly format: ImageFormat;
  readonly mimeType: string;
  /** Cheap signature check on the first bytes. */
  matches(bytes: Uint8Array): boolean;
  parse(bytes: Uint8Array): Container;
  /** Re-serializes the container with the edits applied. Must not touch any block that is not edited. */
  rebuild(container: Container, edits: readonly BlockEdit[], inserts?: readonly BlockInsert[]): Uint8Array;
}
