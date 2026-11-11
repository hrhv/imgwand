import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { renderPaletted, renderRaster } from "@hrhv/imgwand";
import { detectCapabilities, guessFromEnvironment, queryTerminal, tmuxInfo, tmuxWrap, type Capabilities, type Exec } from "../../src/terminal/capabilities.js";
import {
  asciiFromRaster,
  blocksFromRaster,
  encodeBlocks,
  encodeImage,
  encodeIterm,
  encodeKitty,
  encodeSixel,
  isPixelProtocol,
  kittyChunks,
  kittyClear,
  kittyPlaceholders,
  sixelFromPaletted,
} from "../../src/terminal/encoders.js";
import { DIACRITICS } from "../../src/terminal/diacritics.js";
import { fullJpeg } from "../../../core/test/helpers/fixtures.js";

const noTmux: Exec = () => undefined;
const tmux = (client: string, type: string, passthrough = "on"): Exec => (command, args) => {
  if (command !== "tmux") return undefined;
  if (args[0] === "display-message") return `${client}\t${type}`;
  if (args[0] === "show-options") return passthrough;
  if (args[0] === "-V") return "tmux 3.6a";
  return undefined;
};

describe("terminal detection", () => {
  it.each([
    [{ KITTY_WINDOW_ID: "1" }, "kitty", "kitty"],
    [{ TERM: "xterm-kitty" }, "kitty", "kitty"],
    [{ TERM_PROGRAM: "ghostty" }, "kitty", "Ghostty"],
    [{ GHOSTTY_RESOURCES_DIR: "/x" }, "kitty", "Ghostty"],
    [{ TERM_PROGRAM: "WezTerm" }, "iterm", "WezTerm"],
    [{ TERM_PROGRAM: "iTerm.app" }, "iterm", "iTerm2"],
    [{ LC_TERMINAL: "iTerm2" }, "iterm", "iTerm2"],
    [{ KONSOLE_VERSION: "230800" }, "kitty", "Konsole"],
    [{ TERM_PROGRAM: "WarpTerminal" }, "kitty", "Warp"],
    [{ WT_SESSION: "x" }, "sixel", "Windows Terminal"],
    [{ TERM: "foot" }, "sixel", "foot"],
    [{ TERM: "mlterm" }, "sixel", "mlterm"],
    [{ TERM_PROGRAM: "Apple_Terminal" }, "blocks", "Terminal.app"],
    [{ TERM_PROGRAM: "vscode" }, "blocks", "VS Code"],
    [{ TERM: "dumb" }, "ascii", "dumb"],
    [{}, "ascii", "unknown"],
    [{ TERM: "xterm-256color" }, "blocks", "xterm-256color"],
  ])("%o → %s", (env, protocol, terminal) => {
    const caps = detectCapabilities({ env, exec: noTmux });
    expect(caps.protocol).toBe(protocol);
    expect(caps.terminal).toBe(terminal);
    expect(caps.tmux).toBeUndefined();
  });

  it("looks through tmux at the outer terminal and uses placeholders for kitty", () => {
    const caps = detectCapabilities({ env: { TMUX: "/tmp/tmux", TERM: "tmux-256color" }, exec: tmux("xterm-kitty", "kitty 0.40") });
    expect(caps.protocol).toBe("kitty");
    expect(caps.reason).toMatch(/outer terminal of tmux/);
    expect(caps.kittyPlaceholders).toBe(true);
    expect(caps.tmux).toMatchObject({ clientTermName: "xterm-kitty", passthrough: true, version: "3.6a" });
    expect(detectCapabilities({ env: { TMUX: "x" }, exec: tmux("xterm-256color", "iTerm2 3.5.0") }).protocol).toBe("iterm");
    expect(detectCapabilities({ env: { TMUX: "x" }, exec: tmux("xterm-ghostty", "ghostty 1.2") }).protocol).toBe("kitty");
    expect(detectCapabilities({ env: { TMUX: "x" }, exec: tmux("xterm", "WezTerm 2024") }).protocol).toBe("iterm");
  });

  it("falls back to blocks with a hint when tmux passthrough is off", () => {
    const caps = detectCapabilities({ env: { TMUX: "x" }, exec: tmux("xterm-kitty", "kitty", "off") });
    expect(caps.protocol).toBe("blocks");
    expect(caps.hints.join(" ")).toMatch(/allow-passthrough on/);
    expect(detectCapabilities({ env: { TMUX: "x" }, exec: tmux("xterm-kitty", "kitty", "all") }).protocol).toBe("kitty");
    expect(tmuxInfo({}, noTmux)).toBeUndefined();
    expect(tmuxInfo({ TMUX: "x" }, noTmux)).toEqual({ clientTermName: undefined, clientTermType: undefined, passthrough: false, version: undefined });
  });

  it("honors forced modes, queries and the environment override", () => {
    expect(detectCapabilities({ env: { KITTY_WINDOW_ID: "1" }, exec: noTmux, force: "sixel" }).protocol).toBe("sixel");
    expect(detectCapabilities({ env: { IMGWAND_GRAPHICS: "ascii", KITTY_WINDOW_ID: "1" }, exec: noTmux }).protocol).toBe("ascii");
    expect(detectCapabilities({ env: { IMGWAND_GRAPHICS: "wat" }, exec: noTmux }).hints.join()).toMatch(/Unknown graphics mode/);
    expect(detectCapabilities({ env: { KITTY_WINDOW_ID: "1" }, exec: noTmux, force: "auto" }).protocol).toBe("kitty");
    expect(detectCapabilities({ env: { TERM: "xterm" }, exec: noTmux, query: { sixel: true } }).protocol).toBe("sixel");
    expect(detectCapabilities({ env: { TERM: "xterm" }, exec: noTmux, query: { kitty: true } }).protocol).toBe("kitty");
    const measured = detectCapabilities({ env: {}, exec: noTmux, query: { cell: { width: 10, height: 21 } } });
    expect(measured.cell).toEqual({ width: 10, height: 21, measured: true });
    expect(detectCapabilities({ env: { COLORTERM: "truecolor" }, exec: noTmux }).truecolor).toBe(true);
    expect(guessFromEnvironment({ TERM: "contour" }).protocol).toBe("sixel");
  });

  it("wraps sequences for tmux passthrough", () => {
    expect(tmuxWrap("\x1b_Ga=q\x1b\\")).toBe("\x1bPtmux;\x1b\x1b_Ga=q\x1b\x1b\\\x1b\\");
  });

  it("queries the terminal through a private tty handle", async () => {
    const fake = Object.assign(new EventEmitter(), {
      isTTY: true,
      raw: [] as boolean[],
      destroyed: false,
      setRawMode(v: boolean) {
        this.raw.push(v);
      },
      destroy() {
        this.destroyed = true;
      },
    });
    const writes: string[] = [];
    const stdout = { isTTY: true, write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WriteStream;
    const pending = queryTerminal({ stdout, openTty: () => fake as unknown as NodeJS.ReadStream }, 500, true);
    fake.emit("data", Buffer.from("\x1b_Gi=31;OK\x1b\\\x1b[6;20;10t"));
    fake.emit("data", Buffer.from("\x1b[?62;4;22c"));
    expect(await pending).toEqual({ kitty: true, sixel: true, cell: { width: 10, height: 20 } });
    expect(writes[0]).toContain("\x1bPtmux;");
    expect(fake.raw).toEqual([true, false]);
    expect(fake.destroyed).toBe(true);
    expect(await queryTerminal({ stdout: { isTTY: false } as NodeJS.WriteStream })).toBeUndefined();
    expect(await queryTerminal({ stdout, openTty: () => undefined })).toBeUndefined();
    const silent = Object.assign(new EventEmitter(), { setRawMode() {}, destroy() {} });
    expect(await queryTerminal({ stdout, openTty: () => silent as unknown as NodeJS.ReadStream }, 20)).toEqual({ kitty: false, sixel: false, cell: undefined });
  });
});

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  protocol: "kitty",
  reason: "test",
  terminal: "test",
  truecolor: true,
  kittyPlaceholders: false,
  cell: { width: 8, height: 16, measured: false },
  hints: [],
  ...over,
});

