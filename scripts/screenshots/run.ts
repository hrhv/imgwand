/// <reference lib="dom" />
/**
 * Drives the real imgwand (binary or npm bundle) inside tmux, captures every step of the main flows, and renders
 * the captures to PNG with xterm.js in headless Chrome (a real terminal emulator, including its image addon for
 * sixel and iTerm2 pictures).
 *
 *   tsx scripts/screenshots/run.ts [--bin "dist/bin/imgwand-darwin-arm64"] [--out screenshots] [--chrome <path>]
 *
 * Uses a private tmux server (-L imgwand-shots) so it never touches your own tmux sessions. Inline images (which a
 * tmux capture cannot contain) are shot by running imgwand directly in a pseudo-terminal (pty-record.py, python3)
 * and replaying everything it wrote in xterm.js.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { editMetadata, parseContainer, signC2pa } from "../../packages/core/src/index.js";
import { CERT_DIR, fullJpeg, fullPng, fullWebp, plainJpeg, testSigner } from "../../packages/core/test/helpers/fixtures.js";

const ROOT = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const BIN = resolve(ROOT, opt("bin", `dist/bin/imgwand-${process.platform}-${process.arch}`));
const OUT = resolve(ROOT, opt("out", "screenshots"));
const CHROME = opt("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const COLS = 150;
const ROWS = 40;
const SOCKET = "imgwand-shots";

// --- workspace -----------------------------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "imgwand-shots-"));
const home = join(work, "home");
const binDir = join(work, "bin");
const photos = join(work, "photos");
mkdirSync(join(home, ".config", "imgwand"), { recursive: true });
mkdirSync(binDir, { recursive: true });
symlinkSync(BIN, join(binDir, "imgwand"));
mkdirSync(join(photos, "archive"), { recursive: true });
writeFileSync(join(home, ".config", "imgwand", "config.json"), JSON.stringify({ signer: { cert: join(CERT_DIR, "es256.pub"), key: join(CERT_DIR, "es256.pem"), alg: "es256" } }, null, 2));
const training = { label: "cawg.training-mining", data: { entries: { "cawg.ai_generative_training": { use: "notAllowed" }, "cawg.ai_inference": { use: "notAllowed" } } } };
writeFileSync(join(photos, "sunset.jpg"), await signC2pa(await fullJpeg({ width: 960, height: 600 }), "image/jpeg", { signer: testSigner(), title: "sunset.jpg", digitalSourceType: "digitalCapture", assertions: [training] }));
writeFileSync(join(photos, "alfama.png"), await fullPng());
writeFileSync(join(photos, "pixel.webp"), await fullWebp());
writeFileSync(join(photos, "plain.jpg"), await plainJpeg(640, 400));
writeFileSync(join(photos, "archive", "old.jpg"), await fullJpeg({ width: 480, height: 300 }));
copyFileSync(join(photos, "sunset.jpg"), join(work, "signed.jpg"));
copyFileSync(join(photos, "sunset.jpg"), join(work, "photo.jpg"));

// One file per C2PA validation state, for the direct-terminal shots (the TUI flows change sunset.jpg).
const states = join(work, "states");
mkdirSync(states);
const signed = new Uint8Array(readFileSync(join(photos, "sunset.jpg")));
writeFileSync(join(states, "sunset.jpg"), signed);
writeFileSync(join(states, "trusted.jpg"), signed);
const store = parseContainer(signed).blocks.find((b) => b.kind === "c2pa")!;
const badSignature = signed.slice();
for (let i = 0; i < 8; i++) badSignature[store.offset + store.raw.length - 40 + i]! ^= 0xff; // inside the claim signature
writeFileSync(join(states, "bad-signature.jpg"), badSignature);
writeFileSync(join(states, "edited.jpg"), editMetadata(signed, { set: { "exif:IFD0:Artist": "Someone Else" } }).bytes);
// A second home whose config trusts the test signer's root, for the Trusted state.
const trustingHome = join(work, "trusting-home");
mkdirSync(join(trustingHome, ".config", "imgwand"), { recursive: true });
writeFileSync(join(work, "anchors.pem"), readFileSync(join(CERT_DIR, "es256.pub"), "utf8").split(/(?=-----BEGIN CERTIFICATE-----)/).at(-1)!);
writeFileSync(join(trustingHome, ".config", "imgwand", "config.json"), JSON.stringify({ trustAnchors: join(work, "anchors.pem") }));

// --- tmux --------------------------------------------------------------------------------------------------------

const tmuxConf = join(work, "tmux.conf");
// Panes run under /bin/sh so no user shell startup files (which may change PATH) are involved.
writeFileSync(tmuxConf, ['set -g default-shell /bin/sh', 'set -g default-terminal "tmux-256color"', 'set -as terminal-features ",*:RGB"', "set -g allow-passthrough on", "set -g status off", "set -g history-limit 5000", "set -sg escape-time 10"].join("\n"));
const tmux = (...a: string[]) => execFileSync("tmux", ["-L", SOCKET, "-f", tmuxConf, ...a], { encoding: "utf8" });
// Only the binary under test is on PATH (as "imgwand"), so the shell steps cannot pick up an npm install.
const tmuxDir = execFileSync("sh", ["-c", "dirname \"$(command -v tmux)\""], { encoding: "utf8" }).trim();
const env = { HOME: home, PATH: `${binDir}:${tmuxDir}:/usr/bin:/bin`, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8", TERM_PROGRAM: "imgwand-shots" };
const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

function startSession(command: string): void {
  spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
  tmux("new-session", "-d", "-s", "shots", "-x", String(COLS), "-y", String(ROWS), ...envArgs, "-c", photos, command);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function keys(...k: string[]): Promise<void> {
  for (const key of k) {
    tmux("send-keys", "-t", "shots", key);
    await sleep(key === "Escape" ? 120 : 60);
  }
}
async function type(text: string): Promise<void> {
  tmux("send-keys", "-t", "shots", "-l", text);
  await sleep(80);
}
const plain = () => tmux("capture-pane", "-t", "shots", "-p");
const ansi = () => tmux("capture-pane", "-t", "shots", "-p", "-e", "-N");
async function waitFor(pattern: RegExp, timeout = 15000): Promise<void> {
  const start = Date.now();
  while (!pattern.test(plain())) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${pattern}:\n${plain()}`);
    await sleep(100);
  }
  await sleep(250); // let the frame settle
}

// --- rendering ---------------------------------------------------------------------------------------------------

let browser: Browser | undefined;
const shots: { file: string; title: string; caption: string }[] = [];

async function render(file: string, data: string | Uint8Array, cols: number, rows: number): Promise<void> {
  const page = await browser!.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #11111b; } .xterm-viewport { overflow: hidden !important; } #frame { display: inline-block; padding: 14px; background: #1e1e2e; border-radius: 10px; margin: 12px; }
  </style></head><body><div id="frame"><div id="term"></div></div></body></html>`);
  await page.addStyleTag({ path: join(ROOT, "node_modules/@xterm/xterm/css/xterm.css") });
  await page.addScriptTag({ path: join(ROOT, "node_modules/@xterm/xterm/lib/xterm.js") });
  await page.addScriptTag({ path: join(ROOT, "node_modules/@xterm/addon-image/lib/addon-image.js") });
  // Raw recordings are bytes (UTF-8 text and binary image payloads): passed as base64 and written as bytes.
  const encoded = typeof data === "string" ? { text: data } : { base64: Buffer.from(data).toString("base64") };
  await page.evaluate(
    async (payload: { text?: string; base64?: string }, c: number, r: number) => {
      const w = window as unknown as { Terminal: new (o: object) => any; ImageAddon: { ImageAddon: new (o: object) => any } };
      const term = new w.Terminal({
        cols: c,
        rows: r,
        fontFamily: "Menlo, 'SF Mono', Monaco, monospace",
        fontSize: 13,
        lineHeight: 1.0,
        allowProposedApi: true,
        customGlyphs: true,
        theme: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#1e1e2e" },
      });
      term.loadAddon(new w.ImageAddon.ImageAddon({ sixelSupport: true, iipSupport: true, pixelLimit: 32 * 1024 * 1024 }));
      term.open(document.getElementById("term")!);
      const input = payload.base64 !== undefined ? Uint8Array.from(atob(payload.base64), (ch) => ch.charCodeAt(0)) : payload.text!;
      await new Promise<void>((done) => term.write(input, done));
      await new Promise((done) => setTimeout(done, 300));
    },
    encoded,
    cols,
    rows,
  );
  const frame = await page.$("#frame");
  await frame!.screenshot({ path: file });
  await page.close();
}

async function shot(name: string, title: string, caption: string): Promise<void> {
  const file = join(OUT, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`);
  // tmux lines end with \n; a terminal needs \r\n.
  const data = ansi().replace(/\n$/, "").split("\n").join("\r\n");
  await render(file, data, COLS, ROWS);
  shots.push({ file, title, caption });
  console.log(`  ✓ ${file}`);
}

/** Raw protocol output (sixel / iTerm2 / blocks) rendered by xterm.js directly, outside tmux. */
async function rawShot(name: string, title: string, caption: string, graphics: string, cols: number, rows: number): Promise<void> {
  const out = execFileSync(BIN, ["--graphics", graphics, "preview", join(photos, "sunset.jpg"), "-W", String(cols - 2), "-H", String(rows - 2)], { env: { ...process.env, ...env } });
  const file = join(OUT, `${String(shots.length + 1).padStart(2, "0")}-${name}.png`);
  const header = `\x1b[1;38;2;255;159;26m$ imgwand --graphics ${graphics} preview sunset.jpg\x1b[0m\r\n`;
  await render(file, header + out.toString("latin1").replace(/\n/g, "\r\n"), cols, rows + 4);
  shots.push({ file, title, caption });
  console.log(`  ✓ ${file}`);
}

