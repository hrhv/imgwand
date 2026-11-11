import { createHash } from "node:crypto";
import { ImgwandError } from "../errors.js";
import type { Block } from "../container/types.js";
import { emptyResult, type EditResult, type Handler, type HandlerContext, type MetadataField } from "../fields.js";
import { concatBytes, decodeText, formatBytes, hex, latin1, readU16BE, readU32BE, utf8, writeU16BE, writeU32BE } from "../util/bytes.js";

/**
 * Photoshop Image Resource Blocks (JPEG APP13 "Photoshop 3.0"), including the IPTC-IIM record they carry
 * (resource 0x0404). IPTC datasets become individual fields; other resources are listed by name.
 */

export interface Resource {
  signature: string;
  id: number;
  /** The Pascal-string name as stored (copied back unchanged; Photoshop names are not reliably UTF-8). */
  nameBytes: Uint8Array;
  data: Uint8Array;
}

export interface Irb {
  resources: Resource[];
  /** Bytes after the last parseable resource, written back unchanged. */
  tail: Uint8Array;
}

export interface Dataset {
  record: number;
  dataset: number;
  data: Uint8Array;
}

const RESOURCE_NAMES: Record<number, string> = {
  0x03e8: "Photoshop2Info", 0x03e9: "MacintoshPrintInfo", 0x03ed: "ResolutionInfo", 0x03ee: "AlphaChannelsNames", 0x03f0: "Caption",
  0x03f1: "BorderInfo", 0x03f2: "BackgroundColor", 0x03f3: "PrintFlags", 0x03f4: "GrayscaleHalftoningInfo", 0x03f5: "ColorHalftoningInfo",
  0x03f6: "DuotoneHalftoningInfo", 0x03f7: "GrayscaleTransferFunc", 0x03f8: "ColorTransferFuncs", 0x03f9: "DuotoneTransferFuncs",
  0x03fa: "DuotoneImageInfo", 0x03fb: "EffectiveBW", 0x03fd: "EPSOptions", 0x03fe: "QuickMaskInfo", 0x0400: "TargetLayerID",
  0x0401: "WorkingPath", 0x0402: "LayersGroupInfo", 0x0404: "IPTC-NAA", 0x0405: "RawImageMode", 0x0406: "JPEG_Quality",
  0x0408: "GridGuidesInfo", 0x0409: "PhotoshopBGRThumbnail", 0x040a: "CopyrightFlag", 0x040b: "URL", 0x040c: "PhotoshopThumbnail",
  0x040d: "GlobalAngle", 0x040e: "ColorSamplersResource", 0x040f: "ICC_Profile", 0x0410: "Watermark", 0x0411: "ICC_Untagged",
  0x0412: "EffectsVisible", 0x0413: "SpotHalftone", 0x0414: "IDsBaseValue", 0x0415: "UnicodeAlphaNames", 0x0416: "IndexedColorTableCount",
  0x0417: "TransparentIndex", 0x0419: "GlobalAltitude", 0x041a: "SliceInfo", 0x041b: "WorkflowURL", 0x041c: "JumpToXPEP",
  0x041d: "AlphaIdentifiers", 0x041e: "URL_List", 0x0421: "VersionInfo", 0x0422: "EXIFInfo", 0x0423: "ExifInfo2", 0x0424: "XMP",
  0x0425: "IPTCDigest", 0x0426: "PrintScaleInfo", 0x0428: "PixelInfo", 0x0429: "LayerComps", 0x042a: "AlternateDuotoneColors",
  0x042b: "AlternateSpotColors", 0x042d: "LayerSelectionIDs", 0x042e: "HDRToningInfo", 0x042f: "PrintInfo", 0x0430: "LayerGroupsEnabledID",
  0x0431: "ColorSamplersResource2", 0x0432: "MeasurementScale", 0x0433: "TimelineInfo", 0x0434: "SheetDisclosure", 0x0435: "DisplayInfo",
  0x0436: "OnionSkins", 0x0438: "CountInfo", 0x043a: "PrintInfo2", 0x043b: "PrintStyle", 0x043c: "MacNSPrintInfo", 0x043d: "WinDEVMODE",
  0x043e: "AutoSaveFilePath", 0x043f: "AutoSaveFormat", 0x0440: "PathSelectionState", 0x0bb7: "ClippingPathName", 0x0bb8: "OriginPathInfo",
  0x1b58: "ImageReadyVariables", 0x1b59: "ImageReadyDataSets", 0x2710: "PrintFlagsInfo",
};

