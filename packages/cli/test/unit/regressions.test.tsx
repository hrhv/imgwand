import React from "react";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { ImageDocument, inspect, writeFileAtomic, type C2paReport } from "@hrhv/imgwand";
import { run } from "../../src/program.js";
import { formatC2pa } from "../../src/commands/c2pa.js";
import { cacheRoot, cleanNativeCache, extractNative } from "../../src/native/extract.js";
import { createStyle, safeJson } from "../../src/style.js";
import { App, type AppDeps } from "../../src/tui/App.js";
import { listDir } from "../../src/tui/fs.js";
import type { Capabilities } from "../../src/terminal/capabilities.js";
import { concat, fullJpeg, pngChunk, scene, withChunks } from "../../../core/test/helpers/fixtures.js";

/** Regression tests for issues found in review (CLI, TUI, native cache). */

const CAPS: Capabilities = { protocol: "blocks", reason: "test", terminal: "test", truecolor: true, kittyPlaceholders: false, cell: { width: 8, height: 16, measured: false }, hints: [] };
const OSC_OR_CSI = /\x1b\]|\x1b\[2J|\x9b|\x1bc/;

async function evilPng(dir: string): Promise<string> {
  // A text chunk whose keyword and value carry OSC 0 (title), OSC 52 (clipboard) and a screen clear.
  const evil = "Evil\x1b]0;PWNED\x07\x1b]52;c;ZXZpbA==\x07\x1b[2J";
  const png = withChunks(new Uint8Array(await scene(8, 8).png().toBuffer()), pngChunk("tEXt", concat(evil, "\0", `value\x9b31m\x1b]8;;https://evil\x07link`)));
  const path = join(dir, "evil.png");
  writeFileSync(path, png);
  return path;
}

function cli(dir: string, extra: Record<string, unknown> = {}) {
  let out = "";
  let err = "";
  return {
    run: (...args: string[]) =>
      run(args, { cwd: dir, env: { HOME: dir }, isTTY: false, config: {}, detect: () => CAPS, writeOut: (t) => (out += t), writeErr: (t) => (err += t), ...extra }),
    out: () => out,
    err: () => err,
  };
}

describe("untrusted text never reaches the terminal raw", () => {
  it("strip, show and JSON output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-sec-"));
    await evilPng(dir);
    const c = cli(dir);
    await c.run("strip", "evil.png", "-f", "all", "-n");
    await c.run("show", "evil.png");
    await c.run("show", "evil.png", "--json");
    await c.run("strip", "evil.png", "-f", "all", "-n", "--json");
    expect(c.out()).not.toMatch(OSC_OR_CSI);
    expect(c.out()).toContain("\\u009b"); // escaped in JSON, not raw
    expect(c.err()).not.toMatch(OSC_OR_CSI);
  });

  it("C2PA labels and codes", () => {
    const report: C2paReport = {
      activeManifest: "x",
      manifests: [{ label: "urn:c2pa:\x1b]0;PWNED\x07", claimGenerator: "g\x1b[2J", signature: {}, assertions: [{ label: "a\x9b31m", uri: "u" }], actions: [], ingredients: [], redactions: [] }],
      validationState: "Invalid",
      manifestState: "Invalid",
      failures: [{ code: "x\x1b]52;c;AA==\x07", explanation: undefined }],
      warnings: [{ code: "cawg.identity.\x1b]0;x\x07", explanation: undefined }],
      embedded: true,
    };
    expect(formatC2pa(report, createStyle(false))).not.toMatch(OSC_OR_CSI);
  });

  it("safeJson escapes C1 controls that JSON.stringify leaves alone", () => {
    expect(JSON.stringify("\u009b")).toBe('"\u009b"');
    expect(safeJson("\u009b\u0085 ")).toBe('"\\u009b\\u0085\\u2028"');
  });

  it("the TUI renders hostile metadata without OSC sequences", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-sec-"));
    const path = await evilPng(dir);
    const deps: AppDeps = {
      listDir,
      openDocument: (p) => ImageDocument.open(p),
      imageInfo: async () => undefined,
      renderInline: async () => ({ protocol: "blocks", cols: 0, rows: 0, text: "" }),
      writeFile: writeFileAtomic,
      sign: async (b) => b,
      loadSigner: async () => undefined,
      fullscreen: async () => undefined,
    };
    const app = render(<App startDir={dir} startFile={path} capabilities={CAPS} config={{}} version="0" deps={deps} />);
    // "Metadata(" renders before the document has loaded (Fields: 0); wait for the fields themselves.
    const until = async (re: RegExp) => {
      for (let i = 0; i < 250 && !re.test(app.lastFrame() ?? ""); i++) await new Promise((r) => setTimeout(r, 20));
    };
    await until(/Fields:\s+[1-9]/);
    app.stdin.write("j");
    app.stdin.write("j");
    app.stdin.write("e");
    await until(/Evil/);
    expect(app.lastFrame()).toMatch(/Evil/);
    expect(app.lastFrame()).not.toMatch(/\x1b\]|\x9b/);
    app.unmount();
  });
});