interface PtyStep {
  readonly keys?: string;
  readonly wait?: number;
  readonly shot?: { readonly name: string; readonly title: string; readonly caption: string };
}

/** Runs imgwand on a file directly in a pseudo-terminal (no tmux), and shoots the screen at the marked steps. */
async function ptySession(file: string, graphics: string, steps: readonly PtyStep[], homeDir = home): Promise<void> {
  const prefix = join(work, `pty-${shots.length}`);
  const recorded = steps.map((s) => ({ keys: s.keys ?? "", wait: s.wait ?? 1.5, mark: s.shot?.name }));
  execFileSync("python3", [join(ROOT, "scripts/screenshots/pty-record.py"), prefix, String(COLS), String(ROWS), JSON.stringify(recorded), BIN, file], {
    env: { ...env, HOME: homeDir, IMGWAND_GRAPHICS: graphics },
    stdio: "ignore",
  });
  const stream = readFileSync(`${prefix}.bin`);
  const marks = JSON.parse(readFileSync(`${prefix}.json`, "utf8")) as Record<string, number>;
  for (const { shot: s } of steps) {
    if (!s) continue;
    if (marks[s.name] === undefined) throw new Error(`pty session did not reach ${s.name}`);
    const out = join(OUT, `${String(shots.length + 1).padStart(2, "0")}-${s.name}.png`);
    await render(out, stream.subarray(0, marks[s.name]), COLS, ROWS);
    shots.push({ file: out, title: s.title, caption: s.caption });
    console.log(`  ✓ ${out}`);
  }
}

