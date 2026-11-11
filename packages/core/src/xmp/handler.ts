import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";
import { ImgwandError } from "../errors.js";
import type { Block } from "../container/types.js";
import { emptyResult, type EditResult, type Handler, type HandlerContext, type MetadataField } from "../fields.js";
import { decodeText, utf8 } from "../util/bytes.js";

/**
 * XMP: an RDF/XML packet. Each property of each rdf:Description (written as an attribute or as a child element)
 * becomes a field. Edits go through a DOM, so untouched properties, namespaces and the xpacket wrapper survive.
 */

export const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** Conventional prefixes, so ids are stable no matter which prefix a file happens to use. */
export const XMP_NAMESPACES: Readonly<Record<string, string>> = {
  dc: "http://purl.org/dc/elements/1.1/",
  dcterms: "http://purl.org/dc/terms/",
  xmp: "http://ns.adobe.com/xap/1.0/",
  xmpRights: "http://ns.adobe.com/xap/1.0/rights/",
  xmpMM: "http://ns.adobe.com/xap/1.0/mm/",
  xmpDM: "http://ns.adobe.com/xmp/1.0/DynamicMedia/",
  photoshop: "http://ns.adobe.com/photoshop/1.0/",
  tiff: "http://ns.adobe.com/tiff/1.0/",
  exif: "http://ns.adobe.com/exif/1.0/",
  exifEX: "http://cipa.jp/exif/1.0/",
  aux: "http://ns.adobe.com/exif/1.0/aux/",
  crs: "http://ns.adobe.com/camera-raw-settings/1.0/",
  lr: "http://ns.adobe.com/lightroom/1.0/",
  pdf: "http://ns.adobe.com/pdf/1.3/",
  Iptc4xmpCore: "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/",
  Iptc4xmpExt: "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
  plus: "http://ns.useplus.org/ldf/xmp/1.0/",
  GPano: "http://ns.google.com/photos/1.0/panorama/",
  GCamera: "http://ns.google.com/photos/1.0/camera/",
  stEvt: "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#",
  stRef: "http://ns.adobe.com/xap/1.0/sType/ResourceRef#",
};
const PREFIX_BY_URI = new Map(Object.entries(XMP_NAMESPACES).map(([p, u]) => [u, p]));

/** Properties that are arrays by definition (used when creating them). */
const LANG_ALT = new Set(["dc:title", "dc:description", "dc:rights", "xmpRights:UsageTerms"]);
const BAGS = new Set(["dc:subject", "dc:contributor", "dc:publisher", "dc:language", "dc:type", "photoshop:SupplementalCategories"]);
const SEQS = new Set(["dc:creator", "dc:date"]);

const SENSITIVE = [
  /^xmp:exif:GPS/,
  /^xmp:dc:(creator|contributor|publisher|description|title)$/,
  /^xmp:aux:(SerialNumber|LensSerialNumber|OwnerName)$/,
  /^xmp:exifEX:(BodySerialNumber|LensSerialNumber|CameraOwnerName)$/,
  /^xmp:xmpMM:/,
  /^xmp:photoshop:(City|State|Country|Author|Credit|Source|AuthorsPosition|CaptionWriter)$/,
  /^xmp:Iptc4xmpCore:(Location|CountryCode|CreatorContactInfo)$/,
  /^xmp:Iptc4xmpExt:(LocationCreated|LocationShown|PersonInImage)$/,
];

export const XMP_PROVENANCE_ID = "xmp:dcterms:provenance";

const EMPTY_PACKET =
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>';

export function parseXmp(xml: string): Document {
  // XMP never needs a DTD; refusing one rules out entity-expansion tricks.
  if (/<!DOCTYPE/i.test(xml)) throw new ImgwandError("CORRUPT_FILE", "XMP packet contains a DOCTYPE, which XMP does not allow");
  const errors: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") errors.push(message);
      },
    }).parseFromString(xml, "text/xml");
  } catch (error) {
    throw new ImgwandError("CORRUPT_FILE", `Malformed XMP: ${(error as Error).message}`, { cause: error });
  }
  if (errors.length > 0 || !doc.documentElement) throw new ImgwandError("CORRUPT_FILE", `Malformed XMP: ${errors[0] ?? "no root element"}`);
  return doc;
}

function elements(node: Node): Element[] {
  const out: Element[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
}

function descriptions(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagNameNS(RDF_NS, "Description")).filter((d) => d.parentNode && (d.parentNode as Element).namespaceURI === RDF_NS && (d.parentNode as Element).localName === "RDF");
}

