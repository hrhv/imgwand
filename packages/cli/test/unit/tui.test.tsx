import React from "react";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { ImageDocument, inspect, parseContainer, readC2pa, signC2pa, writeFileAtomic, type C2paSignOptions } from "@hrhv/imgwand";
import { App, type AppDeps } from "../../src/tui/App.js";
import { listDir } from "../../src/tui/fs.js";
import type { Capabilities } from "../../src/terminal/capabilities.js";
import type { FullscreenRequest } from "../../src/tui/fullscreen.js";
import { fullJpeg, plainJpeg, testSigner } from "../../../core/test/helpers/fixtures.js";

const CAPS: Capabilities = { protocol: "blocks", reason: "test", terminal: "test", truecolor: true, kittyPlaceholders: false, cell: { width: 8, height: 16, measured: false }, hints: [] };
const KEYS = { enter: "\r", escape: "\x1b", down: "\x1b[B", up: "\x1b[A", backspace: "\x7f", ctrlD: "\x04" };

const instances: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const i of instances.splice(0)) i.unmount();
});

async function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "imgwand-tui-"));
  writeFileSync(join(dir, "photo.jpg"), await fullJpeg());
  writeFileSync(join(dir, "plain.jpg"), await plainJpeg());
  writeFileSync(join(dir, "notes.txt"), "not an image");
  writeFileSync(join(dir, ".hidden.jpg"), await plainJpeg());
  mkdirSync(join(dir, "album"));
  writeFileSync(join(dir, "album", "inner.jpg"), await plainJpeg());
  return dir;
}