const ENVELOPE: Record<number, string> = {
  0: "EnvelopeRecordVersion", 5: "Destination", 20: "FileFormat", 22: "FileVersion", 30: "ServiceIdentifier", 40: "EnvelopeNumber",
  50: "ProductID", 60: "EnvelopePriority", 70: "DateSent", 80: "TimeSent", 90: "CodedCharacterSet", 100: "UniqueObjectName",
};

const APPLICATION: Record<number, string> = {
  0: "ApplicationRecordVersion", 3: "ObjectTypeReference", 4: "ObjectAttributeReference", 5: "ObjectName", 7: "EditStatus", 10: "Urgency",
  12: "SubjectReference", 15: "Category", 20: "SupplementalCategories", 22: "FixtureIdentifier", 25: "Keywords", 26: "ContentLocationCode",
  27: "ContentLocationName", 30: "ReleaseDate", 35: "ReleaseTime", 37: "ExpirationDate", 38: "ExpirationTime", 40: "SpecialInstructions",
  42: "ActionAdvised", 45: "ReferenceService", 47: "ReferenceDate", 50: "ReferenceNumber", 55: "DateCreated", 60: "TimeCreated",
  62: "DigitalCreationDate", 63: "DigitalCreationTime", 65: "OriginatingProgram", 70: "ProgramVersion", 75: "ObjectCycle", 80: "By-line",
  85: "By-lineTitle", 90: "City", 92: "Sub-location", 95: "Province-State", 100: "Country-PrimaryLocationCode",
  101: "Country-PrimaryLocationName", 103: "OriginalTransmissionReference", 105: "Headline", 110: "Credit", 115: "Source",
  116: "CopyrightNotice", 118: "Contact", 120: "Caption-Abstract", 121: "LocalCaption", 122: "Writer-Editor", 130: "ImageType",
  131: "ImageOrientation", 135: "LanguageIdentifier", 184: "JobID", 221: "Prefs", 228: "ClassifyState", 230: "DocumentNotes",
  231: "DocumentHistory",
};

const REPEATABLE = new Set([12, 20, 25, 26, 27, 80, 85, 118, 122]);
const SENSITIVE = new Set([40, 80, 85, 90, 92, 95, 100, 101, 118, 120, 122]);
const BINARY = new Set(["1:0", "1:20", "1:22", "2:0"]);
const UTF8_MARKER = Uint8Array.of(0x1b, 0x25, 0x47); // ESC % G

export function parseIrb(data: Uint8Array): Irb {
  const resources: Resource[] = [];
  let pos = 0; // the "Photoshop 3.0\0" header is already stripped by the container
  while (pos + 12 <= data.length) {
    const signature = latin1(data, pos, pos + 4);
    if (!/^(8BIM|MeSa|PHUT|AgHg|DCSR)$/.test(signature)) break;
    const id = readU16BE(data, pos + 4);
    const nameLength = data[pos + 6]!;
    const nameField = 1 + nameLength + ((1 + nameLength) & 1);
    const sizeAt = pos + 6 + nameField;
    if (sizeAt + 4 > data.length) break;
    const size = readU32BE(data, sizeAt);
    const start = sizeAt + 4;
    if (start + size > data.length) throw new ImgwandError("CORRUPT_FILE", `Corrupt Photoshop resource ${hex(id)}: runs past the end of the block`);
    resources.push({ signature, id, nameBytes: data.subarray(pos + 7, pos + 7 + nameLength), data: data.subarray(start, start + size) });
    pos = Math.min(data.length, start + size + (size & 1));
  }
  return { resources, tail: data.subarray(pos) };
}

export function parseResources(data: Uint8Array): Resource[] {
  return parseIrb(data).resources;
}

export function serializeResources(resources: readonly Resource[], tail: Uint8Array = new Uint8Array(0)): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const r of resources) {
    const nameBytes = r.nameBytes.subarray(0, 255);
    const nameField = new Uint8Array(1 + nameBytes.length + ((1 + nameBytes.length) & 1));
    nameField[0] = nameBytes.length;
    nameField.set(nameBytes, 1);
    const header = new Uint8Array(6);
    header.set(utf8(r.signature), 0);
    writeU16BE(header, 4, r.id);
    const size = new Uint8Array(4);
    writeU32BE(size, 0, r.data.length);
    parts.push(header, nameField, size, r.data);
    if (r.data.length & 1) parts.push(new Uint8Array(1));
  }
  parts.push(tail);
  return concatBytes(parts);
}