function idFor(ns: string | null, prefix: string | null, local: string): string {
  const p = (ns && PREFIX_BY_URI.get(ns)) || prefix || "ns";
  return `xmp:${p}:${local}`;
}

function textOf(el: Element): string {
  return (el.textContent ?? "").trim();
}

/** A readable summary of a property element's value. */
function valueOf(el: Element): { value: string; raw: unknown } {
  const kids = elements(el);
  if (el.getAttributeNS(RDF_NS, "resource")) return { value: el.getAttributeNS(RDF_NS, "resource")!, raw: el.getAttributeNS(RDF_NS, "resource") };
  if (kids.length === 0) return { value: textOf(el), raw: textOf(el) };
  const container = kids[0]!;
  if (container.namespaceURI === RDF_NS && ["Seq", "Bag", "Alt"].includes(container.localName ?? "")) {
    const items = elements(container).filter((li) => li.localName === "li");
    if (container.localName === "Alt") {
      const values = items.map((li) => ({ lang: li.getAttributeNS(XML_NS, "lang") || li.getAttribute("xml:lang") || "", text: textOf(li) }));
      const def = values.find((v) => v.lang === "x-default") ?? values[0];
      return { value: def?.text ?? "", raw: values };
    }
    const structs = items.some((li) => elements(li).length > 0 || li.getAttributeNS(RDF_NS, "parseType") === "Resource");
    if (structs) return { value: `${items.length} ${items.length === 1 ? "entry" : "entries"}`, raw: items.length };
    const values = items.map(textOf);
    return { value: values.join("; "), raw: values };
  }
  // A structure: summarize its fields.
  const parts: string[] = [];
  const struct = container.namespaceURI === RDF_NS && container.localName === "Description" ? container : el;
  for (let i = 0; i < struct.attributes.length; i++) {
    const a = struct.attributes.item(i)!;
    if (a.prefix === "xmlns" || a.name === "xmlns" || a.namespaceURI === RDF_NS) continue;
    parts.push(`${a.localName}=${a.value}`);
  }
  for (const k of elements(struct)) parts.push(`${k.localName}=${textOf(k)}`);
  return { value: parts.join(", "), raw: undefined };
}

interface PropertyRef {
  id: string;
  description: Element;
  attribute?: string; // qualified attribute name
  element?: Element;
}

/** The id without the duplicate-property ("#2") and packet ("#p5") suffixes. */
function baseId(id: string): string {
  return id.split("#")[0]!;
}

/** Properties of a packet. Packets after the first get a "#p<blockId>" suffix so their ids stay distinct. */
function properties(doc: Document, packetSuffix = ""): PropertyRef[] {
  const refs: PropertyRef[] = [];
  for (const d of descriptions(doc)) {
    for (let i = 0; i < d.attributes.length; i++) {
      const a = d.attributes.item(i)!;
      if (a.prefix === "xmlns" || a.name === "xmlns" || a.namespaceURI === RDF_NS || a.namespaceURI === XML_NS) continue;
      refs.push({ id: idFor(a.namespaceURI, a.prefix, a.localName ?? a.name), description: d, attribute: a.name });
    }
    for (const el of elements(d)) refs.push({ id: idFor(el.namespaceURI, el.prefix, el.localName ?? el.nodeName), description: d, element: el });
  }
  // Disambiguate the (rare) duplicates.
  const seen = new Map<string, number>();
  for (const r of refs) {
    const n = (seen.get(r.id) ?? 0) + 1;
    seen.set(r.id, n);
    if (n > 1) r.id = `${r.id}#${n}`;
  }
  if (packetSuffix) for (const r of refs) r.id += packetSuffix;
  return refs;
}

function isEmptyDescription(d: Element): boolean {
  for (let i = 0; i < d.attributes.length; i++) {
    const a = d.attributes.item(i)!;
    if (a.prefix === "xmlns" || a.name === "xmlns" || a.namespaceURI === RDF_NS) continue;
    return false;
  }
  return elements(d).length === 0;
}

function serialize(doc: Document): Uint8Array {
  return utf8(new XMLSerializer().serializeToString(doc));
}

function xmpBlocks(ctx: HandlerContext): Block[] {
  return ctx.container.blocks.filter((b) => b.kind === "xmp");
}

function packetSuffix(block: Block, blocks: readonly Block[]): string {
  return block === blocks[0] ? "" : `#p${block.id}`;
}

