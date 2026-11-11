import { parseContainer } from "../container/index.js";
import { ImgwandError } from "../errors.js";
import type { MetadataField } from "../fields.js";
import { VERSION } from "../version.js";
import { C2PA_NOTE } from "./handler.js";

/**
 * C2PA (Content Credentials) through the official SDK (@contentauth/c2pa-node): read and validate manifest stores,
 * sign new manifests (optionally keeping the existing history as a parent ingredient) and redact assertions.
 *
 * The SDK is loaded lazily, so importing this library does not load the native addon until C2PA is used.
 */

type C2paModule = typeof import("@contentauth/c2pa-node");
let sdk: Promise<C2paModule> | undefined;
async function loadSdk(): Promise<C2paModule> {
  sdk ??= import("@contentauth/c2pa-node");
  return sdk;
}

export type C2paSigningAlgorithm = "es256" | "es384" | "es512" | "ps256" | "ps384" | "ps512" | "ed25519";
export const C2PA_ALGORITHMS: readonly C2paSigningAlgorithm[] = ["es256", "es384", "es512", "ps256", "ps384", "ps512", "ed25519"];

/** IPTC digital source types (https://cv.iptc.org/newscodes/digitalsourcetype/) accepted for new manifests. */
export const DIGITAL_SOURCE_TYPES = [
  "digitalCapture", "computationalCapture", "negativeFilm", "positiveFilm", "print", "humanEdits", "compositeCapture",
  "algorithmicallyEnhanced", "digitalCreation", "dataDrivenMedia", "trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia",
  "algorithmicMedia", "screenCapture", "virtualRecording", "composite", "compositeSynthetic",
] as const;
export type DigitalSourceType = (typeof DIGITAL_SOURCE_TYPES)[number];

export interface C2paReadOptions {
  /** PEM text of extra trust anchors. Signers chaining to one of them validate as "Trusted". */
  trustAnchors?: string;
  /** Allow the SDK to fetch remote manifests over the network. Off by default: reading a file should not phone home. */
  allowNetwork?: boolean;
}

export interface C2paStatus {
  readonly code: string;
  readonly explanation?: string;
  readonly url?: string;
}

export interface C2paManifestSummary {
  readonly label: string;
  readonly title?: string;
  readonly claimGenerator: string;
  readonly claimVersion?: number;
  readonly signature: { readonly issuer?: string; readonly commonName?: string; readonly time?: string; readonly algorithm?: string };
  readonly assertions: readonly { readonly label: string; readonly uri: string }[];
  readonly actions: readonly { readonly action: string; readonly digitalSourceType?: string; readonly softwareAgent?: string; readonly when?: string; readonly reason?: string }[];
  readonly ingredients: readonly { readonly title?: string; readonly relationship?: string; readonly activeManifest?: string }[];
  readonly redactions: readonly string[];
}

/**
 * The C2PA validation states (C2PA 2.2, section 14.3). Each level includes the ones before it:
 * - Well-formed: the manifest parses and meets the structural requirements (claim, assertions, ingredients).
 * - Valid: well-formed, unmodified since signing, signature verified, signing credential valid and not revoked.
 * - Trusted: valid, and the signing credential chains to a trust anchor.
 * - Invalid: not even well-formed (damaged, or breaking the specification's rules).
 */
export type C2paManifestState = "Invalid" | "Well-formed" | "Valid" | "Trusted";

export interface C2paReport {
  readonly activeManifest?: string;
  /** Active manifest first, then the rest of the store. */
  readonly manifests: readonly C2paManifestSummary[];
  /**
   * The SDK's verdict for the asset: "Invalid" | "Valid" | "Trusted" ("Remote" when only a remote manifest is
   * referenced and network access is off). The SDK has no "Well-formed": a manifest whose signature fails, or an image
   * changed after signing, is "Invalid" here. See `manifestState` and `contentMatches` for the finer picture.
   */
  readonly validationState: string;
  /** Where the active manifest stands on the specification's ladder of validation states. */
  readonly manifestState: C2paManifestState;
  /**
   * Whether the image still matches what was signed (the manifest's hard binding, e.g. its data hash). False means
   * the file was changed after signing: the manifest itself may still be valid, the image is not. Undefined when it
   * could not be checked (unreadable or remote manifest).
   */
  readonly contentMatches?: boolean;
  /** Problems that make the manifest or the image invalid (including those found in ingredients). */
  readonly failures: readonly C2paStatus[];
  /** Findings that leave the state unchanged: a signer not on a trust list, CAWG identity issues. */
  readonly warnings: readonly C2paStatus[];
  readonly embedded: boolean;
  readonly remoteUrl?: string;
}

