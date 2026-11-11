import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  C2PA_STORE_ID,
  ImageDocument,
  c2paVerdict,
  parseContainer,
  editMetadata,
  inspect,
  readC2pa,
  readMetadata,
  redactC2pa,
  removeC2pa,
  resolveRedactions,
  samePixels,
  signC2pa,
} from "../../src/index.js";
import { CERT_DIR, fullJpeg, fullPng, fullWebp, plainJpeg, testSigner, withSegments, xmpSegment, XMP_PACKET } from "../helpers/fixtures.js";

const TRAINING = { label: "cawg.training-mining", data: { entries: { "cawg.ai_inference": { use: "notAllowed" } } } };

async function signedJpeg() {
  return signC2pa(await fullJpeg(), "image/jpeg", { signer: testSigner(), title: "photo.jpg", digitalSourceType: "digitalCapture", assertions: [TRAINING] });
}

describe("C2PA", () => {
  it("signs a new manifest and reads it back", async () => {
    const signed = await signedJpeg();
    const report = await readC2pa(signed, "image/jpeg");
    expect(report).not.toBeNull();
    expect(report!.validationState).toBe("Valid");
    expect(report!.manifests).toHaveLength(1);
    const m = report!.manifests[0]!;
    expect(m.title).toBe("photo.jpg");
    expect(m.claimGenerator).toMatch(/^imgwand 0\.1\.0/);
    expect(m.signature).toMatchObject({ issuer: "C2PA Test Signing Cert", commonName: "C2PA Signer", algorithm: "Es256" });
    expect(m.actions[0]).toMatchObject({ action: "c2pa.created", digitalSourceType: "digitalCapture" });
    expect(m.assertions.map((a) => a.label)).toEqual(expect.arrayContaining(["c2pa.actions.v2", "cawg.training-mining"]));
    // An untrusted signer is a warning, not a failure: the manifest is Valid, just not Trusted.
    expect(report!.failures).toEqual([]);
    expect(report!.warnings.map((f) => f.code)).toEqual(["signingCredential.untrusted"]);
    expect(await samePixels(await fullJpeg(), signed)).toBe(true);
  });

  it("validates as Trusted against a matching trust anchor", async () => {
    const chain = readFileSync(`${CERT_DIR}es256.pub`, "utf8");
    const root = chain.split(/(?=-----BEGIN CERTIFICATE-----)/).at(-1)!;
    const report = await readC2pa(await signedJpeg(), "image/jpeg", { trustAnchors: root });
    expect(report!.validationState).toBe("Trusted");
    await expect(readC2pa(await signedJpeg(), "image/jpeg", { trustAnchors: "https://example.com/anchors.pem" })).rejects.toThrow(/PEM/);
  });

  it("merges C2PA details into readMetadata fields", async () => {
    const report = await readMetadata(await signedJpeg());
    const c2pa = report.fields.filter((f) => f.group === "c2pa");
    expect(c2pa.map((f) => f.id)).toEqual(expect.arrayContaining([C2PA_STORE_ID, "c2pa:ValidationState", "c2pa:Active.Title", "c2pa:Active.SignedBy", "c2pa:Active.Actions"]));
    expect(c2pa.find((f) => f.id === "c2pa:ValidationState")!.value).toBe("Valid (signature verified; the signer is not on a trust list)");
    expect(c2pa.find((f) => f.id === "c2pa:ValidationWarnings")!.value).toMatch(/untrusted|trust/i);
    expect(c2pa.some((f) => f.id === "c2pa:ValidationIssues")).toBe(false);
    expect(c2pa.every((f) => f.removal === "block")).toBe(true);
  });

  it("requires a source type for a new history and supports every algorithm", async () => {
    await expect(signC2pa(await plainJpeg(), "image/jpeg", { signer: testSigner() })).rejects.toThrow(/digital source type/);
    for (const alg of ["ps256", "ed25519"] as const) {
      const signed = await signC2pa(await plainJpeg(), "image/jpeg", { signer: testSigner(alg), digitalSourceType: "trainedAlgorithmicMedia" });
      const report = await readC2pa(signed, "image/jpeg");
      expect(report!.validationState).toBe("Valid");
      expect(report!.manifests[0]!.actions[0]!.digitalSourceType).toBe("trainedAlgorithmicMedia");
    }
  });

  it("signs PNG and WebP too", async () => {
    for (const [bytes, mime] of [[await fullPng(), "image/png"], [await fullWebp(), "image/webp"]] as const) {
      const signed = await signC2pa(bytes, mime, { signer: testSigner(), digitalSourceType: "digitalCreation" });
      expect((await readC2pa(signed, mime))!.validationState).toBe("Valid");
      expect(inspect(signed).fields.some((f) => f.id === C2PA_STORE_ID)).toBe(true);
      const removed = removeC2pa(signed);
      expect(await readC2pa(removed, mime)).toBeNull();
    }
  });

  it("keeps history: the previous manifest becomes the parent ingredient", async () => {
    const first = await signedJpeg();
    const second = await signC2pa(first, "image/jpeg", { signer: testSigner(), title: "edited.jpg" });
    const report = (await readC2pa(second, "image/jpeg"))!;
    expect(report.validationState).toBe("Valid");
    expect(report.manifests).toHaveLength(2);
    expect(report.manifests[0]!.actions[0]!.action).toBe("c2pa.opened");
    expect(report.manifests[0]!.ingredients[0]).toMatchObject({ relationship: "parentOf", activeManifest: report.manifests[1]!.label });
  });

  it("starts a new history when asked, dropping the old store", async () => {
    const fresh = await signC2pa(await signedJpeg(), "image/jpeg", { signer: testSigner(), keepHistory: false, digitalSourceType: "digitalCapture" });
    const report = (await readC2pa(fresh, "image/jpeg"))!;
    expect(report.manifests).toHaveLength(1);
    expect(report.manifests[0]!.ingredients).toEqual([]);
  });

  it("redacts assertions from earlier manifests", async () => {
    const signed = await signedJpeg();
    const redacted = await redactC2pa(signed, "image/jpeg", { signer: testSigner(), redact: ["cawg.training-mining"], redactionReason: "c2pa.PII.present" });
    const report = (await readC2pa(redacted, "image/jpeg"))!;
    expect(report.validationState).toBe("Valid");
    const [active, parent] = report.manifests;
    expect(active!.redactions).toHaveLength(1);
    expect(active!.redactions[0]).toMatch(/cawg\.training-mining$/);
    expect(parent!.assertions.map((a) => a.label)).not.toContain("cawg.training-mining");
    expect(active!.actions.map((a) => a.action)).toEqual(expect.arrayContaining(["c2pa.opened", "c2pa.redacted"]));
  });

  it("explains redaction mistakes", async () => {
    const signed = await signedJpeg();
    const report = await readC2pa(signed, "image/jpeg");
    expect(() => resolveRedactions(report, ["nope"])).toThrow(/No assertion "nope".*cawg\.training-mining/);
    expect(() => resolveRedactions(null, ["x"])).toThrow(/no C2PA manifest store/);
    expect(resolveRedactions(report, [])).toEqual([]);
    expect(resolveRedactions(report, ["self#jumbf=/c2pa/x/c2pa.assertions/y"])).toEqual(["self#jumbf=/c2pa/x/c2pa.assertions/y"]);
    expect(resolveRedactions(report, ["c2pa.actions"])[0]).toMatch(/c2pa\.actions\.v2$/);
    await expect(redactC2pa(signed, "image/jpeg", { signer: testSigner(), redact: [] })).rejects.toThrow(/Nothing to redact/);
    await expect(signC2pa(signed, "image/jpeg", { signer: testSigner(), redact: ["cawg.training-mining"], keepHistory: false })).rejects.toThrow(/keeps the history/);
    await expect(redactC2pa(signed, "image/jpeg", { signer: testSigner(), redact: ["c2pa.actions"] })).rejects.toThrow(/C2PA/);
  });

  it("detects that any other edit invalidates the manifest", async () => {
    const signed = await signedJpeg();
    const edited = editMetadata(signed, { remove: ["exif:IFD0:Artist"] });
    expect(edited.c2paInvalidated).toBe(true);
    expect(edited.warnings.join(" ")).toMatch(/C2PA manifest store no longer matches/);
    const report = (await readC2pa(edited.bytes, "image/jpeg"))!;
    expect(report.validationState).toBe("Invalid");
    expect(report.failures.map((f) => f.code)).toContain("assertion.dataHash.mismatch");

    const both = editMetadata(signed, { remove: ["exif:IFD0:Artist", "c2pa"] });
    expect(both.c2paInvalidated).toBe(false);
    expect(await readC2pa(both.bytes, "image/jpeg")).toBeNull();
  });

  it("removes the store (and the XMP provenance pointer) through any C2PA selector", async () => {
    const withPointer = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET(' xmlns:dcterms="http://purl.org/dc/terms/" dcterms:provenance="https://example.com/m.c2pa"')));
    const signed = await signC2pa(withPointer, "image/jpeg", { signer: testSigner(), digitalSourceType: "digitalCapture" });
    const out = editMetadata(signed, { remove: ["c2pa:Active.Title"] });
    expect(inspect(out.bytes).fields.some((f) => f.group === "c2pa")).toBe(false);
    // Any C2PA field stands for the whole store, so the pointer to a remote copy goes as well.
    expect(inspect(out.bytes).fields.some((f) => f.id === "xmp:dcterms:provenance")).toBe(false);
    const all = editMetadata(signed, { remove: ["c2pa"] });
    expect(inspect(all.bytes).fields.some((f) => f.id === "xmp:dcterms:provenance")).toBe(false);
    expect(await samePixels(signed, all.bytes)).toBe(true);
  });

  it("returns null for files without C2PA and reports broken stores as warnings", async () => {
    expect(await readC2pa(await plainJpeg(), "image/jpeg")).toBeNull();
    const signed = await signedJpeg();
    // Corrupt the JUMBF payload (but keep the container valid).
    const container = (await import("../../src/container/index.js")).parseContainer(signed);
    const block = container.blocks.find((b) => b.kind === "c2pa")!;
    const broken = signed.slice();
    broken.fill(0x41, block.offset + 60, block.offset + 400);
    const report = await readMetadata(broken);
    expect(report.fields.some((f) => f.id === C2PA_STORE_ID)).toBe(true);
    expect(report.c2pa === null || report.c2pa.validationState === "Invalid" || report.warnings.length > 0).toBe(true);
  });

  it("ImageDocument.replaceBytes takes a newly signed file", async () => {
    const doc = await ImageDocument.open(await fullJpeg());
    await doc.replaceBytes(await signC2pa(doc.bytes, "image/jpeg", { signer: testSigner(), digitalSourceType: "digitalCapture" }));
    expect(doc.report.c2pa?.validationState).toBe("Valid");
  });

  it("signed files still decode", async () => {
    const meta = await sharp(await signedJpeg()).metadata();
    expect(meta.format).toBe("jpeg");
  });
});

