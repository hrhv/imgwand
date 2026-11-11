import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  C2PA_ALGORITHMS,
  DIGITAL_SOURCE_TYPES,
  ImgwandError,
  c2paVerdict,
  detectFormat,
  readC2pa,
  readImageFile,
  redactC2pa,
  removeC2pa,
  signC2pa,
  writeFileAtomic,
  type C2paReport,
  type C2paSigner,
  type C2paSigningAlgorithm,
  type DigitalSourceType,
} from "@hrhv/imgwand";
import { expandHome } from "../config.js";
import { safeJson, sanitize, type Style } from "../style.js";
import { writeTarget, type CommandContext, type WriteTargetOptions } from "./shared.js";

const MIME: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function loadTrustAnchors(ctx: CommandContext, path?: string): Promise<string | undefined> {
  const file = path ?? ctx.config.trustAnchors;
  return file ? readFile(resolve(ctx.cwd, expandHome(file, ctx.env)), "utf8") : undefined;
}

/** The same colors as the UI: Invalid red, Well-formed white (unstyled), Valid yellow, Trusted green. */
export function c2paStateStyle(label: string, style: Style): (text: string) => string {
  if (label === "Trusted") return style.green;
  if (label === "Valid" || label === "Remote") return style.yellow;
  if (label === "Well-formed") return (text) => text;
  return style.red;
}

/** "well-formed ✓  valid ✓  trusted ✗  image unchanged ✓": every level of the specification's ladder. */
export function c2paLadder(report: C2paReport): string {
  if (report.validationState === "Remote") return "not checked: the manifest is remote and was not fetched";
  const rank = { Invalid: 0, "Well-formed": 1, Valid: 2, Trusted: 3 }[report.manifestState];
  const mark = (ok: boolean | undefined) => (ok === undefined ? "?" : ok ? "✓" : "✗");
  return [`well-formed ${mark(rank >= 1)}`, `valid ${mark(rank >= 2)}`, `trusted ${mark(rank >= 3)}`, `image unchanged ${mark(report.contentMatches)}`].join("  ");
}

export function formatC2pa(report: C2paReport | null, style: Style): string {
  if (!report) return style.dim("No C2PA manifest store.");
  const lines: string[] = [];
  const verdict = c2paVerdict(report);
  const tone = c2paStateStyle(verdict.label, style);
  lines.push(`${style.bold("Validation")}  ${tone(style.bold(verdict.label))}  ${verdict.detail}${report.embedded ? "" : style.dim(" (remote manifest)")}`);
  // The full ladder, so a reader sees which level was reached and which was not (C2PA 2.2, section 14.3).
  lines.push(`  ${style.dim(c2paLadder(report))}`);
  for (const f of report.failures) lines.push(`  ${style.red("✗")} ${sanitize(f.explanation ?? f.code)} ${style.dim(sanitize(f.code))}`);
  for (const f of report.warnings) lines.push(`  ${style.yellow("!")} ${sanitize(f.explanation ?? f.code)} ${style.dim(sanitize(f.code))}`);
  report.manifests.forEach((m, i) => {
    lines.push("", style.cyan(style.bold(i === 0 ? "Active manifest" : `Manifest ${i + 1}`)) + style.dim(`  ${sanitize(m.label)}`));
    const row = (k: string, v: string | undefined) => v && lines.push(`  ${k.padEnd(16)} ${sanitize(v)}`);
    row("Title", m.title);
    row("Generator", m.claimGenerator);
    row("Signed by", [m.signature.commonName, m.signature.issuer].filter(Boolean).join(" / "));
    row("Signed at", m.signature.time);
    row("Algorithm", m.signature.algorithm);
    for (const a of m.actions) row("Action", [a.action, a.digitalSourceType && `(${a.digitalSourceType})`, a.softwareAgent && `by ${a.softwareAgent}`, a.reason && `reason: ${a.reason}`].filter(Boolean).join(" "));
    row("Assertions", m.assertions.map((a) => a.label).join(", "));
    for (const g of m.ingredients) row("Ingredient", `${g.title ?? "untitled"} (${g.relationship ?? "?"})`);
    for (const r of m.redactions) row("Redacted", r);
  });
  return lines.join("\n");
}

export async function c2paShowCommand(ctx: CommandContext, file: string, options: { json?: boolean; trust?: string; network?: boolean }): Promise<number> {
  const bytes = await readImageFile(resolve(ctx.cwd, file));
  const report = await readC2pa(bytes, MIME[detectFormat(bytes)]!, { trustAnchors: await loadTrustAnchors(ctx, options.trust), allowNetwork: options.network });
  if (options.json) ctx.out(`${safeJson(report)}\n`);
  else ctx.out(`${ctx.style.bold(sanitize(basename(file)))}\n${formatC2pa(report, ctx.style)}\n`);
  return 0;
}

export interface SignCommandOptions extends WriteTargetOptions {
  readonly cert?: string;
  readonly key?: string;
  readonly alg?: string;
  readonly tsa?: string;
  readonly title?: string;
  readonly sourceType?: string;
  readonly history?: boolean;
  readonly backup?: boolean;
  readonly reason?: string;
  readonly trust?: string;
}