function setProperty(doc: Document, refs: PropertyRef[], id: string, value: string): void {
  const ref = refs.find((r) => r.id === id);
  if (ref?.attribute) {
    ref.description.setAttribute(ref.attribute, value);
    return;
  }
  if (ref?.element) {
    const el = ref.element;
    const container = elements(el)[0];
    if (container && container.namespaceURI === RDF_NS && container.localName === "Alt") {
      // Language alternatives: replace the default-language text, keep the translations.
      const items = elements(container).filter((li) => li.localName === "li");
      const target = items.find((li) => (li.getAttributeNS(XML_NS, "lang") || li.getAttribute("xml:lang")) === "x-default") ?? items[0];
      if (target) {
        while (target.firstChild) target.removeChild(target.firstChild);
        target.appendChild(doc.createTextNode(value));
        return;
      }
    }
    if (container && container.namespaceURI === RDF_NS && ["Seq", "Bag", "Alt"].includes(container.localName ?? "")) {
      const items = container.localName === "Alt" ? [value] : value.split(";").map((v) => v.trim()).filter(Boolean);
      while (container.firstChild) container.removeChild(container.firstChild);
      for (const item of items) {
        const li = doc.createElementNS(RDF_NS, `${container.prefix ?? "rdf"}:li`);
        if (container.localName === "Alt") li.setAttribute("xml:lang", "x-default");
        li.appendChild(doc.createTextNode(item));
        container.appendChild(li);
      }
      return;
    }
    if (container) throw new ImgwandError("NOT_WRITABLE", `${id} is a structure; only simple values and arrays can be set`);
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(doc.createTextNode(value));
    return;
  }
  // Create it on the first rdf:Description.
  const m = /^xmp:([A-Za-z][\w.-]*):([A-Za-z_][\w.-]*)$/.exec(id);
  if (!m) throw new ImgwandError("UNKNOWN_FIELD", `Invalid XMP field id "${id}" (expected xmp:<prefix>:<name>)`);
  const [, prefix, local] = m as unknown as [string, string, string];
  const uri = XMP_NAMESPACES[prefix];
  if (!uri) throw new ImgwandError("UNKNOWN_FIELD", `Unknown XMP namespace prefix "${prefix}"; known: ${Object.keys(XMP_NAMESPACES).join(", ")}`);
  const description = descriptions(doc)[0];
  if (!description) throw new ImgwandError("CORRUPT_FILE", "XMP packet has no rdf:Description");
  // Declared in the XMLNS namespace so the serializer knows about it and does not add a second declaration.
  if (!description.lookupNamespaceURI(prefix)) description.setAttributeNS("http://www.w3.org/2000/xmlns/", `xmlns:${prefix}`, uri);
  const key = `${prefix}:${local}`;
  if (LANG_ALT.has(key) || BAGS.has(key) || SEQS.has(key)) {
    const el = doc.createElementNS(uri, key);
    const kind = LANG_ALT.has(key) ? "Alt" : BAGS.has(key) ? "Bag" : "Seq";
    const container = doc.createElementNS(RDF_NS, `rdf:${kind}`);
    const items = kind === "Alt" ? [value] : value.split(";").map((v) => v.trim()).filter(Boolean);
    for (const item of items) {
      const li = doc.createElementNS(RDF_NS, "rdf:li");
      if (kind === "Alt") li.setAttribute("xml:lang", "x-default");
      li.appendChild(doc.createTextNode(item));
      container.appendChild(li);
    }
    el.appendChild(container);
    description.appendChild(el);
  } else {
    description.setAttributeNS(uri, key, value);
  }
}