async function context(options: C2paReadOptions = {}) {
  const { Context } = await loadSdk();
  if (options.trustAnchors !== undefined && !options.trustAnchors.includes("-----BEGIN CERTIFICATE-----")) {
    // The SDK would treat anything else as a URL to fetch; only accept certificate text.
    throw new ImgwandError("INVALID_VALUE", "Trust anchors must be PEM certificate text");
  }
  return new Context({
    verify: { remoteManifestFetch: Boolean(options.allowNetwork), ocspFetch: false, verifyTrust: true },
    ...(options.trustAnchors ? { trust: { userAnchors: options.trustAnchors } } : {}),
  });
}

function sdkError(action: string, error: unknown): ImgwandError {
  const message = error instanceof Error ? error.message : String(error);
  return new ImgwandError("C2PA_ERROR", `${action}: ${message.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")}`, { cause: error });
}

// The SDK's manifest JSON, as far as this module uses it.
interface RawManifest {
  label?: string;
  title?: string;
  claim_generator?: string;
  claim_generator_info?: { name?: string; version?: string }[];
  claim_version?: number;
  signature_info?: { issuer?: string; common_name?: string; time?: string; alg?: string };
  assertions?: { label: string; data?: { actions?: { action: string; digitalSourceType?: string; softwareAgent?: unknown; when?: string; reason?: string }[] } }[];
  ingredients?: { title?: string; relationship?: string; active_manifest?: string }[];
  redactions?: string[];
}
interface RawStatusSet {
  success?: C2paStatus[];
  informational?: C2paStatus[];
  failure?: C2paStatus[];
}
/** The SDK's manifest store JSON, as far as this module uses it. Exported for tests. */
export interface RawStore {
  active_manifest?: string;
  manifests?: Record<string, RawManifest>;
  validation_state?: string;
  validation_status?: C2paStatus[];
  validation_results?: {
    activeManifest?: RawStatusSet;
    ingredientDeltas?: { ingredientAssertionURI?: string; validationDeltas?: RawStatusSet }[];
  };
}

// Failures the SDK tolerates: the manifest stays Valid (it is just not Trusted). c2pa-rs:
// validation_results.rs, is_tolerated_manifest_failure_code.
const isTolerated = (code: string) => code === "signingCredential.untrusted" || code.startsWith("cawg.x509.") || code.startsWith("cawg.identity.");
// Hard-binding mismatches: the image's bytes changed after signing. They make the asset invalid, not the manifest
// (spec 14.3.3 and 15.12).
const CONTENT_CODES = /^assertion\.(dataHash|bmffHash|boxesHash|collectionHash)\.mismatch$|^assertion\.multiAssetHash\./;
// The cryptographic checks that separate a Valid manifest from a merely Well-formed one (spec 14.3.5, 15.7-15.9).
const SIGNATURE_CODES = /^(claimSignature\.(mismatch|missing|outsideValidity)|signingCredential\.(invalid|expired|revoked|ocsp\.revoked|ocsp\.unknown)|timeStamp\.|timeOfSigning\.)/;

/**
 * Places a manifest store on the specification's validation ladder from the SDK's state and status codes.
 * Unknown failure codes count as structural, so an unfamiliar problem never reads better than it is.
 */