export async function resolveSigner(ctx: CommandContext, options: SignCommandOptions): Promise<C2paSigner> {
  const configured = ctx.config.signer;
  const certPath = options.cert ?? ctx.env.IMGWAND_C2PA_CERT ?? configured?.cert;
  const keyPath = options.key ?? ctx.env.IMGWAND_C2PA_KEY ?? configured?.key;
  if (!certPath || !keyPath) {
    throw new ImgwandError("INVALID_VALUE", "Signing needs a certificate chain and a private key: --cert <pem> --key <pem> (or IMGWAND_C2PA_CERT/IMGWAND_C2PA_KEY, or a signer in the config file)");
  }
  const alg = (options.alg ?? configured?.alg ?? "es256") as C2paSigningAlgorithm;
  if (!C2PA_ALGORITHMS.includes(alg)) throw new ImgwandError("INVALID_VALUE", `--alg must be one of ${C2PA_ALGORITHMS.join(", ")}`);
  const read = async (p: string, what: string) => {
    try {
      return await readFile(resolve(ctx.cwd, expandHome(p, ctx.env)));
    } catch (error) {
      throw new ImgwandError("IO_ERROR", `Cannot read the ${what} (${sanitize(p)}): ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
  };
  return { certificate: await read(certPath, "certificate"), privateKey: await read(keyPath, "private key"), algorithm: alg, tsaUrl: options.tsa ?? configured?.tsa };
}

async function writeSigned(ctx: CommandContext, file: string, options: SignCommandOptions, produce: (bytes: Uint8Array, mime: string) => Promise<Uint8Array>, label: string): Promise<number> {
  const target = await writeTarget(ctx, file, options);
  const bytes = await readImageFile(resolve(ctx.cwd, file));
  const mime = MIME[detectFormat(bytes)]!;
  const signed = await produce(bytes, mime);
  const report = await readC2pa(signed, mime, { trustAnchors: await loadTrustAnchors(ctx, options.trust) });
  if (!target) {
    ctx.out(`${ctx.style.dim("(dry run)")} ${label} ${sanitize(file)}\n${formatC2pa(report, ctx.style)}\n`);
    return 0;
  }
  const { backupPath } = await writeFileAtomic(target, signed, { backup: options.backup ?? ctx.config.backup });
  ctx.out(`${ctx.style.green("✓")} ${label} ${sanitize(file)}${target !== resolve(ctx.cwd, file) ? ctx.style.dim(` → ${sanitize(target)}`) : ""}${backupPath ? ctx.style.dim(` (backup: ${sanitize(backupPath)})`) : ""}\n${formatC2pa(report, ctx.style)}\n`);
  return 0;
}

export async function c2paSignCommand(ctx: CommandContext, file: string, options: SignCommandOptions): Promise<number> {
  const signer = await resolveSigner(ctx, options);
  if (options.sourceType && !(DIGITAL_SOURCE_TYPES as readonly string[]).includes(options.sourceType)) {
    throw new ImgwandError("INVALID_VALUE", `--source-type must be one of: ${DIGITAL_SOURCE_TYPES.join(", ")}`);
  }
  return writeSigned(
    ctx,
    file,
    options,
    (bytes, mime) =>
      signC2pa(bytes, mime, {
        signer,
        title: options.title ?? basename(file),
        keepHistory: options.history !== false,
        digitalSourceType: options.sourceType as DigitalSourceType | undefined,
      }),
    "signed",
  );
}

export async function c2paRedactCommand(ctx: CommandContext, file: string, assertions: string[], options: SignCommandOptions): Promise<number> {
  if (assertions.length === 0) throw new ImgwandError("INVALID_VALUE", "Name the assertions to redact, e.g. cawg.training-mining (see `imgwand c2pa show`)");
  const signer = await resolveSigner(ctx, options);
  return writeSigned(ctx, file, options, (bytes, mime) => redactC2pa(bytes, mime, { signer, title: options.title ?? basename(file), redact: assertions, redactionReason: options.reason }), "redacted");
}

export async function c2paRemoveCommand(ctx: CommandContext, file: string, options: WriteTargetOptions & { backup?: boolean }): Promise<number> {
  const target = await writeTarget(ctx, file, options);
  const bytes = await readImageFile(resolve(ctx.cwd, file));
  const stripped = removeC2pa(bytes);
  if (stripped === bytes || stripped.length === bytes.length) {
    ctx.out(`${ctx.style.dim("·")} ${sanitize(file)}: no C2PA manifest store\n`);
    return 0;
  }
  if (target) {
    const { backupPath } = await writeFileAtomic(target, stripped, { backup: options.backup ?? ctx.config.backup });
    ctx.out(`${ctx.style.green("✓")} removed C2PA from ${sanitize(file)}${backupPath ? ctx.style.dim(` (backup: ${sanitize(backupPath)})`) : ""}\n`);
  } else ctx.out(`${ctx.style.dim("(dry run)")} would remove ${bytes.length - stripped.length} bytes of C2PA data from ${sanitize(file)}\n`);
  return 0;
}
