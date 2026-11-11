import { ImgwandError } from "../errors.js";
import type { Block } from "../container/types.js";
import { emptyResult, type EditResult, type Handler, type MetadataField } from "../fields.js";
import { decodeText, formatBytes, latin1, readU16BE, utf8 } from "../util/bytes.js";

/**
 * Comments (JPEG COM, PNG text chunks) and everything else that is metadata but has no richer model: vendor APPn
 * segments, PNG tIME, non-C2PA JUMBF boxes, unknown ancillary chunks.
 */

function preview(bytes: Uint8Array): string {
  const printable = bytes.length > 0 && bytes.subarray(0, 200).every((c) => c === 9 || c === 10 || c === 13 || (c >= 0x20 && c < 0x7f));
  if (printable) {
    const text = latin1(bytes, 0, Math.min(bytes.length, 120));
    return bytes.length > 120 ? `${text}…` : text;
  }
  return `(${formatBytes(bytes.length)})`;
}

function vendorSignature(block: Block): string {
  // Many APPn segments start with a NUL-terminated identifier ("Ducky", "Meta", "FPXR").
  const body = block.payload.subarray(0, 32);
  const nul = body.indexOf(0);
  const id = latin1(body, 0, nul > 0 ? nul : 0);
  return /^[\x20-\x7e]{2,}$/.test(id) ? id : "";
}

function pngTime(data: Uint8Array): string {
  if (data.length < 7) return preview(data);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${readU16BE(data, 0)}-${p(data[2]!)}-${p(data[3]!)} ${p(data[4]!)}:${p(data[5]!)}:${p(data[6]!)} UTC`;
}

function uniqueIds(fields: MetadataField[]): MetadataField[] {
  const seen = new Map<string, number>();
  return fields.map((f) => {
    const n = (seen.get(f.id) ?? 0) + 1;
    seen.set(f.id, n);
    return n > 1 ? { ...f, id: `${f.id}#${n}` } : f;
  });
}

export const miscHandler: Handler = {
  kinds: ["comment", "text", "other", "jumbf"],
  owns: (id) => id.startsWith("comment:") || id.startsWith("png:") || id.startsWith("other:"),

  fields(ctx) {
    const out: MetadataField[] = [];
    for (const block of ctx.container.blocks) {
      if (block.kind === "comment") {
        out.push({ id: "comment:COM", group: "comment", section: "Comments", name: "Comment", value: decodeText(block.payload), removal: "field", writable: true, sensitive: true, blockIds: [block.id] });
      } else if (block.kind === "text") {
        const keyword = String(block.info.keyword);
        const legacy = keyword.startsWith("Raw profile type ");
        out.push({
          id: `png:${keyword}`,
          group: "comment",
          section: "PNG Text",
          name: keyword,
          value: legacy ? `(${formatBytes(block.payload.length)} ${keyword.slice(17).toUpperCase()} data written by ImageMagick)` : decodeText(block.payload),
          removal: "field",
          writable: !legacy,
          sensitive: true,
          blockIds: [block.id],
        });
      } else if (block.kind === "other" || block.kind === "jumbf") {
        const vendor = block.kind === "jumbf" ? "JUMBF" : vendorSignature(block);
        const isTime = block.name === "tIME";
        out.push({
          id: `other:${block.name.trim()}`,
          group: "other",
          section: "Other",
          name: vendor ? `${block.name.trim()} (${vendor})` : block.name.trim(),
          value: isTime ? pngTime(block.payload) : `${formatBytes(block.raw.length)}${vendor ? "" : `: ${preview(block.payload)}`}`,
          removal: "field",
          writable: false,
          sensitive: isTime,
          blockIds: [block.id],
        });
      }
    }
    return uniqueIds(out);
  },

  edit(ctx, fields, request): EditResult {
    const result = emptyResult();
    const owns = (id: string) => id.startsWith("comment:") || id.startsWith("png:") || id.startsWith("other:");
    const byId = new Map(fields.map((f) => [f.id, f]));
    for (const id of request.remove) {
      if (!owns(id)) continue;
      const field = byId.get(id);
      if (field) for (const blockId of field.blockIds) result.edits.push({ id: blockId, action: "remove" });
    }
    for (const [id, value] of request.set) {
      if (!owns(id)) continue;
      if (id.startsWith("other:")) throw new ImgwandError("NOT_WRITABLE", `${id} is not writable`);
      const field = byId.get(id);
      if (field) {
        if (!field.writable) throw new ImgwandError("NOT_WRITABLE", `${id} is not writable`);
        result.edits.push({ id: field.blockIds[0]!, action: "replace", payload: utf8(value) });
      } else if (id === "comment:COM" || id === "png:Comment") {
        const fitting = ctx.container.format === "jpeg" ? "comment:COM" : ctx.container.format === "png" ? "png:Comment" : undefined;
        if (id !== fitting) {
          throw new ImgwandError("NOT_WRITABLE", `${id} does not apply to ${ctx.container.format.toUpperCase()} files (${fitting ? `use ${fitting}` : "the format has no comment field; use xmp:dc:description"})`);
        }
        result.inserts.push({ kind: "comment", payload: utf8(value) });
      } else {
        throw new ImgwandError("UNKNOWN_FIELD", `${id} does not exist; only comment:COM (JPEG) and png:Comment (PNG) can be created`);
      }
      result.handledSets.push(id);
    }
    return result;
  },
};