export function assessC2pa(store: RawStore): Pick<C2paReport, "validationState" | "manifestState" | "contentMatches" | "failures" | "warnings"> {
  const sdkState = store.validation_state ?? "Unknown";
  const results = store.validation_results;
  const active = results?.activeManifest?.failure ?? (results ? [] : (store.validation_status ?? []));
  const ingredients = (results?.ingredientDeltas ?? []).flatMap((d) =>
    (d.validationDeltas?.failure ?? []).map((f) => ({ ...f, explanation: `Ingredient: ${f.explanation ?? f.code}`, url: f.url ?? d.ingredientAssertionURI })),
  );
  const failures = [...active, ...ingredients].filter((f) => !isTolerated(f.code));
  const warnings = [...active, ...ingredients].filter((f) => isTolerated(f.code));
  const contentMatches = !active.some((f) => CONTENT_CODES.test(f.code));
  // An ingredient that fails its requirements makes the active manifest not well-formed (spec 14.3.4).
  const structural = ingredients.some((f) => !isTolerated(f.code)) || active.some((f) => !isTolerated(f.code) && !CONTENT_CODES.test(f.code) && !SIGNATURE_CODES.test(f.code));
  const signature = active.some((f) => SIGNATURE_CODES.test(f.code));
  const succeeded = new Set((results?.activeManifest?.success ?? []).map((s) => s.code));

  let manifestState: C2paManifestState;
  if (sdkState === "Trusted") manifestState = "Trusted";
  else if (sdkState === "Valid") manifestState = "Valid";
  else if (!store.active_manifest || structural) manifestState = "Invalid";
  else if (signature) manifestState = "Well-formed";
  // Only the image changed: judge the manifest by what did verify.
  else if (!contentMatches && succeeded.has("claimSignature.validated")) manifestState = succeeded.has("signingCredential.trusted") ? "Trusted" : "Valid";
  // Invalid without a reason the SDK reports (e.g. validation disabled): claim nothing.
  else manifestState = "Invalid";
  return { validationState: sdkState, manifestState, contentMatches, failures, warnings };
}

/** A one-line verdict for people: what to call the state, how alarming it is, and why. */
export interface C2paVerdict {
  readonly label: "Trusted" | "Valid" | "Well-formed" | "Invalid" | "Remote" | string;
  readonly tone: "ok" | "warn" | "bad";
  readonly detail: string;
}

/** The verdict to show for a report. The CLI, the TUI and the metadata fields all use it, so they always agree. */
export function c2paVerdict(report: C2paReport): C2paVerdict {
  if (report.validationState === "Remote") return { label: "Remote", tone: "warn", detail: "stored remotely and not fetched (network access is off)" };
  if (report.manifestState === "Invalid") {
    return { label: "Invalid", tone: "bad", detail: report.manifests.length === 0 ? "the manifest store could not be parsed" : "not well-formed: the manifest is damaged or breaks the C2PA rules" };
  }
  if (report.contentMatches === false) {
    return { label: "Invalid", tone: "bad", detail: `the image was changed after signing (the manifest itself is ${report.manifestState.toLowerCase()})` };
  }
  switch (report.manifestState) {
    case "Well-formed":
      return { label: "Well-formed", tone: "bad", detail: "structure intact, but the signature or certificate check failed" };
    case "Valid":
      return { label: "Valid", tone: "warn", detail: "signature verified; the signer is not on a trust list" };
    default:
      return { label: "Trusted", tone: "ok", detail: "signature verified; the signer is on a trust list" };
  }
}

function summarize(label: string, m: RawManifest): C2paManifestSummary {
  const generator = m.claim_generator_info?.map((g) => [g.name, g.version].filter(Boolean).join(" ")).join(", ") || m.claim_generator || "unknown";
  const actions = (m.assertions ?? [])
    .filter((a) => a.label.startsWith("c2pa.actions"))
    .flatMap((a) => a.data?.actions ?? [])
    .map((a) => ({
      action: a.action,
      digitalSourceType: a.digitalSourceType?.split("/").pop(),
      softwareAgent: typeof a.softwareAgent === "string" ? a.softwareAgent : (a.softwareAgent as { name?: string } | undefined)?.name,
      when: a.when,
      reason: a.reason,
    }));
  return {
    label,
    title: m.title,
    claimGenerator: generator,
    claimVersion: m.claim_version,
    signature: { issuer: m.signature_info?.issuer, commonName: m.signature_info?.common_name, time: m.signature_info?.time, algorithm: m.signature_info?.alg },
    assertions: (m.assertions ?? []).map((a) => ({ label: a.label, uri: `self#jumbf=/c2pa/${label}/c2pa.assertions/${a.label}` })),
    actions,
    ingredients: (m.ingredients ?? []).map((i) => ({ title: i.title, relationship: i.relationship, activeManifest: i.active_manifest })),
    redactions: m.redactions ?? [],
  };
}