export function parseDatasets(data: Uint8Array): Dataset[] {
  const out: Dataset[] = [];
  let pos = 0;
  while (pos + 5 <= data.length) {
    if (data[pos] !== 0x1c) break; // trailing padding
    const record = data[pos + 1]!;
    const dataset = data[pos + 2]!;
    let size = readU16BE(data, pos + 3);
    let start = pos + 5;
    if (size & 0x8000) {
      // Extended dataset: the low 15 bits give the number of bytes holding the real length.
      const n = size & 0x7fff;
      if (n > 4 || start + n > data.length) throw new ImgwandError("CORRUPT_FILE", "Corrupt IPTC extended dataset length");
      size = 0;
      for (let i = 0; i < n; i++) size = size * 256 + data[start + i]!;
      start += n;
    }
    if (start + size > data.length) throw new ImgwandError("CORRUPT_FILE", `Corrupt IPTC dataset ${record}:${dataset}: runs past the end`);
    out.push({ record, dataset, data: data.subarray(start, start + size) });
    pos = start + size;
  }
  return out;
}

export function serializeDatasets(datasets: readonly Dataset[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const d of datasets) {
    if (d.data.length < 0x8000) {
      const header = Uint8Array.of(0x1c, d.record, d.dataset, 0, 0);
      writeU16BE(header, 3, d.data.length);
      parts.push(header, d.data);
    } else {
      const header = Uint8Array.of(0x1c, d.record, d.dataset, 0x80, 0x04, 0, 0, 0, 0);
      writeU32BE(header, 5, d.data.length);
      parts.push(header, d.data);
    }
  }
  return concatBytes(parts);
}

function datasetName(record: number, dataset: number): string {
  const table = record === 1 ? ENVELOPE : record === 2 ? APPLICATION : {};
  return table[dataset] ?? `${record}:${dataset}`;
}

/** Parses "iptc:<Name>" or "iptc:<record>:<dataset>". */
export function parseIptcId(id: string): { record: number; dataset: number } | undefined {
  const numeric = /^iptc:(\d+):(\d+)$/.exec(id);
  if (numeric) return { record: Number(numeric[1]), dataset: Number(numeric[2]) };
  const name = id.slice("iptc:".length);
  for (const [k, v] of Object.entries(APPLICATION)) if (v.toLowerCase() === name.toLowerCase()) return { record: 2, dataset: Number(k) };
  for (const [k, v] of Object.entries(ENVELOPE)) if (v.toLowerCase() === name.toLowerCase()) return { record: 1, dataset: Number(k) };
  return undefined;
}

function iptcId(record: number, dataset: number): string {
  return `iptc:${datasetName(record, dataset)}`;
}

function resourceName(r: Pick<Resource, "id">): string {
  return RESOURCE_NAMES[r.id] ?? (r.id >= 0x07d0 && r.id <= 0x0bb6 ? `PathInfo${r.id - 0x07d0}` : hex(r.id));
}

