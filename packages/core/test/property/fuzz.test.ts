import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { editMetadata, inspect, parseContainer, samePicture, isImgwandError } from "../../src/index.js";
import { parseTiff, removeTiffEntries, readValue } from "../../src/exif/tiff.js";
import { cameraTiff, fullJpeg, fullPng, fullWebp } from "../helpers/fixtures.js";

/**
 * Property tests: hostile input never crashes the parsers with anything but ImgwandError, and arbitrary edits never
 * touch the picture.
 */

let samples: Uint8Array[] = [];
let tiffSample: Uint8Array;
beforeAll(async () => {
  samples = [await fullJpeg({ width: 64, height: 40 }), await fullPng(), await fullWebp()];
  tiffSample = await cameraTiff();
});

function expectCleanFailure(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    if (!isImgwandError(error)) throw error;
  }
}

describe("fuzzing", () => {
  it("survives truncation anywhere", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), fc.double({ min: 0, max: 1, noNaN: true }), (which, cut) => {
        const bytes = samples[which]!;
        expectCleanFailure(() => inspect(bytes.subarray(0, Math.floor(bytes.length * cut))));
      }),
      { numRuns: 300 },
    );
  });

  it("survives random byte corruption", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 12 }), (which, flips) => {
        const bytes = samples[which]!.slice();
        for (const [at, value] of flips) bytes[at % bytes.length] = value;
        expectCleanFailure(() => {
          const { fields } = inspect(bytes);
          // Editing a corrupt file must also fail cleanly (or succeed).
          editMetadata(bytes, { remove: fields.filter((f) => f.removal !== "none").slice(0, 3).map((f) => f.id) });
        });
      }),
      { numRuns: 300 },
    );
  });

  it("survives corrupt TIFF structures", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 20 }), (flips) => {
        const bytes = tiffSample.slice();
        for (const [at, value] of flips) bytes[8 + (at % (bytes.length - 8))] = value;
        expectCleanFailure(() => {
          const tiff = parseTiff(bytes);
          for (const ifd of tiff.ifds.values()) for (const e of ifd.entries) readValue(tiff, e);
          removeTiffEntries(tiff, [{ ifd: "GPS", tag: "*" }, { ifd: "IFD0", tag: 0x013b }]);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("never changes the picture, whatever is removed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), fc.array(fc.nat(), { maxLength: 15 }), (which, picks) => {
        const bytes = samples[which]!;
        const removable = inspect(bytes).fields.filter((f) => f.removal !== "none");
        const selectors = [...new Set(picks.map((p) => removable[p % removable.length]!.id))];
        const out = editMetadata(bytes, { remove: selectors });
        const after = inspect(out.bytes);
        expect(samePicture(parseContainer(bytes), parseContainer(out.bytes))).toBe(true);
        for (const id of selectors) expect(after.fields.some((f) => f.id === id)).toBe(false);
      }),
      { numRuns: 150 },
    );
  });
});