/** Reads and validates the C2PA manifest store of an image. Returns null when there is none. */
export async function readC2pa(bytes: Uint8Array, mimeType: string, options: C2paReadOptions = {}): Promise<C2paReport | null> {
  const { Reader } = await loadSdk();
  const ctx = await context(options); // invalid options are the caller's error, not "no manifest"
  let reader: Awaited<ReturnType<typeof Reader.fromAsset>>;
  try {
    reader = await Reader.fromAsset({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mimeType }, ctx);
  } catch (error) {
    const message = String((error as Error)?.message);
    // Only a remote manifest is referenced (XMP dcterms:provenance) and fetching is off: report it, don't fail.
    const remote = /must fetch remote manifests from url (\S+)/i.exec(message);
    if (remote) {
      return {
        manifests: [],
        validationState: "Remote",
        manifestState: "Invalid",
        failures: [],
        warnings: [{ code: "remote.notFetched", explanation: `The manifest is stored remotely at ${remote[1]} and was not fetched (network access is off)` }],
        embedded: false,
        remoteUrl: remote[1],
      };
    }
    // A manifest store that is there but cannot be parsed is not well-formed: report it as Invalid. Anything else
    // (no store at all, an unsupported file) is a real error.
    if (hasEmbeddedStore(bytes)) {
      return {
        manifests: [],
        validationState: "Invalid",
        manifestState: "Invalid",
        failures: [{ code: "imgwand.unreadable", explanation: `The manifest store could not be parsed: ${sdkError("", error).message.replace(/^: /, "")}` }],
        warnings: [],
        embedded: true,
      };
    }
    // The SDK returns null when a file has no manifest store; anything thrown is a real problem.
    throw sdkError("Could not read the C2PA manifest store", error);
  }
  if (!reader) return null;
  const store = reader.json() as unknown as RawStore;
  const manifests = Object.entries(store.manifests ?? {});
  const active = store.active_manifest;
  manifests.sort(([a], [b]) => (a === active ? -1 : b === active ? 1 : 0));
  let remoteUrl: string | undefined;
  try {
    remoteUrl = reader.isEmbedded() ? undefined : reader.remoteUrl() || undefined;
  } catch {
    remoteUrl = undefined;
  }
  return {
    activeManifest: active,
    manifests: manifests.map(([label, m]) => summarize(label, m)),
    ...assessC2pa(store),
    embedded: reader.isEmbedded(),
    remoteUrl,
  };
}

function hasEmbeddedStore(bytes: Uint8Array): boolean {
  try {
    return parseContainer(bytes).blocks.some((b) => b.kind === "c2pa");
  } catch {
    return false;
  }
}