it("reports a remote-only manifest reference without fetching it", async () => {
  const withPointer = withSegments(await plainJpeg(), xmpSegment(XMP_PACKET(' xmlns:dcterms="http://purl.org/dc/terms/" dcterms:provenance="https://example.com/m.c2pa"')));
  const report = (await readC2pa(withPointer, "image/jpeg"))!;
  expect(report.validationState).toBe("Remote");
  expect(report.remoteUrl).toBe("https://example.com/m.c2pa");
  expect(report.embedded).toBe(false);
  expect(report.warnings[0]!.explanation).toMatch(/not fetched/);
  expect(report.contentMatches).toBeUndefined();
  expect(c2paVerdict(report)).toMatchObject({ label: "Remote", tone: "warn" });
  const fields = (await readMetadata(withPointer)).fields;
  expect(fields.find((f) => f.id === "xmp:dcterms:provenance")?.note).toMatch(/remote C2PA manifest/);
});

describe("C2PA validation states (C2PA 2.2, section 14.3): every rung of the ladder, from real files", () => {
  const root = () => readFileSync(`${CERT_DIR}es256.pub`, "utf8").split(/(?=-----BEGIN CERTIFICATE-----)/).at(-1)!;
  /** Flips bytes inside the signed file's manifest store, at `at` bytes into the store (negative: from its end). */
  const damage = (signed: Uint8Array, at: number | string, count: number, extra = 0) => {
    const block = parseContainer(signed).blocks.find((b) => b.kind === "c2pa")!;
    const start = typeof at === "string" ? Buffer.from(block.raw).indexOf(Buffer.from(at)) + extra : at < 0 ? block.raw.length + at : at;
    expect(start).toBeGreaterThan(0);
    const out = signed.slice();
    for (let i = 0; i < count; i++) out[block.offset + start + i]! ^= 0xff;
    return out;
  };

  it("Trusted: the signer chains to a trust anchor", async () => {
    const report = (await readC2pa(await signedJpeg(), "image/jpeg", { trustAnchors: root() }))!;
    expect(report).toMatchObject({ validationState: "Trusted", manifestState: "Trusted", contentMatches: true, failures: [], warnings: [] });
    expect(c2paVerdict(report)).toMatchObject({ label: "Trusted", tone: "ok" });
  });

  it("Valid: verified, but the signer is not on a trust list (a warning, not an error)", async () => {
    const report = (await readC2pa(await signedJpeg(), "image/jpeg"))!;
    expect(report).toMatchObject({ validationState: "Valid", manifestState: "Valid", contentMatches: true, failures: [] });
    expect(c2paVerdict(report)).toMatchObject({ label: "Valid", tone: "warn", detail: expect.stringMatching(/not on a trust list/) });
  });

  it("Well-formed: the manifest parses, but its signature does not verify", async () => {
    const report = (await readC2pa(damage(await signedJpeg(), -40, 8), "image/jpeg"))!;
    expect(report.validationState).toBe("Invalid"); // all the SDK can say
    expect(report.manifestState).toBe("Well-formed");
    expect(report.contentMatches).toBe(true);
    expect(report.failures.map((f) => f.code)).toEqual(["claimSignature.mismatch"]);
    expect(report.manifests).toHaveLength(1); // still readable: well-formed
    expect(c2paVerdict(report)).toMatchObject({ label: "Well-formed", tone: "bad", detail: expect.stringMatching(/signature/) });
  });

  it("Invalid (not well-formed): a damaged claim cannot even be parsed", async () => {
    const broken = damage(await signedJpeg(), "c2pa.claim", 1, 200);
    const report = (await readC2pa(broken, "image/jpeg"))!;
    expect(report).toMatchObject({ validationState: "Invalid", manifestState: "Invalid", manifests: [], embedded: true });
    expect(report.contentMatches).toBeUndefined();
    expect(report.failures[0]).toMatchObject({ code: "imgwand.unreadable", explanation: expect.stringMatching(/could not be parsed: .*CBOR/) });
    expect(c2paVerdict(report)).toMatchObject({ label: "Invalid", tone: "bad", detail: expect.stringMatching(/could not be parsed/) });
    // readMetadata reports it as a validation result, not as an unexplained warning.
    const meta = await readMetadata(broken);
    expect(meta.c2pa?.manifestState).toBe("Invalid");
    expect(meta.fields.find((f) => f.id === "c2pa:ValidationState")?.value).toMatch(/^Invalid \(the manifest store could not be parsed\)/);
    expect(meta.fields.some((f) => f.id === C2PA_STORE_ID)).toBe(true); // and can still be removed
  });

  it("an image changed after signing is Invalid, while its manifest is still Valid or Trusted", async () => {
    const edited = editMetadata(await signedJpeg(), { set: { "exif:IFD0:Artist": "someone else" } }).bytes;
    const untrusted = (await readC2pa(edited, "image/jpeg"))!;
    expect(untrusted).toMatchObject({ validationState: "Invalid", manifestState: "Valid", contentMatches: false });
    expect(untrusted.failures.map((f) => f.code)).toEqual(["assertion.dataHash.mismatch"]);
    expect(c2paVerdict(untrusted)).toMatchObject({ label: "Invalid", tone: "bad", detail: "the image was changed after signing (the manifest itself is valid)" });
    const trusted = (await readC2pa(edited, "image/jpeg", { trustAnchors: root() }))!;
    expect(trusted).toMatchObject({ validationState: "Invalid", manifestState: "Trusted", contentMatches: false });
    expect(c2paVerdict(trusted).detail).toMatch(/manifest itself is trusted/);
  });
});