function setup(dir: string, options: { file?: string; signer?: boolean; backup?: boolean } = {}) {
  const previews: FullscreenRequest[] = [];
  const signCalls: C2paSignOptions[] = [];
  const deps: AppDeps = {
    listDir,
    openDocument: (path) => ImageDocument.open(path),
    imageInfo: async () => ({ format: "jpeg", width: 320, height: 200, displayWidth: 320, displayHeight: 200 }),
    renderInline: async () => ({ protocol: "blocks", cols: 3, rows: 2, text: "▀▀▀\n▀▀▀" }),
    writeFile: writeFileAtomic,
    sign: async (bytes, mime, opts) => {
      signCalls.push(opts);
      return signC2pa(bytes, mime, opts);
    },
    loadSigner: async () => (options.signer ? testSigner() : undefined),
    fullscreen: async (request) => {
      previews.push(request);
    },
  };
  const instance = render(<App startDir={dir} startFile={options.file} capabilities={CAPS} config={{ backup: options.backup }} version="0.1.0" deps={deps} />);
  instances.push(instance);
  const frame = () => instance.lastFrame() ?? "";
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      instance.stdin.write(k);
      // Ink waits 20 ms before deciding a lone ESC is the Escape key rather than the start of a sequence.
      await new Promise((r) => setTimeout(r, k === "\x1b" ? 60 : 15));
    }
  };
  const waitFor = async (pattern: RegExp, timeout = 4000) => {
    const start = Date.now();
    while (!pattern.test(frame())) {
      if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${pattern}\n--- frame ---\n${frame()}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { instance, frame, press, waitFor, previews, signCalls };
}

const type = async (press: (...k: string[]) => Promise<void>, text: string) => press(...text.split(""));

describe("TUI browser", () => {
  it("lists folders and images only, navigates, filters and toggles hidden files", async () => {
    const dir = await workspace();
    const t = setup(dir);
    await t.waitFor(/photo\.jpg/);
    expect(t.frame()).toMatch(/album\//);
    expect(t.frame()).not.toMatch(/notes\.txt/);
    expect(t.frame()).not.toMatch(/\.hidden\.jpg/);
    expect(t.frame()).toMatch(/Images\(.*\)\s*\[2\]/);
    await t.press(".");
    await t.waitFor(/\.hidden\.jpg/);
    await t.press("/");
    await type(t.press, "pla");
    await t.waitFor(/<\/pla>/);
    expect(t.frame()).not.toMatch(/photo\.jpg/);
    await t.press(KEYS.escape);
    await t.waitFor(/photo\.jpg/);
    // Into the album and back out.
    await t.press("g", "j", KEYS.enter);
    await t.waitFor(/inner\.jpg/);
    await t.press(KEYS.backspace);
    await t.waitFor(/photo\.jpg/);
    await t.press("r");
    await t.waitFor(/photo\.jpg/);
  });

  it("d duplicates the selected image after a confirmation with the name filled in (Enter = OK)", async () => {
    const dir = await workspace();
    const t = setup(dir);
    await t.waitFor(/photo\.jpg/);
    await t.press("g", "j", "j"); // .. → album/ → photo.jpg
    await t.press("d");
    await t.waitFor(/Duplicate photo\.jpg/);
    expect(t.frame()).toMatch(/Name: photo-copy-imgwand\.jpg/);
    expect(t.frame()).toMatch(/OK\s+Cancel/);
    await t.press(KEYS.enter); // OK has the focus
    await t.waitFor(/Duplicated photo\.jpg as photo-copy-imgwand\.jpg/);
    expect(readFileSync(join(dir, "photo-copy-imgwand.jpg"))).toEqual(readFileSync(join(dir, "photo.jpg")));
    expect(t.frame()).not.toMatch(/Duplicate photo/);
    // The cursor is on the copy: duplicating it again suggests a name derived from it.
    await t.press("d");
    await t.waitFor(/Name: photo-copy-imgwand-copy-imgwand\.jpg/);
    await t.press(KEYS.escape);
    await t.waitFor(/Images\(/);

    // A taken name gets a number; Tab moves the focus to Cancel, and Enter then cancels.
    await t.press("g", "j", "j", "j", "d"); // the copy sorts before photo.jpg ("-" < ".")
    await t.waitFor(/Name: photo-copy-imgwand-2\.jpg/);
    await t.press("\t", KEYS.enter);
    await t.waitFor(/Images\(/);
    expect(t.frame()).not.toMatch(/Duplicate photo/);
    expect(existsSync(join(dir, "photo-copy-imgwand-2.jpg"))).toBe(false);

    // The name is editable; bad and existing names are explained in the dialog, which stays open.
    await t.press("d");
    await t.waitFor(/Name: photo-copy-imgwand-2\.jpg/);
    await t.press(...Array<string>(24).fill(KEYS.backspace));
    await t.waitFor(/Name: +║/); // emptied
    await type(t.press, "a/b.jpg");
    await t.press(KEYS.enter);
    await t.waitFor(/no \/ in the name/);
    await t.press(...Array<string>(7).fill(KEYS.backspace));
    await type(t.press, "plain.jpg");
    await t.press(KEYS.enter);
    await t.waitFor(/plain\.jpg already exists/);
    await t.press(...Array<string>(9).fill(KEYS.backspace));
    await type(t.press, "renamed.jpg");
    await t.press(KEYS.enter);
    await t.waitFor(/Duplicated photo\.jpg as renamed\.jpg/);
    expect(existsSync(join(dir, "renamed.jpg"))).toBe(true);
    expect(readFileSync(join(dir, "plain.jpg"))).not.toEqual(readFileSync(join(dir, "photo.jpg"))); // untouched

    // Only images can be duplicated.
    await t.press("g", "j", "d");
    await t.waitFor(/Select an image to duplicate/);
  });

  it("? shows every keybinding section from any screen and toggles back", async () => {
    const dir = await workspace();
    const t = setup(dir);
    await t.waitFor(/photo\.jpg/);
    await t.press("?");
    await t.waitFor(/Commands/);
    for (const section of ["Navigation", "Browser", "Metadata", "Content Credentials", "Preview", "Commands"]) expect(t.frame()).toContain(section);
    for (const binding of ["mark group", "privacy strip", "cycle graphics", "redact", ":rm <selector…>", "write / quit"]) expect(t.frame()).toContain(binding);
    await t.press("?");
    await t.waitFor(/Images\(/);
    await t.press("G", "k", KEYS.enter);
    await t.waitFor(/Metadata\(photo\.jpg\)/);
    await t.press("c", "?");
    await t.waitFor(/<help>/);
    await t.press(KEYS.escape);
    await t.waitFor(/Content Credentials \[/);
  });

  it("opens an image and previews from the browser", async () => {
    const dir = await workspace();
    const t = setup(dir);
    await t.waitFor(/photo\.jpg/);
    await t.press("G", "k"); // plain.jpg is last; photo.jpg is above it
    await t.press("p");
    await new Promise((r) => setTimeout(r, 200));
    expect(t.previews.map((p) => p.title)).toEqual(["photo.jpg"]);
    await t.press(KEYS.enter);
    await t.waitFor(/Metadata\(photo\.jpg\)/);
  });
});

describe("TUI inspector", () => {
  it("shows grouped metadata, the side panel and file context", async () => {
    const dir = await workspace();
    const t = setup(dir, { file: join(dir, "photo.jpg") });
    await t.waitFor(/Metadata\(photo\.jpg\)/);
    expect(t.frame()).toMatch(/▾ EXIF \(\d+\)/);
    expect(t.frame()).toMatch(/Make\s+Fujifilm/);
    expect(t.frame()).toMatch(/File:\s+photo\.jpg/);
    expect(t.frame()).toMatch(/<browser>.*<photo\.jpg>/);
  });

  it("marks, stages, undoes and writes removals", async () => {
    const dir = await workspace();
    const path = join(dir, "photo.jpg");
    const t = setup(dir, { file: path });
    await t.waitFor(/Make\s+Fujifilm/);
    // Move onto the EXIF group header and mark the whole group, then unmark one row and delete.
    await t.press("j", "a");
    await t.waitFor(/●/);
    await t.press(KEYS.escape); // clear marks
    await t.press(" "); // mark the current row (Make)
    await t.press("d");
    await t.waitFor(/Staged 1 field/);
    await t.waitFor(/1 to remove/);
    await t.press("u");
    await t.waitFor(/Undone/);
    await t.press("P");
    await t.waitFor(/privacy/);
    await t.press("w");
    await t.waitFor(/Write changes to photo\.jpg\?/);
    expect(t.frame()).toMatch(/picture data untouched/);
    await t.press("b");
    await t.waitFor(/Wrote photo\.jpg: removed \d+ fields \(backup: photo\.jpg\.bak\)/);
    const left = inspect(new Uint8Array(readFileSync(path))).fields.map((f) => f.id);
    expect(left.some((id) => id.includes("GPS"))).toBe(false);
    expect(left).toContain("exif:IFD0:Make");
    expect(existsSync(`${path}.bak`)).toBe(true);
    await t.press("w");
    await t.waitFor(/Nothing to write/);
  });

  it("edits values, creates fields and filters", async () => {
    const dir = await workspace();
    const path = join(dir, "photo.jpg");
    const t = setup(dir, { file: path });
    await t.waitFor(/Make\s+Fujifilm/);
    await t.press("/");
    await type(t.press, "artist");
    await t.press(KEYS.enter);
    await t.waitFor(/<\/artist>/);
    await t.press("j", "e");
    await t.waitFor(/exif:IFD0:Artist = /);
    for (let i = 0; i < 12; i++) await t.press(KEYS.backspace);
    await type(t.press, "Anon");
    await t.press(KEYS.enter);
    await t.waitFor(/Staged new value for Artist/);
    expect(t.frame()).toMatch(/→ Anon/);
    await t.press("n");
    await t.waitFor(/New field \(id=value\)/);
    await type(t.press, "xmp:dc:rights=CC-BY");
    await t.press(KEYS.enter);
    await t.waitFor(/Staged xmp:dc:rights/);
    await t.press("w");
    await t.waitFor(/Write changes/);
    await t.press("y");
    await t.waitFor(/Wrote photo\.jpg/);
    const fields = inspect(new Uint8Array(readFileSync(path))).fields;
    expect(fields.find((f) => f.id === "exif:IFD0:Artist")?.value).toBe("Anon");
    expect(fields.find((f) => f.id === "xmp:dc:rights")?.value).toBe("CC-BY");
  });

  it("refuses to edit read-only fields and reports bad input", async () => {
    const dir = await workspace();
    const t = setup(dir, { file: join(dir, "photo.jpg") });
    await t.waitFor(/Make\s+Fujifilm/);
    await t.press("/");
    await type(t.press, "makernote");
    await t.press(KEYS.enter, "j", "e");
    await t.waitFor(/MakerNote is read-only/);
    await t.press(":");
    await type(t.press, "set exif:ExifIFD:ISO=abc");
    await t.press(KEYS.enter);
    await t.waitFor(/not a number/);
    await t.press(":");
    await type(t.press, "frobnicate");
    await t.press(KEYS.enter);
    await t.waitFor(/Unknown command :frobnicate/);
  });

  it("runs : commands (rm, privacy, strip-all, reset, undo, open, help, wq)", async () => {
    const dir = await workspace();
    const path = join(dir, "photo.jpg");
    const t = setup(dir, { file: path });
    await t.waitFor(/Make\s+Fujifilm/);
    const command = async (line: string) => {
      await t.press(":");
      await type(t.press, line);
      await t.press(KEYS.enter);
    };
    await command("rm gps comment");
    await t.waitFor(/Staged \d+ fields for removal/);
    await command("reset");
    await t.waitFor(/Dropped all staged edits/);
    await command("undo");
    await t.waitFor(/Undone/);
    await command("rm");
    await t.waitFor(/Usage: :rm/);
    await command("strip-all");
    await t.waitFor(/all except ICC profile and orientation/);
    await command("set");
    await t.waitFor(/Usage: :set/);
    await command("help");
    await t.waitFor(/Commands/);
    await t.press("?");
    await t.waitFor(/Metadata\(photo\.jpg\)/);
    await command("wq");
    await t.waitFor(/Write changes/);
    await t.press("y");
    await new Promise((r) => setTimeout(r, 300));
    const left = inspect(new Uint8Array(readFileSync(path))).fields.map((f) => f.id);
    expect(left.filter((id) => !id.startsWith("icc:"))).toEqual(["exif:IFD0:Orientation"]);
  });

  it("asks before leaving or quitting with unsaved changes", async () => {
    const dir = await workspace();
    const t = setup(dir, { file: join(dir, "photo.jpg") });
    await t.waitFor(/Make\s+Fujifilm/);
    await t.press("P");
    await t.waitFor(/privacy/);
    await t.press(KEYS.escape);
    await t.waitFor(/Leave this image and discard staged changes\?/);
    await t.press("n");
    await t.waitFor(/Metadata\(photo\.jpg\)/);
    await t.press("q");
    await t.waitFor(/Unsaved changes/);
    await t.press(KEYS.escape); // = cancel
    await t.waitFor(/Metadata\(photo\.jpg\)/);
    await t.press(KEYS.escape);
    await t.waitFor(/Leave this image/);
    await t.press("d");
    await t.waitFor(/Images\(/);
  });

  it("strips everything from the D dialog and previews full screen", async () => {
    const dir = await workspace();
    const t = setup(dir, { file: join(dir, "photo.jpg") });
    await t.waitFor(/Make\s+Fujifilm/);
    await t.press("D");
    await t.waitFor(/Strip metadata/);
    await t.press("a");
    await t.waitFor(/everything/);
    await t.press("x");
    await t.waitFor(/Restored/);
    await t.press("p");
    await new Promise((r) => setTimeout(r, 100));
    expect(t.previews).toHaveLength(1);
    await t.press(KEYS.ctrlD, KEYS.up, KEYS.down, "G", "g");
    expect(t.frame()).toMatch(/Metadata\(photo\.jpg\)/);
  });
});

describe("TUI C2PA", () => {
  it("names the spec's state for a damaged manifest: Well-formed, not just Invalid", async () => {
    const dir = await workspace();
    const path = join(dir, "photo.jpg");
    const signed = await signC2pa(await fullJpeg(), "image/jpeg", { signer: testSigner(), digitalSourceType: "digitalCapture" });
    const block = parseContainer(signed).blocks.find((b) => b.kind === "c2pa")!;
    for (let i = 0; i < 8; i++) signed[block.offset + block.raw.length - 40 + i]! ^= 0xff; // break the signature
    writeFileSync(path, signed);
    const t = setup(dir, { file: path });
    await t.waitFor(/C2PA:\s+Well-formed/);
    await t.press("c");
    await t.waitFor(/Validation: Well-formed — structure intact, but the signature or certificate check failed/);
    expect(t.frame()).toMatch(/well-formed ✓ {2}valid ✗ {2}trusted ✗/);
    expect(t.frame()).toMatch(/✗ .*claimSignature\.mismatch/);
  });

  it("shows the manifest, signs, redacts and writes", async () => {
    const dir = await workspace();
    const path = join(dir, "photo.jpg");
    const t = setup(dir, { file: path, signer: true });
    await t.waitFor(/Make\s+Fujifilm/);
    await t.press("c");
    await t.waitFor(/No C2PA manifest store/);
    await t.press("s");
    await t.waitFor(/Digital source type/);
    await t.press(KEYS.enter); // accepts the suggested digitalCapture
    await t.waitFor(/Signed in memory/, 8000);
    await t.waitFor(/Active manifest/);
    expect(t.frame()).toMatch(/Signed by\s+C2PA Signer/);
    await t.press("w");
    await t.waitFor(/New C2PA signature/);
    await t.press("y");
    await t.waitFor(/Wrote photo\.jpg/, 8000);
    expect((await readC2pa(new Uint8Array(readFileSync(path)), "image/jpeg"))?.validationState).toBe("Valid");

    await t.press("r");
    await t.waitFor(/No redactable assertions/);
    await t.press("s"); // second signature keeps the history
    await t.waitFor(/Signed in memory/, 8000);
    await t.waitFor(/Manifest 2/);
    expect(t.signCalls[1]?.digitalSourceType).toBeUndefined();
    await t.press("j", "k", "x");
    await t.waitFor(/C2PA manifest store/);
    await t.waitFor(/Metadata\(photo\.jpg\)/);
  });

  it("explains when no signer is configured, or edits are pending", async () => {
    const dir = await workspace();
    const t = setup(dir, { file: join(dir, "photo.jpg") });
    await t.waitFor(/Make\s+Fujifilm/);
    await t.press("c", "s");
    await t.waitFor(/No signer configured/);
    await t.press(KEYS.escape, "P", "c", "s");
    await t.waitFor(/Write or discard the staged edits/);
  });

  it("redacts an assertion of an existing manifest", async () => {
    const dir = await workspace();
    const path = join(dir, "photo.jpg");
    const signed = await signC2pa(await fullJpeg(), "image/jpeg", { signer: testSigner(), digitalSourceType: "digitalCapture", assertions: [{ label: "cawg.training-mining", data: { entries: { "cawg.ai_inference": { use: "notAllowed" } } } }] });
    writeFileSync(path, signed);
    const t = setup(dir, { file: path, signer: true });
    await t.waitFor(/C2PA:\s+Valid/);
    await t.press("c");
    await t.waitFor(/Assertion\s+cawg\.training-mining/);
    expect(t.frame()).toMatch(/Validation: Valid — signature verified; the signer is not on a trust list/);
    expect(t.frame()).toMatch(/well-formed ✓ {2}valid ✓ {2}trusted ✗ {2}image unchanged ✓/);
    expect(t.frame()).toMatch(/! .*signingCredential\.untrusted/);
    await t.press("r");
    await t.waitFor(/Redact assertion: /);
    await t.press(KEYS.enter);
    await t.waitFor(/Redacted cawg\.training-mining and re-signed/, 8000);
    await t.waitFor(/Redacted\s+self#jumbf/);
  });
});