/** Fields describing a C2PA report, in the same shape as every other metadata field. */
export function c2paFields(report: C2paReport, blockIds: readonly number[]): MetadataField[] {
  const out: MetadataField[] = [];
  const add = (id: string, section: string, name: string, value: string | undefined, sensitive = false) => {
    if (value === undefined || value === "") return;
    out.push({ id: `c2pa:${id}`, group: "c2pa", section, name, value, removal: "block", writable: false, sensitive, note: C2PA_NOTE, blockIds });
  };
  const verdict = c2paVerdict(report);
  add("ValidationState", "Validation", "Validation", `${verdict.label} (${verdict.detail})`);
  add("ManifestState", "Validation", "Manifest State", report.manifestState === verdict.label ? undefined : report.manifestState);
  if (report.failures.length > 0) add("ValidationIssues", "Validation", "Issues", report.failures.map((f) => f.explanation ?? f.code).join("; "));
  if (report.warnings.length > 0) add("ValidationWarnings", "Validation", "Warnings", report.warnings.map((f) => f.explanation ?? f.code).join("; "));
  add("Manifests", "Validation", "Manifests", String(report.manifests.length));
  if (report.remoteUrl) add("RemoteManifest", "Validation", "Remote Manifest", report.remoteUrl);
  report.manifests.forEach((m, i) => {
    const prefix = i === 0 ? "Active" : `Manifest${i + 1}`;
    const section = i === 0 ? "Active Manifest" : `Manifest ${i + 1}`;
    add(`${prefix}.Label`, section, "Label", m.label);
    add(`${prefix}.Title`, section, "Title", m.title);
    add(`${prefix}.ClaimGenerator`, section, "Claim Generator", m.claimGenerator);
    add(`${prefix}.SignedBy`, section, "Signed By", [m.signature.commonName, m.signature.issuer].filter(Boolean).join(" / "), true);
    add(`${prefix}.SignedAt`, section, "Signed At", m.signature.time);
    add(`${prefix}.Algorithm`, section, "Algorithm", m.signature.algorithm);
    add(
      `${prefix}.Actions`,
      section,
      "Actions",
      m.actions.map((a) => [a.action.replace(/^c2pa\./, ""), a.digitalSourceType && `(${a.digitalSourceType})`, a.softwareAgent && `by ${a.softwareAgent}`].filter(Boolean).join(" ")).join("; "),
    );
    add(`${prefix}.Assertions`, section, "Assertions", m.assertions.map((a) => a.label).join(", "));
    add(`${prefix}.Ingredients`, section, "Ingredients", m.ingredients.map((g) => `${g.title ?? "untitled"} (${g.relationship ?? "?"})`).join(", "));
    add(`${prefix}.Redactions`, section, "Redactions", m.redactions.join(", "));
  });
  return out;
}

// --- signing ---------------------------------------------------------------------------------------------------

export interface C2paSigner {
  /** PEM certificate chain (signing certificate first). */
  readonly certificate: Uint8Array | string;
  /** PEM private key matching the signing certificate. */
  readonly privateKey: Uint8Array | string;
  readonly algorithm: C2paSigningAlgorithm;
  /** RFC 3161 time-stamp authority URL. Optional; when set, signing makes a network request to it. */
  readonly tsaUrl?: string;
}

export interface C2paSignOptions {
  readonly signer: C2paSigner;
  /** Title recorded in the manifest (usually the file name). */
  readonly title?: string;
  readonly claimGenerator?: { readonly name: string; readonly version: string };
  /**
   * Keep the existing manifest store as the parent ingredient of the new manifest (the C2PA way to record an
   * edit). Default true. When false, or when there is no existing manifest, the new manifest starts a new history.
   */
  readonly keepHistory?: boolean;
  /** Required when starting a new history: how the content was made. */
  readonly digitalSourceType?: DigitalSourceType;
  /** Assertions to redact from the existing manifests: labels ("cawg.training-mining") or full JUMBF URIs. */
  readonly redact?: readonly string[];
  /** Reason recorded with redactions. */
  readonly redactionReason?: string;
  /** Extra assertions for the new manifest. */
  readonly assertions?: readonly { readonly label: string; readonly data: unknown }[];
  readonly readOptions?: C2paReadOptions;
}

