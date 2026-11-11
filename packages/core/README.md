# @hrhv/imgwand

Read, edit and **losslessly** remove image metadata (EXIF, XMP, IPTC, Photoshop resources, ICC, comments) and
work with C2PA Content Credentials (read, validate, sign, redact, strip). JPEG, PNG and WebP. Node.js 24+.

```bash
npm install @hrhv/imgwand   # from GitHub Packages: @hrhv:registry=https://npm.pkg.github.com
```

The C2PA SDK fetches its native binary in an install script; approve it with
`npm install-scripts approve @contentauth/c2pa-node` (npm 11+).

## Read

```ts
import { readMetadata } from "@hrhv/imgwand";

const report = await readMetadata(bytes); // Uint8Array or Buffer
report.format;            // "jpeg" | "png" | "webp"
report.fields;            // [{ id: "exif:GPS:GPSLatitude", group: "gps", name, value, removal, writable, sensitive, ... }]
report.c2pa;              // validated manifest store, or null
```

`inspect(bytes)` is the synchronous, container-only variant (no C2PA SDK).

## Remove and set

```ts
import { editMetadata, removeMetadata, stripAll } from "@hrhv/imgwand";

const out = editMetadata(bytes, {
  remove: ["privacy", "xmp:photoshop:*", "!exif:IFD0:Orientation"],
  set: { "exif:IFD0:Artist": "Jane Doe", "xmp:dc:title": "Sunset", "iptc:Keywords": "a; b" },
});
out.bytes;             // the new file (the input is never modified)
out.removed;           // fields that are gone
out.warnings;          // e.g. "Orientation was removed: viewers may now show the image rotated"
out.c2paInvalidated;   // the file had Content Credentials that this edit invalidated

removeMetadata(bytes, ["gps"]);
stripAll(bytes); // everything except the ICC profile and Orientation (options: keepIcc, keepOrientation, keepC2pa)
```

Every edit is verified: the blocks that hold the picture must be byte-identical afterwards, or `editMetadata`
throws `ImgwandError("VERIFY_FAILED")`. `samePixels(a, b)` compares decoded pixels for an independent check.

Selectors: exact ids, field names, globs (`exif:GPS:*`), groups (`exif gps thumbnail xmp iptc photoshop icc c2pa
comment other`), presets (`all`, `privacy`) and exclusions (`!icc`). See `resolveSelectors`.

## C2PA

```ts
import { readC2pa, signC2pa, redactC2pa, removeC2pa } from "@hrhv/imgwand";

const report = await readC2pa(bytes, "image/jpeg", { trustAnchors: pem }); // network is off unless allowNetwork
const signer = { certificate: chainPem, privateKey: keyPem, algorithm: "es256" as const };
const signed = await signC2pa(bytes, "image/jpeg", { signer, digitalSourceType: "digitalCapture" });
const edited = await signC2pa(signed, "image/jpeg", { signer }); // previous manifest becomes the parent ingredient
const redacted = await redactC2pa(signed, "image/jpeg", { signer, redact: ["cawg.training-mining"] });
const plain = removeC2pa(signed);
```

### Validation states

The C2PA specification (2.2, section 14.3) defines a ladder: **well-formed** (the manifest parses and meets the
structural rules), **valid** (also unmodified since signing, signature and credential verified) and **trusted** (also
signed by a certificate that chains to a trust anchor). A manifest that is not even well-formed is **invalid**. The
image itself is judged separately: it is invalid when its bytes changed after signing.

The C2PA SDK reports only `Invalid | Valid | Trusted`, so a broken signature and an edited image both come back as
`Invalid`. The report keeps the SDK's answer and adds the spec's:

```ts
report.validationState; // the SDK's: "Invalid" | "Valid" | "Trusted" ("Remote" if only a remote manifest is referenced)
report.manifestState;   // the spec's ladder for the active manifest: "Invalid" | "Well-formed" | "Valid" | "Trusted"
report.contentMatches;  // false: the image changed after signing (the manifest itself may still be valid)
report.failures;        // what makes it invalid, including failures inside ingredients
report.warnings;        // what leaves the state unchanged: signer not on a trust list, CAWG identity issues

c2paVerdict(report);    // { label: "Well-formed", tone: "bad", detail: "structure intact, but the signature ..." }
```

| File | `validationState` | `manifestState` | `contentMatches` | verdict |
| ---- | ----------------- | --------------- | ---------------- | ------- |
| signer chains to a trust anchor | Trusted | Trusted | true | Trusted |
| signer not on a trust list | Valid | Valid | true | Valid (warning) |
| signature or certificate fails | Invalid | Well-formed | true | Well-formed |
| image edited after signing | Invalid | Valid / Trusted | false | Invalid: changed after signing |
| store damaged, cannot be parsed | Invalid | Invalid | undefined | Invalid: could not be parsed |

Unknown failure codes count as structural (Invalid), so an unfamiliar problem never reads better than it is.

## Interactive editing

```ts
import { ImageDocument } from "@hrhv/imgwand";

const doc = await ImageDocument.open("photo.jpg");
doc.stageRemove(["gps"]);
doc.stageSet("exif:IFD0:Artist", "Anon");
doc.undo();
doc.preview();                                   // what save() would do
await doc.save(undefined, { backup: true });     // atomic write + photo.jpg.bak
```

## Also exported

`imageInfo`, `renderRaster`, `renderPng`, `renderPaletted` (sharp-based renditions), `readImageFile`,
`writeFileAtomic`, `parseContainer`, `parseTiff`, `parseIcc`, `formatExifValue`, `ImgwandError` (`code` tells
expected failures apart: `UNSUPPORTED_FORMAT`, `CORRUPT_FILE`, `UNKNOWN_FIELD`, `NOT_WRITABLE`, `C2PA_ERROR`, ...).

## License

MPL-2.0
