import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { ImgwandError } from "@hrhv/imgwand";
import type { Config } from "../config.js";
import type { Style } from "../style.js";

/** What every command gets: where to write, how to style, and the environment. */
export interface CommandContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: Config;
  readonly style: Style;
  out(text: string): void;
  err(text: string): void;
}

export interface WriteTargetOptions {
  readonly output?: string;
  readonly inPlace?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

/** Decides where an edited file goes: -o <file>, --in-place, or nowhere (--dry-run). */
export async function writeTarget(ctx: CommandContext, input: string, options: WriteTargetOptions, fileCount = 1): Promise<string | undefined> {
  if (options.dryRun) return undefined;
  if (options.output && options.inPlace) throw new ImgwandError("INVALID_VALUE", "Use either -o/--output or --in-place, not both");
  if (options.output) {
    if (fileCount > 1) throw new ImgwandError("INVALID_VALUE", "-o/--output works with a single input file; use --in-place for several");
    const target = resolve(ctx.cwd, options.output);
    if (target !== resolve(ctx.cwd, input) && !options.force) {
      const exists = await stat(target).then(() => true, () => false);
      if (exists) throw new ImgwandError("IO_ERROR", `${options.output} already exists (use --force to overwrite)`);
    }
    return target;
  }
  if (options.inPlace) return resolve(ctx.cwd, input);
  throw new ImgwandError("INVALID_VALUE", "Choose where to write: -o <file>, --in-place, or --dry-run to only show what would change");
}

export type C2paPolicy = "fail" | "remove" | "keep";

export function parseC2paPolicy(value: string | undefined): C2paPolicy {
  const v = value ?? "fail";
  if (v !== "fail" && v !== "remove" && v !== "keep") throw new ImgwandError("INVALID_VALUE", `--c2pa must be fail, remove or keep (got "${v}")`);
  return v;
}

export const C2PA_POLICY_HELP =
  "what to do when the file has C2PA Content Credentials, which any edit invalidates: fail (default), remove (strip them too), keep (keep the now-invalid manifest)";
