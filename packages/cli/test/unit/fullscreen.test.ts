import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Capabilities } from "../../src/terminal/capabilities.js";
import { drawFullscreen, runFullscreenPreview } from "../../src/tui/fullscreen.js";
import { defaultDeps } from "../../src/tui/index.js";
import { listDir } from "../../src/tui/fs.js";
import { CERT_DIR, fullJpeg, plainJpeg } from "../../../core/test/helpers/fixtures.js";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  protocol: "blocks",
  reason: "test",
  terminal: "test",
  truecolor: true,
  kittyPlaceholders: false,
  cell: { width: 8, height: 16, measured: false },
  hints: [],
  ...over,
});

function fakeIo() {
  const writes: string[] = [];
  const tty = Object.assign(new EventEmitter(), {
    modes: [] as boolean[],
    destroyed: false,
    setRawMode(v: boolean) {
      this.modes.push(v);
    },
    destroy() {
      this.destroyed = true;
    },
  });
  const stdout = { columns: 40, rows: 12, write: (s: string) => (writes.push(s), true) };
  return { tty, openTty: () => tty as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, writes };
}

describe("full-screen preview", () => {
  it("draws text protocols line by line, centered, with a status bar", async () => {
    const io = fakeIo();
    await drawFullscreen(io, { bytes: await fullJpeg(), title: "photo.jpg", capabilities: caps() }, "blocks");
    const out = io.writes.join("");
    expect(out).toMatch(/\x1b\[2J/);
    expect(out).toMatch(/\x1b\[\d+;\d+H\x1b\[38;2;/);
    expect(out).toMatch(/\x1b\[12;1H\x1b\[0m\x1b\[7m photo\.jpg {2}· {2}blocks/);
  });

  it("draws pixel protocols at the image origin and marks fallbacks", async () => {
    const io = fakeIo();
    await drawFullscreen(io, { bytes: await fullJpeg(), title: "p", capabilities: caps({ protocol: "kitty" }) }, "kitty");
    expect(io.writes.join("")).toMatch(/\x1b_Ga=d,d=A,q=2\x1b\\\x1b\[2J\x1b\[\d+;\d+H\x1b_Ga=T/);
    const io2 = fakeIo();
    await drawFullscreen(io2, { bytes: await fullJpeg(), title: "p", capabilities: caps({ protocol: "kitty" }) }, "ascii");
    expect(io2.writes.join("")).toMatch(/ascii \(fallback\)/);
  });

  it("cycles protocols with g and returns on any other key, restoring the terminal", async () => {
    const io = fakeIo();
    const done = runFullscreenPreview(io, { bytes: await fullJpeg(), title: "p", capabilities: caps({ protocol: "kitty" }) });
    await new Promise((r) => setTimeout(r, 150));
    io.tty.emit("data", Buffer.from("g"));
    await new Promise((r) => setTimeout(r, 150));
    io.tty.emit("data", Buffer.from("q"));
    await done;
    const out = io.writes.join("");
    expect(out.startsWith("\x1b[?1049h\x1b[?25l")).toBe(true);
    expect(out).toMatch(/· {2}kitty {2}·/);
    expect(out).toMatch(/blocks \(fallback\)/);
    expect(out.endsWith("\x1b[2J\x1b[H")).toBe(true);
    expect(io.tty.modes).toEqual([true, false]);
    expect(io.tty.destroyed).toBe(true);
    expect(io.tty.listenerCount("data")).toBe(0);
  });

  it("refuses to run without a terminal to read keys from", async () => {
    const io = fakeIo();
    await expect(runFullscreenPreview({ stdout: io.stdout, openTty: () => undefined }, { bytes: await fullJpeg(), title: "p", capabilities: caps() })).rejects.toThrow(/no terminal/);
  });
});

describe("TUI launcher", () => {
  it("builds default dependencies that read the configured signer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-deps-"));
    writeFileSync(join(dir, "a.jpg"), await fullJpeg());
    const none = defaultDeps({ config: {}, env: {}, capabilities: caps() });
    expect(await none.loadSigner()).toBeUndefined();
    const fromEnv = defaultDeps({ config: {}, env: { IMGWAND_C2PA_CERT: join(CERT_DIR, "es256.pub"), IMGWAND_C2PA_KEY: join(CERT_DIR, "es256.pem") }, capabilities: caps() });
    expect((await fromEnv.loadSigner())?.algorithm).toBe("es256");
    const fromConfig = defaultDeps({ config: { signer: { cert: join(CERT_DIR, "ps256.pub"), key: join(CERT_DIR, "ps256.pem"), alg: "ps256" } }, env: {}, capabilities: caps() });
    expect((await fromConfig.loadSigner())?.algorithm).toBe("ps256");
    const doc = await none.openDocument(join(dir, "a.jpg"));
    expect(doc.fields.length).toBeGreaterThan(10);
    expect((await none.imageInfo(doc.bytes))?.width).toBe(320);
    expect(await none.imageInfo(new Uint8Array(4))).toBeUndefined();
    expect((await none.renderInline(doc.bytes, { cols: 10, rows: 4 })).text).toMatch(/▀/);
  });

  it("lists directories first, then supported images, skipping hidden files and broken links", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-ls-"));
    mkdirSync(join(dir, "b-dir"));
    writeFileSync(join(dir, "z.PNG"), await plainJpeg());
    writeFileSync(join(dir, "a.jpeg"), await plainJpeg());
    writeFileSync(join(dir, "c.webp"), "x");
    writeFileSync(join(dir, "readme.md"), "x");
    writeFileSync(join(dir, ".secret.jpg"), "x");
    symlinkSync(join(dir, "missing"), join(dir, "dangling.jpg"));
    const list = await listDir(dir, false);
    expect(list.map((e) => `${e.kind}:${e.name}:${e.format ?? ""}`)).toEqual(["dir:b-dir:", "image:a.jpeg:JPEG", "image:c.webp:WebP", "image:z.PNG:PNG"]);
    expect((await listDir(dir, true)).some((e) => e.name === ".secret.jpg")).toBe(true);
  });
});

describe("stdinKeys: preview keys from stdin, the way Ink reads it", () => {
  it("reads through a readable listener, holds a ref while waiting, and leaves stdin as Ink left it", async () => {
    const { stdinKeys } = await import("../../src/tui/fullscreen.js");
    const queue: string[] = [];
    const calls: string[] = [];
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      read: () => queue.shift() ?? null,
      setRawMode: (on: boolean) => calls.push(`raw:${on}`),
      ref: () => calls.push("ref"),
      unref: () => calls.push("unref"),
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
    });
    const keys = stdinKeys(stdin as unknown as NodeJS.ReadStream)!;
    expect(stdin.listenerCount("readable")).toBe(1);
    const got: string[] = [];
    keys.on("data", (d: Buffer) => got.push(d.toString()));
    keys.setRawMode(true);
    queue.push("g", "x");
    stdin.emit("readable");
    expect(got).toEqual(["g", "x"]);
    keys.destroy();
    expect(stdin.listenerCount("readable")).toBe(0);
    // Never pause() or resume(): that is what once left Ink unable to read input after the preview.
    expect(calls).toEqual(["ref", "raw:true", "unref"]);
    expect(stdinKeys({ isTTY: false } as NodeJS.ReadStream)).toBeUndefined();
  });
});