export const xmpHandler: Handler = {
  kinds: ["xmp", "xmp-extended"],
  owns: (id) => id.startsWith("xmp:"),

  fields(ctx) {
    const out: MetadataField[] = [];
    const blocks = xmpBlocks(ctx);
    for (const block of blocks) {
      const suffix = packetSuffix(block, blocks);
      try {
        const doc = parseXmp(decodeText(block.payload));
        for (const ref of properties(doc, suffix)) {
          const { value, raw } = ref.attribute ? { value: ref.description.getAttribute(ref.attribute) ?? "", raw: undefined } : valueOf(ref.element!);
          const base = baseId(ref.id);
          const [, prefix = "", name = ""] = base.split(":");
          const gps = prefix === "exif" && name.startsWith("GPS");
          out.push({
            id: ref.id,
            group: gps ? "gps" : "xmp",
            section: prefix,
            name,
            value,
            raw: raw ?? value,
            removal: "field",
            writable: true,
            sensitive: SENSITIVE.some((re) => re.test(base)),
            note: base === XMP_PROVENANCE_ID ? "Points to a remote C2PA manifest (Content Credentials)" : undefined,
            blockIds: [block.id],
          });
        }
      } catch (error) {
        out.push({ id: `xmp:packet${suffix}`, group: "xmp", section: "Unreadable", name: "XMP", value: `Unreadable XMP packet (${(error as Error).message})`, removal: "block", writable: false, sensitive: false, blockIds: [block.id] });
      }
    }
    const extended = ctx.container.blocks.filter((b) => b.kind === "xmp-extended");
    if (extended.length > 0) {
      out.push({
        id: "xmp:extended",
        group: "xmp",
        section: "Extended XMP",
        name: "ExtendedXMP",
        value: `${extended.length} segment${extended.length === 1 ? "" : "s"} of extended XMP`,
        removal: "block",
        writable: false,
        sensitive: false,
        note: "Overflow XMP for packets larger than one JPEG segment",
        blockIds: extended.map((b) => b.id),
      });
    }
    return out;
  },

  edit(ctx, _fields, request): EditResult {
    const result = emptyResult();
    const removeIds = [...request.remove].filter((id) => id.startsWith("xmp:"));
    const setIds = [...request.set.keys()].filter((id) => id.startsWith("xmp:"));
    if (removeIds.length === 0 && setIds.length === 0) return result;

    const blocks = xmpBlocks(ctx);
    const extended = ctx.container.blocks.filter((b) => b.kind === "xmp-extended");
    const dropExtended = () => {
      for (const b of extended) if (!result.edits.some((e) => e.id === b.id)) result.edits.push({ id: b.id, action: "remove" });
    };
    if (removeIds.includes("xmp:extended")) dropExtended();

    // Sets go to the packet their id names ("#p<blockId>"), otherwise to the first packet (created if missing).
    const setsFor = new Map<number | "new", string[]>();
    for (const id of setIds) {
      const named = /#p(\d+)$/.exec(id);
      const target = named ? Number(named[1]) : (blocks[0]?.id ?? "new");
      if (named && !blocks.some((b) => b.id === target)) throw new ImgwandError("UNKNOWN_FIELD", `No XMP packet #p${named[1]}`);
      setsFor.set(target, [...(setsFor.get(target) ?? []), id]);
    }

    let primaryEmptied = false;
    const packets: { block: Block | undefined; suffix: string }[] = blocks.map((b) => ({ block: b, suffix: packetSuffix(b, blocks) }));
    if (setsFor.has("new")) packets.push({ block: undefined, suffix: "" });
    for (const { block, suffix } of packets) {
      const mySets = setsFor.get(block ? block.id : "new") ?? [];
      if (block && removeIds.includes(`xmp:packet${suffix}`)) {
        result.edits.push({ id: block.id, action: "remove" });
        if (block === blocks[0]) primaryEmptied = true;
        continue;
      }
      const doc = parseXmp(block ? decodeText(block.payload) : EMPTY_PACKET);
      const refs = properties(doc, suffix);
      const mine = removeIds.filter((id) => refs.some((r) => r.id === id));
      if (mine.length === 0 && mySets.length === 0) continue;
      for (const id of mine) {
        const ref = refs.find((r) => r.id === id)!;
        if (ref.attribute) ref.description.removeAttribute(ref.attribute);
        else ref.element!.parentNode!.removeChild(ref.element!);
      }
      // Within one packet, sets address properties by their packet-local id.
      for (const id of mySets) setProperty(doc, properties(doc), id.replace(/#p\d+$/, ""), request.set.get(id)!);
      if (properties(doc).length === 0) {
        if (block) result.edits.push({ id: block.id, action: "remove" });
        if (block === blocks[0]) primaryEmptied = true;
        continue;
      }
      // Drop rdf:Description elements that no longer hold anything (keeps the packet tidy).
      for (const d of descriptions(doc)) if (isEmptyDescription(d) && descriptions(doc).length > 1) d.parentNode!.removeChild(d);
      const payload = serialize(doc);
      // Never write XMP we could not read back.
      parseXmp(decodeText(payload));
      if (block) result.edits.push({ id: block.id, action: "replace", payload });
      else result.inserts.push({ kind: "xmp", payload });
    }
    // Extended XMP is meaningless without the main packet.
    if (primaryEmptied) dropExtended();
    result.handledSets.push(...setIds);
    return result;
  },
};
