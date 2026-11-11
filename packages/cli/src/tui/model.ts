import type { MetadataField } from "@hrhv/imgwand";
import { GROUP_ORDER, GROUP_TITLES } from "../commands/show.js";

/** Pure view-model helpers for the TUI (kept free of React so they are easy to test). */

export type Row = { readonly type: "group"; readonly group: string; readonly title: string; readonly count: number } | { readonly type: "field"; readonly field: MetadataField };

/** Group header rows followed by their fields, in display order, filtered by a case-insensitive query. */
export function buildRows(fields: readonly MetadataField[], filter = ""): Row[] {
  const q = filter.trim().toLowerCase();
  const visible = q ? fields.filter((f) => `${f.id} ${f.name} ${f.value} ${f.section}`.toLowerCase().includes(q)) : fields;
  const rows: Row[] = [];
  for (const group of GROUP_ORDER) {
    const inGroup = visible.filter((f) => f.group === group);
    if (inGroup.length === 0) continue;
    rows.push({ type: "group", group, title: GROUP_TITLES[group] ?? group, count: inGroup.length });
    for (const field of inGroup) rows.push({ type: "field", field });
  }
  return rows;
}

/** Keeps the cursor in range and the window scrolled so that the cursor is visible. */
export function scrollWindow(cursor: number, offset: number, height: number, total: number): { cursor: number; offset: number } {
  const c = Math.max(0, Math.min(cursor, total - 1));
  let o = offset;
  if (c < o) o = c;
  if (c >= o + height) o = c - height + 1;
  o = Math.max(0, Math.min(o, Math.max(0, total - height)));
  return { cursor: Math.max(0, c), offset: o };
}

/** Field ids a row stands for (a group row stands for all of its fields). */
export function rowIds(rows: readonly Row[], index: number): string[] {
  const row = rows[index];
  if (!row) return [];
  if (row.type === "field") return [row.field.id];
  const ids: string[] = [];
  for (let i = index + 1; i < rows.length && rows[i]!.type === "field"; i++) ids.push((rows[i] as Extract<Row, { type: "field" }>).field.id);
  return ids;
}

/** Splits a ":command args" line. Quotes group words: :set xmp:dc:title="Two words". */
export function parseCommand(line: string): { name: string; args: string[] } {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
    } else current += ch;
  }
  if (current) tokens.push(current);
  const [name = "", ...args] = tokens;
  return { name: name.replace(/^:/, "").toLowerCase(), args };
}

/** The suggested name for a duplicate: photo.jpg → photo-copy-imgwand.jpg (-2, -3, ... when that is taken). */
export function duplicateName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem}-copy-imgwand${n > 1 ? `-${n}` : ""}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Why a new file name can't be used in the current folder, or undefined when it can. */
export function invalidFileName(name: string): string | undefined {
  if (name.trim() === "") return "Enter a file name";
  if (name === "." || name === "..") return "Not a file name";
  if (name.includes("/") || name.includes("\0")) return "The copy goes in the same folder: no / in the name";
  return undefined;
}
