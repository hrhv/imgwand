import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editMetadata, inspect, parseContainer, readC2pa, signC2pa, VERSION } from "@hrhv/imgwand";
import { run, type CliDeps, type TuiOptions } from "../../src/program.js";
import type { Capabilities } from "../../src/terminal/capabilities.js";
import { CERT_DIR, fullJpeg, plainJpeg, testSigner } from "../../../core/test/helpers/fixtures.js";

const CAPS: Capabilities = { protocol: "blocks", reason: "test", terminal: "test", truecolor: true, kittyPlaceholders: false, cell: { width: 8, height: 16, measured: false }, hints: [] };

async function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "imgwand-cli-"));
  writeFileSync(join(dir, "photo.jpg"), await fullJpeg());
  writeFileSync(join(dir, "plain.jpg"), await plainJpeg());
  const signed = await signC2pa(await fullJpeg(), "image/jpeg", { signer: testSigner(), digitalSourceType: "digitalCapture", assertions: [{ label: "cawg.training-mining", data: { entries: { "cawg.ai_inference": { use: "notAllowed" } } } }] });
  writeFileSync(join(dir, "signed.jpg"), signed);
  return dir;
}

function cli(dir: string, deps: Partial<CliDeps> = {}) {
  let out = "";
  let err = "";
  const runWith = (...args: string[]) =>
    run(args, {
      cwd: dir,
      env: { HOME: dir },
      isTTY: false,
      config: {},
      detect: () => CAPS,
      terminalSize: () => ({ cols: 60, rows: 20 }),
      writeOut: (t) => (out += t),
      writeErr: (t) => (err += t),
      ...deps,
    });
  return {
    run: runWith,
    out: () => out,
    err: () => err,
    reset: () => {
      out = "";
      err = "";
    },
  };
}

const ids = (path: string) => inspect(new Uint8Array(readFileSync(path))).fields.map((f) => f.id);