function describeResource(r: Resource): string {
  switch (r.id) {
    case 0x03ed: {
      if (r.data.length < 16) break;
      const x = readU32BE(r.data, 0) / 65536;
      const y = readU32BE(r.data, 8) / 65536;
      return `${x}x${y} ${readU16BE(r.data, 4) === 2 ? "dpcm" : "dpi"}`;
    }
    case 0x040a:
      return r.data[0] ? "Copyrighted" : "Not copyrighted";
    case 0x040b:
      return decodeText(r.data);
    case 0x0406:
      return r.data.length >= 2 ? `Quality ${readU16BE(r.data, 0)}` : "";
    case 0x0425:
      return [...r.data].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `(${formatBytes(r.data.length)})`;
}

function decodeDataset(d: Dataset): string {
  if (BINARY.has(`${d.record}:${d.dataset}`) && d.data.length === 2) return String(readU16BE(d.data, 0));
  if (d.record === 1 && d.dataset === 90) return latin1(d.data) === "\x1b%G" ? "UTF8" : [...d.data].map((b) => hex(b, 2)).join(" ");
  // Without a UTF-8 declaration (1:90) IIM text is nominally Latin-1, but most writers emit UTF-8 regardless;
  // decodeText reads UTF-8 and falls back to Latin-1 when the bytes are not valid UTF-8, which covers both.
  return decodeText(d.data);
}

function photoshopBlocks(ctx: HandlerContext): Block[] {
  return ctx.container.blocks.filter((b) => b.kind === "iptc");
}

const DIGEST_ID = 0x0425;
const IPTC_ID = 0x0404;

export const iptcHandler: Handler = {
  kinds: ["iptc"],
  owns: (id) => id.startsWith("iptc:") || id.startsWith("photoshop:"),

  fields(ctx) {
    const out: MetadataField[] = [];
    const blocks = photoshopBlocks(ctx);
    for (const block of blocks) {
      // Blocks after the first get a "#<blockId>" suffix, so every id names exactly one block.
      const suffix = block === blocks[0] ? "" : `#${block.id}`;
      let resources: Resource[];
      try {
        resources = parseResources(block.payload);
      } catch (error) {
        out.push({ id: `photoshop:block#${block.id}`, group: "photoshop", section: "Unreadable", name: "Photoshop", value: (error as Error).message, removal: "block", writable: false, sensitive: false, blockIds: [block.id] });
        continue;
      }
      for (const r of resources) {
        if (r.id === IPTC_ID) {
          let datasets: Dataset[];
          try {
            datasets = parseDatasets(r.data);
          } catch (error) {
            out.push({ id: `iptc:record${suffix}`, group: "iptc", section: "Unreadable", name: "IPTC", value: (error as Error).message, removal: "block", writable: false, sensitive: false, blockIds: [block.id] });
            continue;
          }
          const grouped = new Map<string, Dataset[]>();
          for (const d of datasets) {
            const key = `${d.record}:${d.dataset}`;
            grouped.set(key, [...(grouped.get(key) ?? []), d]);
          }
          for (const list of grouped.values()) {
            const { record, dataset } = list[0]!;
            const values = list.map(decodeDataset);
            out.push({
              id: `${iptcId(record, dataset)}${suffix}`,
              group: "iptc",
              section: record === 1 ? "Envelope" : record === 2 ? "Application" : `Record ${record}`,
              name: datasetName(record, dataset),
              value: values.join("; "),
              raw: values.length > 1 ? values : values[0],
              removal: "field",
              writable: record === 2 && !BINARY.has(`${record}:${dataset}`),
              sensitive: record === 2 && SENSITIVE.has(dataset),
              blockIds: [block.id],
            });
          }
        } else {
          const name = resourceName(r);
          out.push({
            id: `photoshop:${name}${suffix}`,
            group: "photoshop",
            section: "Photoshop",
            name,
            value: describeResource(r),
            removal: "field",
            writable: false,
            sensitive: r.id === 0x040c || r.id === 0x0409 || r.id === 0x040b,
            note: r.id === 0x040c || r.id === 0x0409 ? "A preview of the image as it was saved; may show content later cropped out" : undefined,
            blockIds: [block.id],
          });
        }
      }
    }
    // Ids are unique per block; repeated resources inside one block (rare) get a running number.
    const seen = new Map<string, number>();
    return out.map((f) => {
      const n = (seen.get(f.id) ?? 0) + 1;
      seen.set(f.id, n);
      return n > 1 ? { ...f, id: `${f.id}~${n}` } : f;
    });
  },

  edit(ctx, fields, request): EditResult {
    const result = emptyResult();
    const owns = (id: string) => id.startsWith("iptc:") || id.startsWith("photoshop:");
    const removeIds = [...request.remove].filter(owns);
    const setIds = [...request.set.keys()].filter((id) => id.startsWith("iptc:"));
    if ([...request.set.keys()].some((id) => id.startsWith("photoshop:"))) throw new ImgwandError("NOT_WRITABLE", "Photoshop resources are not writable");
    if (removeIds.length === 0 && setIds.length === 0) return result;

    const blocks = photoshopBlocks(ctx);
    // Each removal goes to the block its field came from; sets go to the block that holds IPTC (or the first one).
    const byId = new Map(fields.map((f) => [f.id, f]));
    const removalsFor = new Map<number, string[]>();
    for (const id of removeIds) {
      const field = byId.get(id);
      if (!field) continue;
      const blockId = field.blockIds[0]!;
      removalsFor.set(blockId, [...(removalsFor.get(blockId) ?? []), id]);
    }
    const iptcHome = blocks.find((b) => {
      try {
        return parseResources(b.payload).some((r) => r.id === IPTC_ID);
      } catch {
        return false;
      }
    }) ?? blocks[0];
    const targets = new Set<number | "new">([...removalsFor.keys()]);
    if (setIds.length > 0) targets.add(iptcHome ? iptcHome.id : "new");

    for (const target of targets) {
      const block = target === "new" ? undefined : ctx.container.blocks[target]!;
      const removals = (block && removalsFor.get(block.id)) || [];
      const sets = block === iptcHome || target === "new" ? setIds : [];
      const strip = (id: string) => id.replace(/(#\d+)?(~\d+)?$/, "");
      if (block && removals.some((id) => byId.get(id)?.removal === "block")) {
        result.edits.push({ id: block.id, action: "remove" });
        continue;
      }
      const irb = block ? parseIrb(block.payload) : { resources: [], tail: new Uint8Array(0) };
      let resources = irb.resources.map((r) => ({ ...r }));
      const iptcResource = resources.find((r) => r.id === IPTC_ID);
      let datasets = iptcResource ? parseDatasets(iptcResource.data) : [];
      let iptcChanged = false;

      for (const id of removals) {
        const base = strip(id);
        if (base.startsWith("photoshop:")) {
          const name = base.slice("photoshop:".length);
          const occurrence = Number(/~(\d+)$/.exec(id)?.[1] ?? 1);
          let seen = 0;
          resources = resources.filter((r) => !(resourceName(r) === name && ++seen === occurrence));
          continue;
        }
        const target = parseIptcId(base);
        if (!target) throw new ImgwandError("UNKNOWN_FIELD", `Cannot resolve IPTC field "${id}"`);
        datasets = datasets.filter((d) => !(d.record === target.record && d.dataset === target.dataset));
        iptcChanged = true;
      }
      for (const id of sets) {
        const target = parseIptcId(strip(id));
        if (!target || target.record !== 2) throw new ImgwandError("UNKNOWN_FIELD", `Unknown or read-only IPTC field "${id}"`);
        if (BINARY.has(`2:${target.dataset}`)) throw new ImgwandError("NOT_WRITABLE", `${id} is not writable`);
        const value = request.set.get(id)!;
        const values = REPEATABLE.has(target.dataset) ? value.split(";").map((v) => v.trim()).filter(Boolean) : [value];
        const encoded = values.map((v) => ({ record: 2, dataset: target.dataset, data: utf8(v) }));
        const firstAt = datasets.findIndex((d) => d.record === 2 && d.dataset === target.dataset);
        datasets = datasets.filter((d) => !(d.record === 2 && d.dataset === target.dataset));
        if (firstAt >= 0) datasets.splice(Math.min(firstAt, datasets.length), 0, ...encoded);
        else datasets.push(...encoded);
        // Declare UTF-8 so readers decode the text correctly.
        const nonAscii = values.some((v) => /[^\x00-\x7f]/.test(v));
        if (nonAscii && !datasets.some((d) => d.record === 1 && d.dataset === 90)) datasets.unshift({ record: 1, dataset: 90, data: UTF8_MARKER });
        iptcChanged = true;
      }

      if (iptcChanged) {
        const hasContent = datasets.some((d) => !(d.record === 2 && d.dataset === 0) && !(d.record === 1 && d.dataset === 90));
        if (!hasContent) {
          resources = resources.filter((r) => r.id !== IPTC_ID && r.id !== DIGEST_ID);
        } else {
          const iptcData = serializeDatasets(datasets);
          const at = resources.findIndex((r) => r.id === IPTC_ID);
          if (at >= 0) resources[at] = { ...resources[at]!, data: iptcData };
          else resources.push({ signature: "8BIM", id: IPTC_ID, nameBytes: new Uint8Array(0), data: iptcData });
          // Keep Photoshop's IPTC digest consistent, otherwise it treats the IPTC data as stale.
          const digest = resources.findIndex((r) => r.id === DIGEST_ID);
          if (digest >= 0) resources[digest] = { ...resources[digest]!, data: createHash("md5").update(iptcData).digest() };
        }
      }
      if (resources.length === 0 && irb.tail.length === 0) {
        if (block) result.edits.push({ id: block.id, action: "remove" });
        continue;
      }
      const payload = serializeResources(resources, irb.tail);
      if (block) result.edits.push({ id: block.id, action: "replace", payload });
      else result.inserts.push({ kind: "iptc", payload });
    }
    result.handledSets.push(...setIds);
    return result;
  },
};