// --- flows -------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!existsSync(BIN)) throw new Error(`No binary at ${BIN}; build it with: npx tsx scripts/build-binaries.ts host`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--font-render-hinting=none"] });
  const iw = JSON.stringify(BIN);

  console.log("TUI: browse, inspect, C2PA, edit, write");
  startSession(`${iw} --graphics blocks ${JSON.stringify(photos)}; sleep 600`);
  await waitFor(/Images\(/);
  await shot("browser", "Browser", "imgwand opens on a folder: subfolders and supported images (JPEG, PNG, WebP), k9s-style header with context and key hints.");
  await keys("/");
  await type("a");
  await waitFor(/<\/a>/);
  await shot("browser-filter", "Filtering", "/ filters the list as you type.");
  await keys("Escape");
  await waitFor(/plain\.jpg/);
  await keys("G", "Enter");
  await waitFor(/Signed By/);
  await shot("inspector", "Metadata inspector", "sunset.jpg: every field grouped (C2PA, EXIF, GPS, thumbnail, XMP, IPTC, Photoshop, ICC, comments), identifying fields flagged with •, a live preview (colored blocks inside tmux; real pictures directly in a terminal, see below) and field details on the right.");
  await keys("/");
  await type("gps");
  await keys("Enter");
  await waitFor(/<\/gps>/);
  await shot("inspector-gps", "Filtered to GPS", "Filtering by 'gps' finds the EXIF GPS IFD and the XMP GPS property; values are decoded (degrees, minutes, seconds and decimal).");
  await keys("Escape");
  await waitFor(/Metadata\(sunset\.jpg\) \[\d+\]\s/);

  await keys("c");
  await waitFor(/Content Credentials/);
  await shot("c2pa", "Content Credentials", "c opens the C2PA view: validation state, signer, actions and assertions of the signed manifest, validated with the official C2PA SDK.");
  await keys("r");
  await waitFor(/Redact assertion/);
  await shot("c2pa-redact-prompt", "Redacting an assertion", "r prompts for an assertion to redact, suggesting the ones that can be redacted.");
  await keys("Enter");
  await waitFor(/Redacted cawg\.training-mining and re-signed/);
  await waitFor(/Manifest 2/);
  await sleep(400);
  await shot("c2pa-redacted", "Redacted and re-signed", "The new active manifest records the redaction and keeps the original manifest as its parent ingredient; the redacted assertion is gone from it.");
  await keys("w");
  await waitFor(/Write changes to sunset\.jpg/);
  await shot("write-signature", "Writing the new signature", "w shows exactly what will be written before anything touches the disk.");
  await keys("y");
  await waitFor(/Wrote sunset\.jpg/);
  await sleep(600);
  await keys("Escape");
  await waitFor(/Make\s+Fujifilm/);

  await keys("/");
  await type("serial");
  await keys("Enter");
  await waitFor(/<\/serial>/);
  await keys("j", "Space", "Space");
  await waitFor(/●/);
  await shot("marked", "Marking fields", "space marks fields (●); a marks a whole group.");
  await keys("d");
  await waitFor(/Staged 2 fields/);
  await shot("staged", "Staged removals", "d stages the marked fields for removal (✗, struck through). Nothing is written yet; u undoes.");
  await keys("Escape");
  await waitFor(/Make\s+Fujifilm/);
  await keys("/");
  await type("software");
  await keys("Enter");
  await waitFor(/<\/software>/);
  await keys("j", "e");
  await waitFor(/exif:IFD0:Software = /);
  for (let i = 0; i < 12; i++) await keys("BSpace");
  await type("imgwand");
  await shot("edit", "Editing a value", "e edits the selected field in place.");
  await keys("Enter");
  await waitFor(/Staged new value/);
  await shot("edit-staged", "Staged edit", "The new value is staged (~) next to the old one.");
  await keys("Escape");
  await waitFor(/Make\s+Fujifilm/);
  await keys(":");
  await type("rm thumbnail xmp:xmpMM:*");
  await shot("command", "Command line", "The : command line takes selectors: groups, ids, globs and presets.");
  await keys("Enter");
  await waitFor(/Staged \d+ fields for removal/);
  await keys("P");
  await waitFor(/\(privacy\)/);
  await shot("privacy", "Privacy preset", "P stages the privacy preset: location, names, serial numbers, comments, document IDs and thumbnails. Camera settings, the ICC profile and C2PA stay.");
  await keys("w");
  await waitFor(/Write changes to sunset\.jpg/);
  await shot("write-c2pa-choice", "Writing a signed file", "The file is signed, so removing anything invalidates its Content Credentials: imgwand asks whether to remove them too or keep the invalid manifest.");
  await keys("r");
  await waitFor(/Wrote sunset\.jpg/);
  await sleep(600); // input is ignored while a write is still finishing
  await shot("written", "Written", "Written atomically; the compressed picture is byte-identical (verified before writing). The remaining fields are what the photo still says about itself.");
  await keys("?");
  await waitFor(/Commands/);
  await shot("help", "Help", "? lists every key and command.");
  await keys("?");
  await waitFor(/Metadata\(sunset\.jpg\)/);
  await keys("p");
  await waitFor(/cycle graphics/);
  await shot("preview-fullscreen", "Full-screen preview", "p previews full screen with the best protocol the terminal supports (here colored half blocks inside tmux; see the sixel and iTerm2 renders below).");
  await keys("g");
  await waitFor(/ascii/);
  await shot("preview-ascii", "Graphics fallback", "g cycles through the available renderers.");
  await keys("q");
  await waitFor(/Metadata\(sunset\.jpg\)/);
  await keys("D", "k");
  await waitFor(/all except ICC profile and orientation/);
  await keys("q");
  await waitFor(/Unsaved changes/);
  await shot("quit-guard", "Unsaved changes", "Quitting or leaving with staged edits asks first.");
  await keys("d");
  await sleep(500);

  console.log("CLI commands");
  startSession(`env PS1='$ ' PATH=${JSON.stringify(env.PATH)} /bin/sh`);
  await sleep(500);
  const run = async (command: string, done: RegExp) => {
    await keys("C-l");
    await type(command);
    await keys("Enter");
    await waitFor(done);
  };
  await keys("C-l");
  await run(`cd ${JSON.stringify(work)} && command -v imgwand && imgwand -v`, /Config/);
  await shot("cli-info", "Diagnostics (inside tmux)", "imgwand -v: the standalone binary's native libraries and how it sees the terminal, including the outer terminal of tmux and passthrough.");
  await run("imgwand show photo.jpg | head -60", /^\$\s*$/m);
  await shot("cli-show", "imgwand show", "The same report for scripts and pipes (--json for machines).");
  await run("imgwand strip photo.jpg -f privacy -o clean.jpg", /^\$\s*$/m);
  await shot("cli-strip-refused", "Content Credentials guard", "Editing a signed file without saying what to do with its Content Credentials is refused, with the options explained.");
  await run("imgwand strip photo.jpg -f privacy --c2pa remove -o clean.jpg", /^\$\s*$/m);
  await shot("cli-strip", "imgwand strip", "Every removed field is listed; the original is untouched (-o clean.jpg).");
  await run("imgwand show clean.jpg | head -38", /^\$\s*$/m);
  await shot("cli-show-clean", "The result", "What clean.jpg still says about itself: camera settings, keywords and the color profile, without location, names, serial numbers or Content Credentials.");
  await run("imgwand c2pa show signed.jpg", /^\$\s*$/m);
  await shot("cli-c2pa", "imgwand c2pa show", "Validation with the official C2PA SDK: the test certificate is valid but not on a trust list (pass --trust to add anchors).");
  await run(`imgwand c2pa redact signed.jpg cawg.training-mining --cert ${JSON.stringify(join(CERT_DIR, "es256.pub"))} --key ${JSON.stringify(join(CERT_DIR, "es256.pem"))} -o redacted.jpg | tail -25`, /^\$\s*$/m);
  await shot("cli-redact", "imgwand c2pa redact", "Redaction re-signs with a new manifest that keeps the history.");
  spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });

  console.log("Directly in the terminal (no tmux): inline images and validation states");
  const open = { wait: 4 };
  await ptySession(join(states, "sunset.jpg"), "iterm", [
    { ...open, shot: { name: "inspector-iterm", title: "Inline image in the side panel (iTerm2)", caption: "Outside tmux, the side panel shows the real picture in the terminal's own protocol (here iTerm2, also WezTerm), drawn over the cells the layout reserves for it and redrawn after every frame. Inside tmux it uses colored blocks, as in the shots above." } },
    { keys: "c", shot: { name: "c2pa-valid", title: "C2PA: Valid (yellow)", caption: "Signature verified, signer not on a trust list. The ladder line shows which of the C2PA specification's validation states were reached; the untrusted signer is a warning (!), not an error. The image is erased before the screen changes." } },
  ]);
  await ptySession(join(states, "sunset.jpg"), "sixel", [{ ...open, shot: { name: "inspector-sixel", title: "Inline image in the side panel (sixel)", caption: "The same with sixel (foot, Windows Terminal, mlterm, contour, ...)." } }]);
  await ptySession(join(states, "trusted.jpg"), "iterm", [open, { keys: "c", shot: { name: "c2pa-trusted", title: "C2PA: Trusted (green)", caption: "The same file with the signer's root in trustAnchors (config.json or --trust): verified and trusted." } }], trustingHome);
  await ptySession(join(states, "bad-signature.jpg"), "iterm", [open, { keys: "c", shot: { name: "c2pa-well-formed", title: "C2PA: Well-formed (white)", caption: "Eight bytes of the claim signature changed: the manifest still parses and is structurally sound, but its signature does not verify. The C2PA SDK only says Invalid; imgwand names the specification's state." } }]);
  await ptySession(join(states, "edited.jpg"), "iterm", [open, { keys: "c", shot: { name: "c2pa-invalid", title: "C2PA: Invalid (red)", caption: "The Artist was changed after signing: the image no longer matches its manifest. imgwand says so, and that the manifest itself is still valid." } }]);

  console.log("High-quality previews (raw protocol output rendered by xterm.js)");
  await rawShot("preview-sixel", "Sixel", "imgwand preview --graphics sixel: palette-quantized (libimagequant) sixel, decoded by xterm.js's image addon.", "sixel", 100, 32);
  await rawShot("preview-iterm", "iTerm2 inline image", "imgwand preview --graphics iterm: full-resolution PNG via the iTerm2 protocol (also WezTerm).", "iterm", 100, 32);
  await rawShot("preview-blocks", "Colored half blocks", "imgwand preview --graphics blocks: the fallback that works in every truecolor terminal.", "blocks", 100, 32);

  await browser!.close();
  const index = [
    "# imgwand screenshots",
    "",
    `Generated by \`scripts/screenshots/run.ts\` from ${BIN.endsWith(".js") ? "the npm bundle" : "the standalone binary"} running in tmux (${COLS}×${ROWS}), and directly in a pseudo-terminal for inline images, rendered with xterm.js and its image addon.`,
    "",
    ...shots.flatMap((s, i) => [`## ${i + 1}. ${s.title}`, "", s.caption, "", `![${s.title}](${s.file.split("/").pop()})`, ""]),
  ].join("\n");
  writeFileSync(join(OUT, "README.md"), index);
  rmSync(work, { recursive: true, force: true });
  console.log(`${shots.length} screenshots in ${OUT}`);
}

try {
  await main();
} catch (error) {
  spawnSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
  await browser?.close().catch(() => undefined);
  console.error(error);
  console.error(`(workspace kept at ${work})`);
  process.exit(1);
}
