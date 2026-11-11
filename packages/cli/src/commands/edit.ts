import { resolve } from "node:path";
import { editMetadata, ImgwandError, readImageFile, writeFileAtomic, type EditOutcome } from "@hrhv/imgwand";
import { safeJson, sanitize } from "../style.js";
import { parseC2paPolicy, writeTarget, type CommandContext, type WriteTargetOptions } from "./shared.js";

export interface EditCommandOptions extends WriteTargetOptions {
  readonly field?: string[];
  readonly backup?: boolean;
  readonly c2pa?: string;
  readonly json?: boolean;
}

/** Parses "id=value" pairs from the command line. */
export function parseAssignments(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new ImgwandError("INVALID_VALUE", `Expected <field>=<value>, got "${pair}"`);
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return out;
}

function summarize(ctx: CommandContext, file: string, outcome: EditOutcome, target: string | undefined, backupPath?: string): string {
  const { style } = ctx;
  const lines: string[] = [];
  const verb = target ? "" : style.dim(" (dry run)");
  if (!outcome.changed) return `${style.dim("·")} ${sanitize(file)}: nothing to change${verb}`;
  lines.push(`${style.green("✓")} ${sanitize(file)}${verb}`);
  for (const f of outcome.removed) lines.push(`  ${style.red("-")} ${sanitize(f.id)} ${style.dim(sanitize(f.value).slice(0, 60))}`);
  for (const id of outcome.updated) lines.push(`  ${style.yellow("~")} ${sanitize(id)}`);
  for (const w of outcome.warnings) lines.push(`  ${style.yellow("!")} ${sanitize(w)}`);
  if (target && target !== resolve(ctx.cwd, file)) lines.push(`  ${style.dim(`→ ${sanitize(target)}`)}`);
  if (backupPath) lines.push(`  ${style.dim(`backup: ${sanitize(backupPath)}`)}`);
  return lines.join("\n");
}

async function editFiles(ctx: CommandContext, files: string[], options: EditCommandOptions, edit: { remove?: string[]; set?: Record<string, string> }): Promise<number> {
  const policy = parseC2paPolicy(options.c2pa);
  const results: unknown[] = [];
  let failures = 0;
  for (const file of files) {
    try {
      const path = resolve(ctx.cwd, file);
      const target = await writeTarget(ctx, file, options, files.length);
      const bytes = await readImageFile(path);
      let outcome = editMetadata(bytes, edit);
      if (outcome.c2paInvalidated) {
        if (policy === "fail") {
          throw new ImgwandError(
            "C2PA_ERROR",
            "This file has C2PA Content Credentials, and editing it makes them invalid. Re-run with --c2pa remove to strip them too, or --c2pa keep to keep the invalid manifest (or re-sign afterwards with `imgwand c2pa sign`)",
          );
        }
        if (policy === "remove") outcome = editMetadata(bytes, { ...edit, remove: [...(edit.remove ?? []), "c2pa"] });
      }
      let backupPath: string | undefined;
      if (target && outcome.changed) backupPath = (await writeFileAtomic(target, outcome.bytes, { backup: options.backup ?? ctx.config.backup })).backupPath;
      if (options.json) {
        results.push({ file, written: target ?? null, changed: outcome.changed, removed: outcome.removed.map((f) => f.id), updated: outcome.updated, warnings: outcome.warnings, backup: backupPath ?? null });
      } else ctx.out(`${summarize(ctx, file, outcome, target, backupPath)}\n`);
    } catch (error) {
      failures++;
      if (options.json) results.push({ file, error: (error as Error).message });
      else ctx.err(`${ctx.style.red("error")} ${sanitize(file)}: ${sanitize((error as Error).message)}\n`);
    }
  }
  if (options.json) ctx.out(`${safeJson(files.length === 1 ? results[0] : results)}\n`);
  return failures > 0 ? 1 : 0;
}

export async function stripCommand(ctx: CommandContext, files: string[], options: EditCommandOptions): Promise<number> {
  const selectors = options.field ?? [];
  if (selectors.length === 0) {
    throw new ImgwandError("INVALID_VALUE", "Nothing selected: pass -f/--field, e.g. -f privacy, -f gps, -f all, -f exif:GPS:*, -f xmp:dc:creator (see `imgwand fields`)");
  }
  return editFiles(ctx, files, options, { remove: selectors });
}

export async function setCommand(ctx: CommandContext, file: string, assignments: string[], options: EditCommandOptions): Promise<number> {
  if (assignments.length === 0) throw new ImgwandError("INVALID_VALUE", "Nothing to set: pass <field>=<value> pairs, e.g. exif:IFD0:Artist=\"Jane Doe\"");
  return editFiles(ctx, [file], options, { set: parseAssignments(assignments), remove: options.field });
}
