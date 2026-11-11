import { describe, expect, it } from "vitest";
import { assessC2pa, c2paVerdict, type C2paReport, type RawStore } from "../../src/c2pa/c2pa.js";

const ok = (code: string) => ({ code });
const SIGNED = [ok("claimSignature.validated"), ok("claimSignature.insideValidity"), ok("assertion.dataHash.match")];
const store = (state: string, failure: string[], extra: Partial<RawStore> = {}, success = SIGNED): RawStore => ({
  active_manifest: "urn:c2pa:1",
  validation_state: state,
  validation_results: { activeManifest: { success, failure: failure.map((code) => ({ code, explanation: `${code} happened` })) } },
  ...extra,
});
const verdictOf = (s: RawStore) => c2paVerdict({ manifests: [{}], embedded: true, ...assessC2pa(s) } as unknown as C2paReport);

describe("assessC2pa: the SDK's three states mapped onto the specification's ladder", () => {
  it("keeps the SDK's Trusted and Valid", () => {
    expect(assessC2pa(store("Trusted", []))).toMatchObject({ manifestState: "Trusted", contentMatches: true, failures: [], warnings: [] });
    expect(assessC2pa(store("Valid", ["signingCredential.untrusted"]))).toMatchObject({ manifestState: "Valid", failures: [], warnings: [{ code: "signingCredential.untrusted" }] });
  });

  it("CAWG identity and X.509 credential problems are warnings, as the SDK tolerates them", () => {
    const a = assessC2pa(store("Valid", ["cawg.identity.sig_type.unknown", "cawg.x509.untrusted"]));
    expect(a.manifestState).toBe("Valid");
    expect(a.failures).toEqual([]);
    expect(a.warnings.map((w) => w.code)).toEqual(["cawg.identity.sig_type.unknown", "cawg.x509.untrusted"]);
  });

  it.each([
    ["claimSignature.mismatch"],
    ["claimSignature.outsideValidity"],
    ["signingCredential.invalid"],
    ["signingCredential.ocsp.revoked"],
    ["timeStamp.mismatch"],
  ])("a cryptographic failure (%s) leaves the manifest Well-formed", (code) => {
    expect(assessC2pa(store("Invalid", [code], {}, []))).toMatchObject({ validationState: "Invalid", manifestState: "Well-formed", contentMatches: true });
  });

  it.each([["claim.malformed"], ["assertion.cbor.invalid"], ["assertion.hashedURI.mismatch"], ["manifest.multipleParents"], ["something.new.from.a.future.sdk"]])(
    "a structural (or unknown) failure (%s) means not even well-formed",
    (code) => {
      expect(assessC2pa(store("Invalid", [code])).manifestState).toBe("Invalid");
    },
  );

  it("a hard-binding mismatch invalidates the image, not the manifest", () => {
    const a = assessC2pa(store("Invalid", ["signingCredential.untrusted", "assertion.dataHash.mismatch"]));
    expect(a).toMatchObject({ manifestState: "Valid", contentMatches: false, failures: [{ code: "assertion.dataHash.mismatch" }], warnings: [{ code: "signingCredential.untrusted" }] });
    const trusted = assessC2pa(store("Invalid", ["assertion.bmffHash.mismatch"], {}, [...SIGNED, ok("signingCredential.trusted")]));
    expect(trusted).toMatchObject({ manifestState: "Trusted", contentMatches: false });
    expect(verdictOf(store("Invalid", ["assertion.dataHash.mismatch"]))).toMatchObject({ label: "Invalid", detail: expect.stringMatching(/changed after signing.*valid/) });
  });

  it("a changed image with a broken signature: the manifest is only Well-formed", () => {
    const s = store("Invalid", ["assertion.dataHash.mismatch", "claimSignature.mismatch"], {}, []);
    expect(assessC2pa(s)).toMatchObject({ manifestState: "Well-formed", contentMatches: false });
    expect(verdictOf(s).detail).toMatch(/manifest itself is well-formed/);
  });

  it("an ingredient's failures count, and make the active manifest not well-formed (spec 14.3.4)", () => {
    const s = store("Invalid", [], {
      validation_results: {
        activeManifest: { success: SIGNED, failure: [] },
        ingredientDeltas: [{ ingredientAssertionURI: "self#jumbf=/c2pa/urn:c2pa:1/c2pa.assertions/c2pa.ingredient.v3", validationDeltas: { failure: [{ code: "claimSignature.mismatch", explanation: "bad signature" }] } }],
      },
    });
    const a = assessC2pa(s);
    expect(a.manifestState).toBe("Invalid");
    expect(a.failures).toEqual([{ code: "claimSignature.mismatch", explanation: "Ingredient: bad signature", url: "self#jumbf=/c2pa/urn:c2pa:1/c2pa.assertions/c2pa.ingredient.v3" }]);
  });

  it("never claims more than the SDK verified", () => {
    // Invalid with no reason given (e.g. validation disabled in the SDK).
    expect(assessC2pa(store("Invalid", [], {}, [])).manifestState).toBe("Invalid");
    // No active manifest.
    expect(assessC2pa({ validation_state: "Invalid", validation_results: { activeManifest: { failure: [{ code: "assertion.dataHash.mismatch" }] } } }).manifestState).toBe("Invalid");
    // A missing state is not good news either.
    expect(assessC2pa({ active_manifest: "x" })).toMatchObject({ validationState: "Unknown", manifestState: "Invalid" });
  });

  it("falls back to the legacy validation_status list when there are no validation_results", () => {
    const a = assessC2pa({ active_manifest: "x", validation_state: "Invalid", validation_status: [{ code: "claimSignature.mismatch" }, { code: "signingCredential.untrusted" }] });
    expect(a).toMatchObject({ manifestState: "Well-formed", failures: [{ code: "claimSignature.mismatch" }], warnings: [{ code: "signingCredential.untrusted" }] });
  });
});
