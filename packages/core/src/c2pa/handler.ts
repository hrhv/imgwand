import { ImgwandError } from "../errors.js";
import { emptyResult, type EditResult, type Handler, type MetadataField } from "../fields.js";
import { formatBytes } from "../util/bytes.js";
import { XMP_PROVENANCE_ID } from "../xmp/handler.js";

/**
 * Container-level view of C2PA: the embedded manifest store as one removable unit. The detailed, async view
 * (manifests, signer, validation) comes from ./c2pa.ts and is merged in by readMetadata().
 */

export const C2PA_STORE_ID = "c2pa:ManifestStore";
export const C2PA_NOTE =
  "A C2PA manifest store is signed as a whole: it can be removed entirely, or re-signed with redactions, but not edited field by field";

export const c2paHandler: Handler = {
  kinds: ["c2pa"],
  owns: (id) => id.startsWith("c2pa:"),

  fields(ctx) {
    const blocks = ctx.container.blocks.filter((b) => b.kind === "c2pa");
    if (blocks.length === 0) return [];
    const size = blocks.reduce((n, b) => n + b.raw.length, 0);
    const field: MetadataField = {
      id: C2PA_STORE_ID,
      group: "c2pa",
      section: "Manifest Store",
      name: "Manifest Store",
      value: `Embedded C2PA manifest store (${formatBytes(size)} in ${blocks.length} ${blocks.length === 1 ? "block" : "blocks"})`,
      removal: "block",
      writable: false,
      sensitive: false,
      note: C2PA_NOTE,
      blockIds: blocks.map((b) => b.id),
    };
    return [field];
  },

  edit(ctx, _fields, request): EditResult {
    const result = emptyResult();
    if ([...request.set.keys()].some((id) => id.startsWith("c2pa:"))) {
      throw new ImgwandError("NOT_WRITABLE", "C2PA fields cannot be set directly; sign a new manifest instead (signC2pa)");
    }
    if ([...request.remove].some((id) => id.startsWith("c2pa:"))) {
      for (const b of ctx.container.blocks) if (b.kind === "c2pa") result.edits.push({ id: b.id, action: "remove" });
    }
    return result;
  },
};

/** Removing the manifest store should also remove the XMP pointer to a remote copy of it. */
export const C2PA_RELATED_IDS = [XMP_PROVENANCE_ID];