function toBuffer(v: Uint8Array | string): Buffer {
  return typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Resolves redaction targets (labels or URIs) to JUMBF URIs of assertions in the existing store. */
export function resolveRedactions(report: C2paReport | null, targets: readonly string[]): string[] {
  if (targets.length === 0) return [];
  if (!report) throw new ImgwandError("C2PA_ERROR", "Nothing to redact: the image has no C2PA manifest store");
  return targets.map((target) => {
    if (target.startsWith("self#jumbf=")) return target;
    const matches = report.manifests.flatMap((m) => m.assertions.filter((a) => a.label === target || a.label.replace(/\.v\d+$/, "") === target));
    if (matches.length === 0) {
      const known = [...new Set(report.manifests.flatMap((m) => m.assertions.map((a) => a.label)))].join(", ");
      throw new ImgwandError("C2PA_ERROR", `No assertion "${target}" in the manifest store (assertions: ${known || "none"})`);
    }
    // Prefer the most recent manifest that has it.
    return matches[0]!.uri;
  });
}

/**
 * Signs a new C2PA manifest into the image and returns the signed file. With an existing manifest store (and
 * keepHistory), the store becomes the parent ingredient and the new manifest records a "c2pa.opened" action.
 */
export async function signC2pa(bytes: Uint8Array, mimeType: string, options: C2paSignOptions): Promise<Uint8Array> {
  const { Builder, LocalSigner } = await loadSdk();
  const read = await readC2pa(bytes, mimeType, options.readOptions);
  // A remote-only reference that was not fetched has no embedded history to build on.
  const existing = read && read.manifests.length > 0 ? read : null;
  const keepHistory = options.keepHistory !== false && existing !== null;
  const redactions = resolveRedactions(existing, options.redact ?? []);
  if (redactions.length > 0 && !keepHistory) throw new ImgwandError("C2PA_ERROR", "Redaction keeps the history by definition; do not combine it with keepHistory: false");
  if (!keepHistory && !options.digitalSourceType) {
    throw new ImgwandError("INVALID_VALUE", "A new C2PA history needs a digital source type (how the content was made), e.g. digitalCapture");
  }

  let source = bytes;
  if (!keepHistory && existing !== null) {
    // Starting over: drop the old store so it is not silently carried along.
    const { removeC2pa } = await import("../document.js");
    source = removeC2pa(bytes);
  }

  const actions = keepHistory
    ? [{ action: "c2pa.opened", parameters: { ingredientIds: ["imgwand-parent"] } }]
    : [{ action: "c2pa.created", digitalSourceType: `http://cv.iptc.org/newscodes/digitalsourcetype/${options.digitalSourceType}` }];
  const definition = {
    claim_generator_info: [options.claimGenerator ?? { name: "imgwand", version: VERSION }],
    title: options.title ?? "image",
    format: mimeType,
    assertions: [{ label: "c2pa.actions", data: { actions } }, ...(options.assertions ?? [])],
  };
  try {
    const signer = LocalSigner.newSigner(toBuffer(options.signer.certificate), toBuffer(options.signer.privateKey), options.signer.algorithm, options.signer.tsaUrl);
    const builder = await Builder.withJsonAsync(definition, await context(options.readOptions));
    const input = { buffer: Buffer.from(source.buffer, source.byteOffset, source.byteLength), mimeType };
    if (keepHistory) {
      await builder.addIngredient(JSON.stringify({ title: options.title ?? "parent", relationship: "parentOf", label: "imgwand-parent" }), input);
      for (const uri of redactions) builder.addRedaction(uri, (options.redactionReason ?? "c2pa.PII.present") as never);
    }
    const output = { buffer: null as Buffer | null };
    builder.sign(signer, input, output);
    if (!output.buffer) throw new Error("the SDK returned no signed asset");
    return new Uint8Array(output.buffer.buffer, output.buffer.byteOffset, output.buffer.byteLength);
  } catch (error) {
    throw error instanceof ImgwandError ? error : sdkError("Could not sign the C2PA manifest", error);
  }
}

/** Re-signs the image with the given assertions redacted from its existing manifests. */
export async function redactC2pa(
  bytes: Uint8Array,
  mimeType: string,
  options: Omit<C2paSignOptions, "redact" | "keepHistory"> & { readonly redact: readonly string[] },
): Promise<Uint8Array> {
  if (options.redact.length === 0) throw new ImgwandError("INVALID_VALUE", "Nothing to redact");
  return signC2pa(bytes, mimeType, { ...options, keepHistory: true });
}