describe("encoders", () => {
  it("chunks kitty payloads at 4096 bytes", () => {
    const chunks = kittyChunks("a=T,f=100", "x".repeat(9000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatch(/^\x1b_Ga=T,f=100,m=1;x{4096}\x1b\\$/);
    expect(chunks[1]).toMatch(/^\x1b_Gm=1;/);
    expect(chunks[2]).toMatch(/^\x1b_Gm=0;x{808}\x1b\\$/);
    expect(kittyChunks("a=T", "")).toEqual(["\x1b_Ga=T,m=0;\x1b\\"]);
  });

  it("draws kitty images directly, or with placeholders inside tmux", async () => {
    const bytes = await fullJpeg();
    const direct = await encodeKitty(bytes, { cols: 20, rows: 10 }, caps());
    expect(direct.output.startsWith("\x1b_Ga=T,f=100,")).toBe(true);
    expect(direct.output).toContain("c=20");
    expect(direct.cols).toBe(20);
    expect(direct.rows).toBeLessThanOrEqual(10);
    const tm = await encodeKitty(bytes, { cols: 20, rows: 10 }, caps({ tmux: { passthrough: true }, kittyPlaceholders: true }), 0x010203);
    expect(tm.output).toContain("\x1bPtmux;\x1b\x1b_Ga=t,f=100,i=66051");
    expect(tm.output).toContain("a=p,U=1,i=66051");
    expect(tm.output).toContain("\x1b[38;2;1;2;3m");
    expect(tm.output.split("\n")).toHaveLength(tm.rows);
    expect(kittyClear(caps())).toBe("\x1b_Ga=d,d=A,q=2\x1b\\");
    expect(kittyClear(caps({ tmux: { passthrough: true } }))).toMatch(/^\x1bPtmux;/);
  });

  it("encodes placeholder rows with row/column diacritics", () => {
    const text = kittyPlaceholders(5, 3, 2);
    const rows = text.split("\n");
    expect(rows).toHaveLength(2);
    expect([...rows[1]!].filter((c) => c === "\u{10EEEE}")).toHaveLength(3);
    expect(rows[1]).toContain(String.fromCodePoint(DIACRITICS[1]!));
    expect(new Set(DIACRITICS).size).toBe(DIACRITICS.length);
  });

  it("writes iTerm2 inline images", async () => {
    const r = await encodeIterm(await fullJpeg(), { cols: 30, rows: 12 }, caps({ protocol: "iterm" }));
    expect(r.output).toMatch(/^\x1b\]1337;File=inline=1;size=\d+;width=\d+;height=\d+;preserveAspectRatio=1:[A-Za-z0-9+/=]+\x07$/);
    const wrapped = await encodeIterm(await fullJpeg(), { cols: 30, rows: 12 }, caps({ protocol: "iterm", tmux: { passthrough: true } }));
    expect(wrapped.output.startsWith("\x1bPtmux;\x1b\x1b]1337")).toBe(true);
  });

  it("encodes sixel with a palette, bands and run-length encoding", async () => {
    const img = { width: 8, height: 7, indices: new Uint8Array(56).fill(1), palette: Uint8Array.of(0, 0, 0, 255, 0, 0) };
    img.indices[0] = 0;
    const s = sixelFromPaletted(img);
    expect(s.startsWith('\x1bPq"1;1;8;7#0;2;0;0;0#1;2;100;0;0')).toBe(true);
    expect(s.endsWith("\x1b\\")).toBe(true);
    expect(s.match(/-/g)).toHaveLength(2); // two bands for 7 rows
    expect(s).toContain("!7"); // run of 7 identical columns
    const real = await encodeSixel(await fullJpeg(), { cols: 10, rows: 5 }, caps({ protocol: "sixel" }));
    expect(real.output.startsWith("\x1bPq")).toBe(true);
    const pal = await renderPaletted(await fullJpeg(), { width: 80, height: 80 });
    expect(sixelFromPaletted(pal).length).toBeGreaterThan(100);
  });

  it("draws colored half blocks and ASCII art", async () => {
    const raster = { width: 2, height: 3, data: Uint8Array.of(255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255, 1, 1, 1, 0) };
    const blocks = blocksFromRaster(raster);
    const lines = blocks.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\x1b[38;2;255;0;0m\x1b[48;2;0;255;0m▀"); // both opaque
    expect(lines[0]).toContain("\x1b[0m "); // both transparent
    expect(lines[1]).toContain("\x1b[49m\x1b[38;2;0;0;255m▀"); // top only (no bottom row)
    expect(blocksFromRaster(raster, false)).toContain("\x1b[38;5;196m");
    const bottomOnly = blocksFromRaster({ width: 1, height: 2, data: Uint8Array.of(0, 0, 0, 0, 9, 9, 9, 255) });
    expect(bottomOnly).toContain("▄");
    expect(asciiFromRaster({ width: 2, height: 2, data: Uint8Array.of(255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0) })).toBe("@ ");
    const r = await encodeBlocks(await fullJpeg(), { cols: 40, rows: 10 }, { truecolor: true });
    expect(r.cols).toBeLessThanOrEqual(40);
    expect(r.output.split("\n")).toHaveLength(r.rows);
    const raster2 = await renderRaster(await fullJpeg(), { width: 10, height: 10 });
    expect(asciiFromRaster(raster2).split("\n").length).toBe(Math.ceil(raster2.height / 2));
  });

  it("dispatches on the protocol", async () => {
    const bytes = await fullJpeg();
    for (const protocol of ["kitty", "iterm", "sixel", "blocks", "ascii", "none"] as const) {
      const r = await encodeImage(bytes, { cols: 12, rows: 6 }, caps({ protocol }));
      expect(r.protocol).toBe(protocol);
    }
    expect(isPixelProtocol("kitty")).toBe(true);
    expect(isPixelProtocol("blocks")).toBe(false);
  });
});