describe("configuration errors", () => {
  it("a broken config file is an error message, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-cfg-"));
    mkdirSync(join(dir, ".config", "imgwand"), { recursive: true });
    for (const [content, message] of [["{bad", /not valid JSON/], ['{"signer": null}', /signer must be an object/]] as const) {
      writeFileSync(join(dir, ".config", "imgwand", "config.json"), content);
      let err = "";
      const code = await run(["show", "x.jpg"], { cwd: dir, env: { HOME: dir }, isTTY: false, writeOut: () => undefined, writeErr: (t) => (err += t) });
      expect(code).toBe(1);
      expect(err).toMatch(message);
      expect(err).not.toMatch(/\n\s+at /);
    }
  });
});

describe("native library cache", () => {
  it("IMGWAND_NATIVE_DIR is only a parent, and cleaning removes nothing but cache entries", () => {
    const home = mkdtempSync(join(tmpdir(), "imgwand-native-"));
    writeFileSync(join(home, "precious.txt"), "keep me");
    mkdirSync(join(home, "Documents"));
    const env = { IMGWAND_NATIVE_DIR: home };
    expect(cacheRoot(env).root).toBe(join(home, "imgwand-native"));
    const bundle = { key: "0123456789abcdef", files: [["lib/a.node", "embedded-a"]] as const, sha256: { "lib/a.node": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" } };
    const dirUsed = extractNative(bundle, { env, readEmbedded: () => new TextEncoder().encode("a") });
    mkdirSync(join(home, "imgwand-native", "linux-x64-fedcba9876543210"));
    mkdirSync(join(home, "imgwand-native", "something-else"));
    const removed = cleanNativeCache(env, dirUsed);
    expect(removed).toEqual([join(home, "imgwand-native", "linux-x64-fedcba9876543210")]);
    expect(existsSync(join(home, "precious.txt"))).toBe(true);
    expect(existsSync(join(home, "Documents"))).toBe(true);
    expect(existsSync(join(home, "imgwand-native", "something-else"))).toBe(true);
    expect(existsSync(dirUsed)).toBe(true);
  });

  it("extracts once, verifies hashes, and keeps its directories private", () => {
    const home = mkdtempSync(join(tmpdir(), "imgwand-native-"));
    const env = { HOME: home };
    const bundle = { key: "aaaaaaaaaaaaaaaa", files: [["x/lib.so", "e"]] as const, sha256: { "x/lib.so": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" } };
    let reads = 0;
    const io = { env, readEmbedded: () => (reads++, new TextEncoder().encode("a")) };
    const dir = extractNative(bundle, io);
    extractNative(bundle, io);
    expect(reads).toBe(1);
    expect(statSync(join(home, ".cache", "imgwand")).mode & 0o077).toBe(0);
    expect(readdirSync(join(home, ".cache", "imgwand", "native"))).toEqual([dir.split("/").pop()]);
    expect(() => extractNative({ ...bundle, key: "bbbbbbbbbbbbbbbb" }, { env, readEmbedded: () => new TextEncoder().encode("tampered") })).toThrow(/corrupt/);
  });
});

describe("preview", () => {
  it("leaves room for a kitty image before the prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-prev-"));
    writeFileSync(join(dir, "a.jpg"), await fullJpeg());
    const c = cli(dir, { detect: () => ({ ...CAPS, protocol: "kitty" }) });
    await c.run("preview", "a.jpg", "-W", "20", "-H", "6");
    expect(c.out()).toMatch(/\x1b\\(\n){2,}$/);
  });
});

describe("TUI value staging", () => {
  const instances: ReturnType<typeof render>[] = [];
  afterEach(() => instances.splice(0).forEach((i) => i.unmount()));

  async function open() {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-tui2-"));
    const path = join(dir, "photo.jpg");
    writeFileSync(path, await fullJpeg());
    const docs: ImageDocument[] = [];
    const deps: AppDeps = {
      listDir,
      openDocument: async (p) => {
        const d = await ImageDocument.open(p);
        docs.push(d);
        return d;
      },
      imageInfo: async () => undefined,
      renderInline: async () => ({ protocol: "blocks", cols: 0, rows: 0, text: "" }),
      writeFile: writeFileAtomic,
      sign: async (b) => b,
      loadSigner: async () => undefined,
      fullscreen: async () => undefined,
    };
    const app = render(<App startDir={dir} startFile={path} capabilities={CAPS} config={{}} version="0" deps={deps} />);
    instances.push(app);
    const frame = () => app.lastFrame() ?? "";
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 200 && !re.test(frame()); i++) await new Promise((r) => setTimeout(r, 20));
      expect(frame()).toMatch(re);
    };
    const type = async (text: string) => {
      for (const ch of text) {
        app.stdin.write(ch);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await waitFor(/Make\s+Fujifilm/);
    return { app, docs, frame, waitFor, type, dir };
  }

  it("an invalid :set value is rolled back, not left staged", async () => {
    const t = await open();
    await t.type(":set exif:IFD0:NoSuchTag=1");
    t.app.stdin.write("\r");
    await t.waitFor(/Don't know how to set|Unknown EXIF field|not known/);
    expect(t.docs[0]!.pendingSets.size).toBe(0);
  });

  it(":set keeps the value verbatim (quotes and spacing)", async () => {
    const t = await open();
    await t.type(":set xmp:dc:title=It's  \"mine\"");
    t.app.stdin.write("\r");
    await t.waitFor(/Staged xmp:dc:title/);
    expect(t.docs[0]!.pendingSets.get("xmp:dc:title")).toBe(`It's  "mine"`);
  });

  it("keys arriving faster than React renders are not lost (pasted command lines)", async () => {
    const t = await open();
    t.app.stdin.write(":");
    t.app.stdin.write("set xmp:dc:title=Fast\r");
    await t.waitFor(/Staged xmp:dc:title/);
    expect(t.docs[0]!.pendingSets.get("xmp:dc:title")).toBe("Fast");
  });

  it(":open asks before dropping staged edits", async () => {
    const t = await open();
    t.app.stdin.write("P");
    await t.waitFor(/privacy/);
    await t.type(":open ..");
    t.app.stdin.write("\r");
    await t.waitFor(/discard the staged changes\?/);
  });
});

it("formatC2pa sanity: still shows the manifest", () => {
  const report = { manifests: [{ label: "urn:c2pa:1", claimGenerator: "g", signature: {}, assertions: [], actions: [], ingredients: [], redactions: [] }], validationState: "Valid", manifestState: "Valid", contentMatches: true, failures: [], warnings: [], embedded: true } as C2paReport;
  expect(formatC2pa(report, createStyle(false))).toMatch(/Active manifest\s+urn:c2pa:1/);
  expect(inspect).toBeDefined();
});