describe("cli", () => {
  it("prints version, help and the selector guide", async () => {
    const dir = await workspace();
    const c = cli(dir);
    expect(await c.run("--version")).toBe(0);
    expect(c.out().trim()).toBe(VERSION);
    c.reset();
    expect(await c.run("--help")).toBe(0);
    expect(c.out()).toMatch(/Usage: imgwand/);
    expect(c.out()).toMatch(/Examples:/);
    c.reset();
    expect(await c.run("fields")).toBe(0);
    expect(c.out()).toMatch(/privacy/);
    expect(await c.run("strip", "--help")).toBe(0);
  });

  it("reports diagnostics with -v", async () => {
    const c = cli(await workspace(), { native: { cacheDir: "/cache/imgwand", c2paVersion: "9.9.9" } });
    expect(await c.run("-v")).toBe(0);
    expect(c.out()).toMatch(new RegExp(`imgwand ${VERSION}`));
    expect(c.out()).toMatch(/sharp\s+✓ \d/);
    expect(c.out()).toMatch(/c2pa-node\s+✓ 9\.9\.9/);
    expect(c.out()).toMatch(/native\s+\/cache\/imgwand/);
    expect(c.out()).toMatch(/graphics\s+blocks/);
  });

  it("shows tmux details and hints in diagnostics", async () => {
    const tmuxCaps: Capabilities = { ...CAPS, protocol: "kitty", tmux: { clientTermName: "xterm-kitty", clientTermType: "kitty", passthrough: true, version: "3.6a" }, kittyPlaceholders: true, hints: ["a hint"] };
    const c = cli(await workspace(), { detect: () => tmuxCaps });
    await c.run("--info");
    expect(c.out()).toMatch(/tmux\s+3\.6a, client xterm-kitty/);
    expect(c.out()).toMatch(/Unicode placeholders/);
    expect(c.out()).toMatch(/! a hint/);
  });

  it("shows metadata as text and JSON", async () => {
    const dir = await workspace();
    const c = cli(dir);
    expect(await c.run("show", "photo.jpg")).toBe(0);
    expect(c.out()).toMatch(/photo\.jpg\s+JPEG\s+320×200/);
    expect(c.out()).toMatch(/GPSLatitude\s+38° 42' 36"/);
    expect(c.out()).toMatch(/no C2PA/);
    c.reset();
    expect(await c.run("show", "signed.jpg", "--json")).toBe(0);
    const json = JSON.parse(c.out());
    expect(json.c2pa.validationState).toBe("Valid");
    expect(json.fields.find((f: { id: string }) => f.id === "exif:IFD0:Make").value).toBe("Fujifilm");
    expect(json.image.width).toBe(320);
    c.reset();
    expect(await c.run("show", "photo.jpg", "plain.jpg", "--json", "-g", "gps")).toBe(0);
    const many = JSON.parse(c.out());
    expect(many).toHaveLength(2);
    expect(many[0].fields.every((f: { group: string }) => f.group === "gps")).toBe(true);
    c.reset();
    expect(await c.run("show", "plain.jpg")).toBe(0);
    expect(c.out()).toMatch(/No metadata/);
    c.reset();
    expect(await c.run("show", "signed.jpg", "--no-c2pa")).toBe(0);
    expect(c.out()).toMatch(/Manifest Store/);
  });

  it("reports unreadable files without stack traces", async () => {
    const dir = await workspace();
    writeFileSync(join(dir, "bad.jpg"), "not an image");
    const c = cli(dir);
    expect(await c.run("show", "bad.jpg", "missing.jpg")).toBe(1);
    expect(c.err()).toMatch(/bad\.jpg: Unrecognized file format/);
    expect(c.err()).toMatch(/missing\.jpg: Cannot read .*no such file/);
    expect(c.err()).not.toMatch(/\n\s+at /);
    c.reset();
    expect(await c.run("show", "bad.jpg", "--json")).toBe(1);
    expect(JSON.parse(c.out()).error).toMatch(/Unrecognized/);
  });

  it("strips with a dry run, in place, to a new file and with backups", async () => {
    const dir = await workspace();
    const c = cli(dir);
    const before = readFileSync(join(dir, "photo.jpg"));
    expect(await c.run("strip", "photo.jpg", "-f", "gps", "-n")).toBe(0);
    expect(c.out()).toMatch(/\(dry run\)/);
    expect(c.out()).toMatch(/- exif:GPS:GPSLatitude/);
    expect(readFileSync(join(dir, "photo.jpg"))).toEqual(before);

    expect(await c.run("strip", "photo.jpg", "-f", "gps")).toBe(1);
    expect(c.err()).toMatch(/Choose where to write/);

    expect(await c.run("strip", "photo.jpg", "-f", "privacy", "-o", "clean.jpg")).toBe(0);
    expect(ids(join(dir, "clean.jpg")).some((id) => id.includes("GPS"))).toBe(false);
    expect(readFileSync(join(dir, "photo.jpg"))).toEqual(before);
    expect(await c.run("strip", "photo.jpg", "-f", "gps", "-o", "clean.jpg")).toBe(1);
    expect(c.err()).toMatch(/already exists/);
    expect(await c.run("strip", "photo.jpg", "-f", "gps", "-o", "clean.jpg", "--force")).toBe(0);

    c.reset();
    expect(await c.run("strip", "photo.jpg", "plain.jpg", "-f", "comment", "--in-place", "--backup")).toBe(0);
    expect(c.out()).toMatch(/plain\.jpg: nothing to change/);
    expect(existsSync(join(dir, "photo.jpg.bak"))).toBe(true);
    expect(ids(join(dir, "photo.jpg"))).not.toContain("comment:COM");
    expect(await c.run("strip", "photo.jpg", "plain.jpg", "-f", "gps", "-o", "x.jpg")).toBe(1);
    expect(c.err()).toMatch(/single input file/);
    expect(await c.run("strip", "photo.jpg", "-f", "gps", "-o", "x.jpg", "-i")).toBe(1);
    expect(c.err()).toMatch(/either -o\/--output or --in-place/);
  });

  it("strips with JSON output and explains bad selectors", async () => {
    const dir = await workspace();
    const c = cli(dir);
    expect(await c.run("strip", "photo.jpg", "-f", "exif:GPS:*", "--json", "-n")).toBe(0);
    const json = JSON.parse(c.out());
    expect(json.removed).toContain("exif:GPS:GPSLatitude");
    expect(json.written).toBeNull();
    c.reset();
    expect(await c.run("strip", "photo.jpg", "-f", "SerialNumbr", "-n")).toBe(1);
    expect(c.err()).toMatch(/No such field: SerialNumbr/);
    expect(await c.run("strip", "photo.jpg")).toBe(2); // missing required -f
  });

  it("protects C2PA unless told what to do", async () => {
    const dir = await workspace();
    const c = cli(dir);
    expect(await c.run("strip", "signed.jpg", "-f", "gps", "-o", "a.jpg")).toBe(1);
    expect(c.err()).toMatch(/--c2pa remove/);
    expect(existsSync(join(dir, "a.jpg"))).toBe(false);
    expect(await c.run("strip", "signed.jpg", "-f", "gps", "--c2pa", "remove", "-o", "b.jpg")).toBe(0);
    expect(ids(join(dir, "b.jpg")).some((id) => id.startsWith("c2pa:"))).toBe(false);
    expect(await c.run("strip", "signed.jpg", "-f", "gps", "--c2pa", "keep", "-o", "c.jpg")).toBe(0);
    const kept = await readC2pa(new Uint8Array(readFileSync(join(dir, "c.jpg"))), "image/jpeg");
    expect(kept?.validationState).toBe("Invalid");
    expect(await c.run("strip", "signed.jpg", "-f", "gps", "--c2pa", "maybe", "-n")).toBe(1);
    expect(c.err()).toMatch(/--c2pa must be/);
  });

  it("sets values", async () => {
    const dir = await workspace();
    const c = cli(dir);
    expect(await c.run("set", "photo.jpg", "exif:IFD0:Artist=Anon", "xmp:dc:title=New title", "-f", "comment", "-i")).toBe(0);
    expect(c.out()).toMatch(/~ exif:IFD0:Artist/);
    const fields = inspect(new Uint8Array(readFileSync(join(dir, "photo.jpg")))).fields;
    expect(fields.find((f) => f.id === "exif:IFD0:Artist")?.value).toBe("Anon");
    expect(fields.find((f) => f.id === "xmp:dc:title")?.value).toBe("New title");
    expect(fields.some((f) => f.id === "comment:COM")).toBe(false);
    expect(await c.run("set", "photo.jpg", "nonsense", "-n")).toBe(1);
    expect(c.err()).toMatch(/Expected <field>=<value>/);
    expect(await c.run("set", "photo.jpg", "exif:ExifIFD:MakerNote=x", "-n")).toBe(1);
    expect(c.err()).toMatch(/not writable/);
    c.reset();
    expect(await c.run("set", "photo.jpg", "exif:IFD0:Artist=JSON", "--json", "-n")).toBe(0);
    expect(JSON.parse(c.out()).updated).toEqual(["exif:IFD0:Artist"]);
  });

  it("reports every C2PA validation state the same way in c2pa show, show and --json", async () => {
    const dir = await workspace();
    const signed = new Uint8Array(readFileSync(join(dir, "signed.jpg")));
    const block = parseContainer(signed).blocks.find((b) => b.kind === "c2pa")!;
    const flip = (from: number, count: number) => {
      const out = signed.slice();
      for (let i = 0; i < count; i++) out[block.offset + from + i]! ^= 0xff;
      return out;
    };
    writeFileSync(join(dir, "bad-signature.jpg"), flip(block.raw.length - 40, 8));
    writeFileSync(join(dir, "bad-claim.jpg"), flip(Buffer.from(block.raw).indexOf("c2pa.claim") + 200, 1));
    writeFileSync(join(dir, "changed.jpg"), editMetadata(signed, { set: { "exif:IFD0:Artist": "x" } }).bytes);
    const chain = readFileSync(join(CERT_DIR, "es256.pub"), "utf8");
    writeFileSync(join(dir, "anchor.pem"), chain.split(/(?=-----BEGIN CERTIFICATE-----)/).at(-1)!);
    const c = cli(dir);
    const cases: [string[], RegExp, RegExp, string, string][] = [
      [["signed.jpg", "--trust", "anchor.pem"], /Validation\s+Trusted\s+signature verified; the signer is on a trust list/, /well-formed ✓ {2}valid ✓ {2}trusted ✓ {2}image unchanged ✓/, "Trusted", "Trusted"],
      [["signed.jpg"], /Validation\s+Valid\s+signature verified; the signer is not on a trust list/, /well-formed ✓ {2}valid ✓ {2}trusted ✗ {2}image unchanged ✓/, "Valid", "Valid"],
      [["bad-signature.jpg"], /Validation\s+Well-formed\s+structure intact, but the signature or certificate check failed/, /well-formed ✓ {2}valid ✗ {2}trusted ✗/, "Invalid", "Well-formed"],
      [["bad-claim.jpg"], /Validation\s+Invalid\s+the manifest store could not be parsed/, /well-formed ✗ {2}valid ✗ {2}trusted ✗ {2}image unchanged \?/, "Invalid", "Invalid"],
      [["changed.jpg"], /Validation\s+Invalid\s+the image was changed after signing \(the manifest itself is valid\)/, /well-formed ✓ {2}valid ✓ {2}trusted ✗ {2}image unchanged ✗/, "Invalid", "Valid"],
    ];
    for (const [args, headline, ladder, sdkState, manifestState] of cases) {
      c.reset();
      expect(await c.run("c2pa", "show", ...args)).toBe(0);
      expect(c.out()).toMatch(headline);
      expect(c.out()).toMatch(ladder);
      c.reset();
      expect(await c.run("c2pa", "show", ...args, "--json")).toBe(0);
      expect(JSON.parse(c.out())).toMatchObject({ validationState: sdkState, manifestState });
    }
    // The untrusted signer is a warning (!), the broken signature an error (✗).
    c.reset();
    await c.run("c2pa", "show", "signed.jpg");
    expect(c.out()).toMatch(/! .*untrusted/);
    expect(c.out()).not.toMatch(/^ {2}✗ /m); // no failure lines (the ladder's "trusted ✗" is expected)
    c.reset();
    await c.run("c2pa", "show", "bad-signature.jpg");
    expect(c.out()).toMatch(/✗ .*claimSignature\.mismatch/);
    // show's badge agrees with c2pa show.
    for (const [file, badge] of [["bad-signature.jpg", "C2PA: Well-formed"], ["bad-claim.jpg", "C2PA: Invalid"], ["changed.jpg", "C2PA: Invalid"], ["signed.jpg", "C2PA: Valid"]]) {
      c.reset();
      expect(await c.run("show", file!)).toBe(0);
      expect(c.out()).toContain(badge);
    }
  });

  it("shows, signs, redacts and removes C2PA", async () => {
    const dir = await workspace();
    const c = cli(dir);
    expect(await c.run("c2pa", "show", "signed.jpg")).toBe(0);
    expect(c.out()).toMatch(/Validation\s+Valid/);
    expect(c.out()).toMatch(/signing certificate untrusted/);
    expect(c.out()).toMatch(/Assertions\s+.*cawg\.training-mining/);
    c.reset();
    expect(await c.run("c2pa", "show", "plain.jpg")).toBe(0);
    expect(c.out()).toMatch(/No C2PA manifest store/);
    c.reset();
    expect(await c.run("c2pa", "show", "signed.jpg", "--json")).toBe(0);
    expect(JSON.parse(c.out()).validationState).toBe("Valid");

    const cert = join(CERT_DIR, "es256.pub");
    const key = join(CERT_DIR, "es256.pem");
    expect(await c.run("c2pa", "sign", "plain.jpg", "-n")).toBe(1);
    expect(c.err()).toMatch(/--cert <pem> --key <pem>/);
    expect(await c.run("c2pa", "sign", "plain.jpg", "--cert", cert, "--key", key, "-n")).toBe(1);
    expect(c.err()).toMatch(/digital source type/);
    c.reset();
    expect(await c.run("c2pa", "sign", "plain.jpg", "--cert", cert, "--key", key, "--source-type", "digitalCapture", "-o", "signed2.jpg", "--title", "Plain")).toBe(0);
    expect(c.out()).toMatch(/✓ signed plain\.jpg/);
    expect((await readC2pa(new Uint8Array(readFileSync(join(dir, "signed2.jpg"))), "image/jpeg"))?.manifests[0]?.title).toBe("Plain");
    c.reset();
    expect(await c.run("c2pa", "sign", "signed.jpg", "--cert", cert, "--key", key, "-n")).toBe(0);
    expect(c.out()).toMatch(/\(dry run\) signed/);
    expect(c.out()).toMatch(/Manifest 2/);
    c.reset();
    expect(await c.run("c2pa", "redact", "signed.jpg", "cawg.training-mining", "--cert", cert, "--key", key, "-i", "--backup")).toBe(0);
    expect(c.out()).toMatch(/Redacted\s+self#jumbf/);
    expect(await c.run("c2pa", "redact", "signed.jpg", "--cert", cert, "--key", key, "-n")).toBe(2); // missing argument
    expect(await c.run("c2pa", "sign", "plain.jpg", "--cert", join(dir, "nope.pem"), "--key", key, "--source-type", "digitalCapture", "-n")).toBe(1);
    expect(c.err()).toMatch(/Cannot read the certificate/);

    c.reset();
    expect(await c.run("c2pa", "remove", "signed.jpg", "-n")).toBe(0);
    expect(c.out()).toMatch(/would remove \d+ bytes/);
    expect(await c.run("c2pa", "remove", "signed.jpg", "-i")).toBe(0);
    expect(await readC2pa(new Uint8Array(readFileSync(join(dir, "signed.jpg"))), "image/jpeg")).toBeNull();
    c.reset();
    expect(await c.run("c2pa", "remove", "signed.jpg", "-i")).toBe(0);
    expect(c.out()).toMatch(/no C2PA manifest store/);
  });

  it("uses the signer from the environment and the config file", async () => {
    const dir = await workspace();
    const env = { HOME: dir, IMGWAND_C2PA_CERT: join(CERT_DIR, "es256.pub"), IMGWAND_C2PA_KEY: join(CERT_DIR, "es256.pem") };
    const viaEnv = cli(dir, { env });
    expect(await viaEnv.run("c2pa", "sign", "plain.jpg", "--source-type", "screenCapture", "-n")).toBe(0);
    const viaConfig = cli(dir, { config: { signer: { cert: join(CERT_DIR, "ps256.pub"), key: join(CERT_DIR, "ps256.pem"), alg: "ps256" } } });
    expect(await viaConfig.run("c2pa", "sign", "plain.jpg", "--source-type", "screenCapture", "-n")).toBe(0);
    expect(viaConfig.out()).toMatch(/Ps256/);
  });

  it("previews images in the terminal", async () => {
    const dir = await workspace();
    const c = cli(dir);
    expect(await c.run("preview", "photo.jpg", "-W", "20")).toBe(0);
    expect(c.out()).toMatch(/▀/);
    expect(await c.run("preview", "photo.jpg", "-W", "zero")).toBe(1);
    expect(c.err()).toMatch(/positive whole numbers/);
    c.reset();
    const none = cli(dir, { detect: () => ({ ...CAPS, protocol: "none" }) });
    expect(await none.run("preview", "photo.jpg")).toBe(0);
    expect(none.out()).toBe("");
    expect(await c.run("--graphics", "bogus", "preview", "photo.jpg")).toBe(2);
  });

  it("only starts the interactive UI on a terminal, and hands it the right options", async () => {
    const dir = await workspace();
    const c = cli(dir);
    expect(await c.run()).toBe(2);
    expect(c.err()).toMatch(/needs a terminal/);
    let got: TuiOptions | undefined;
    const tty = cli(dir, { isTTY: true, launchTui: async (o) => ((got = o), 7) });
    expect(await tty.run("photo.jpg")).toBe(7);
    expect(got).toMatchObject({ path: "photo.jpg", cwd: dir, capabilities: CAPS });
  });

  it("turns unexpected errors into a message, not a crash", async () => {
    const dir = await workspace();
    const c = cli(dir, {
      detect: () => {
        throw new Error("boom");
      },
    });
    expect(await c.run("preview", "photo.jpg")).toBe(1);
    expect(c.err()).toMatch(/unexpected error boom \(set IMGWAND_DEBUG=1/);
    const debug = cli(dir, { env: { HOME: dir, IMGWAND_DEBUG: "1" }, detect: () => { throw new Error("boom"); } });
    expect(await debug.run("preview", "photo.jpg")).toBe(1);
    expect(debug.err()).toMatch(/\n\s+at /);
  });

  it("treats file-system errors as expected", async () => {
    const dir = await workspace();
    const c = cli(dir, { config: { trustAnchors: join(dir, "missing-anchors.pem") } });
    expect(await c.run("c2pa", "show", "signed.jpg")).toBe(1);
    expect(c.err()).toMatch(/^error ENOENT/);
    expect(c.err()).not.toMatch(/\n\s+at /);
  });

  it("honors --no-color and NO_COLOR", async () => {
    const dir = await workspace();
    const colored = cli(dir, { isTTY: true });
    await colored.run("show", "plain.jpg");
    expect(colored.out()).toMatch(/\x1b\[/);
    const plain = cli(dir, { isTTY: true });
    await plain.run("--no-color", "show", "plain.jpg");
    expect(plain.out()).not.toMatch(/\x1b\[/);
    const env = cli(dir, { isTTY: true, env: { HOME: dir, NO_COLOR: "1" } });
    await env.run("show", "plain.jpg");
    expect(env.out()).not.toMatch(/\x1b\[/);
  });
});
