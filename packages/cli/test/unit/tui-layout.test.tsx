import React from "react";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render as inkRender, Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { ImageDocument, signC2pa, writeFileAtomic } from "@hrhv/imgwand";
import type { Capabilities } from "../../src/terminal/capabilities.js";
import { App, type AppDeps } from "../../src/tui/App.js";
import { Header, layoutHints } from "../../src/tui/components.js";
import { listDir } from "../../src/tui/fs.js";
import { INSPECTOR, NAVIGATION } from "../../src/tui/keys.js";
import { ImageOverlay, overlayStdout, renderSideImage, sidePanelProtocol, type SideImage } from "../../src/tui/overlay.js";
import { fullJpeg, testSigner } from "../../../core/test/helpers/fixtures.js";

const ESC = "\x1b";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const caps = (over: Partial<Capabilities> = {}): Capabilities => ({ protocol: "blocks", reason: "test", terminal: "test", truecolor: true, kittyPlaceholders: false, cell: { width: 8, height: 16, measured: false }, hints: [], ...over });

/** A terminal of any size for Ink, recording what is written. */
class Terminal extends EventEmitter {
  writes: string[] = [];
  isTTY = true;
  constructor(readonly columns: number, readonly rows: number) {
    super();
  }
  write = (data: string) => {
    this.writes.push(String(data));
    return true;
  };
}
class Keyboard extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write(data: string) {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  }
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
}

const unmounts: (() => void)[] = [];
afterEach(() => unmounts.splice(0).forEach((u) => u()));

/** Renders once at a given width (debug mode: every frame is written whole) and returns the last frame's lines. */
function frameAt(node: React.ReactElement, columns: number): string[] {
  const term = new Terminal(columns, 30);
  const app = inkRender(node, { stdout: term as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  unmounts.push(() => app.unmount());
  return strip(term.writes.at(-1) ?? "").split("\n");
}

describe("header", () => {
  const context = [
    ["File", "headshot-passport.jpg"],
    ["Image", "JPEG 1000×1000 128.2 KB"],
    ["Fields", "11  staged: −0 ~0"],
    ["C2PA", "Invalid"],
    ["Graphics", "iterm"],
  ] as const;
  const bindings = [...INSPECTOR, ...NAVIGATION];

  it("lines up every column's actions, with the same gap between columns, and nothing cut off", () => {
    const lines = frameAt(<Header width={160} context={context} bindings={bindings} />, 160);
    const startOf = (text: string) => {
      const line = lines.find((l) => l.includes(text))!;
      return line.indexOf(text);
    };
    /** Where an action starts: the first occurrence after its own key. */
    const actionAt = (key: string, action: string) => {
      const line = lines.find((l) => l.includes(`<${key}>`))!;
      return line.indexOf(action, line.indexOf(`<${key}>`));
    };
    // Each column's actions start at the same x, whatever the width of their key.
    const columns: [string, string][][] = [
      [["space", "mark"], ["a", "mark group"], ["d", "delete marked"], ["P", "privacy strip"], ["D", "strip all"]],
      [["e", "edit value"], ["n", "new field"], ["u", "undo"], ["w", "write"], ["c", "C2PA"]],
      [["p", "preview"], ["j/k ↑/↓", "move"], ["g/G", "top / bottom"], ["ctrl-d/u", "page down / up"], ["/", "filter"]],
      [[":", "command"], ["esc", "back / clear"], ["?", "help"], ["q", "quit"]],
    ];
    for (const column of columns) expect(new Set(column.map(([k, a]) => actionAt(k, a))).size).toBe(1);
    // Keys start at the same x too, and columns are 3 apart (widest hint + gap).
    expect(startOf("<space>")).toBe(startOf("<D>"));
    expect(startOf("<p>")).toBe(startOf("<ctrl-d/u>"));
    expect(startOf("<p>") - (actionAt("e", "edit value") + "edit value".length)).toBe(3);
    expect(startOf("<:>") - (actionAt("ctrl-d/u", "page down / up") + "page down / up".length)).toBe(3);
    expect(lines.join("\n")).not.toContain("…");
  });

  it("left-aligns the logo and its subtitle", () => {
    const lines = frameAt(<Header width={160} context={context} bindings={bindings} />, 160);
    const logo = lines.findIndex((l) => l.includes("┏━┓"));
    const x = lines[logo]!.search(/[╻┃╹]/);
    expect(lines[logo + 1]!.search(/[╻┃╹]/)).toBe(x);
    expect(lines.find((l) => l.includes("lossless metadata surgery"))!.indexOf("lossless")).toBe(x);
  });

  it("when narrow, drops columns from the middle but keeps help and quit", () => {
    const { columns, gap } = layoutHints(bindings, 5, 60);
    expect(gap).toBe(2);
    expect(columns.at(-1)!.items.map((b) => b.keys)).toEqual([":", "esc", "?", "q"]);
    expect(columns.reduce((s, c) => s + c.width, 0) + gap * (columns.length - 1)).toBeLessThanOrEqual(60);
    const lines = frameAt(<Header width={100} context={context} bindings={bindings} />, 100);
    expect(lines.join("\n")).toMatch(/<\?> +help/);
    expect(lines.join("\n")).toMatch(/<q> +quit/);
  });
});

describe("side panel graphics", () => {
  it("uses the terminal's own protocol, and text where pixels would not survive (tmux)", () => {
    const tmux = { clientTermName: "xterm", passthrough: true } as unknown as Capabilities["tmux"];
    expect(sidePanelProtocol(caps({ protocol: "iterm" }))).toBe("iterm");
    expect(sidePanelProtocol(caps({ protocol: "sixel" }))).toBe("sixel");
    expect(sidePanelProtocol(caps({ protocol: "kitty" }))).toBe("kitty");
    expect(sidePanelProtocol(caps({ protocol: "iterm", tmux }))).toBe("blocks");
    expect(sidePanelProtocol(caps({ protocol: "sixel", tmux }))).toBe("blocks");
    expect(sidePanelProtocol(caps({ protocol: "kitty", tmux }))).toBe("kitty");
    expect(sidePanelProtocol(caps({ protocol: "ascii" }))).toBe("ascii");
  });

  it("renders iTerm2, sixel and kitty images as overlays, and kitty in tmux as placeholder text", async () => {
    const bytes = await fullJpeg();
    const box = { cols: 40, rows: 12 };
    const iterm = await renderSideImage(bytes, box, caps({ protocol: "iterm" }));
    expect(iterm).toMatchObject({ protocol: "iterm", text: "" });
    expect(iterm.cols).toBeLessThanOrEqual(40);
    expect(iterm.rows).toBeLessThanOrEqual(12);
    expect(iterm.draw).toMatch(new RegExp(`^\\x1b\\]1337;File=inline=1;size=\\d+;width=${iterm.cols};height=${iterm.rows};preserveAspectRatio=1;doNotMoveCursor=1:[A-Za-z0-9+/=]+\\x07$`));
    const sixel = await renderSideImage(bytes, box, caps({ protocol: "sixel" }));
    expect(sixel.draw).toMatch(/^\x1bP/);
    const kitty = await renderSideImage(bytes, box, caps({ protocol: "kitty" }));
    expect(kitty.setup).toMatch(/^\x1b_Ga=t,f=100,i=\d+/);
    expect(kitty.draw).toMatch(/^\x1b_Ga=p,i=\d+,p=1,c=\d+,r=\d+,C=1/);
    expect(kitty.clear).toMatch(/a=d,d=i/);
    const placeholders = await renderSideImage(bytes, box, caps({ protocol: "kitty", kittyPlaceholders: true, tmux: { clientTermName: "xterm-kitty" } as unknown as Capabilities["tmux"] }));
    expect(placeholders.draw).toBeUndefined();
    expect(placeholders.text).toContain("\u{10EEEE}");
    expect(placeholders.setup).toMatch(/^\x1bPtmux;/);
    const blocks = await renderSideImage(bytes, box, caps({ protocol: "iterm", tmux: { clientTermName: "xterm" } as unknown as Capabilities["tmux"] }));
    expect(blocks).toMatchObject({ protocol: "blocks" });
    expect(blocks.text).toContain("▀");
  });
});

describe("ImageOverlay", () => {
  const image = (over: Partial<SideImage> = {}): SideImage => ({ protocol: "iterm", cols: 3, rows: 2, text: "", draw: "<IMG>", ...over });

  it("draws after a frame, at the requested cell, keeping the cursor; only when a frame was written", () => {
    const out: string[] = [];
    const overlay = new ImageOverlay((d) => out.push(d));
    overlay.request({ image: image(), row: 7, col: 101 });
    expect(overlay.beforeFrame()).toBe("");
    overlay.afterRender();
    expect(out).toEqual([`${ESC}7${ESC}[7;101H<IMG>${ESC}8`]);
    overlay.afterRender(); // no new frame: nothing to redraw
    expect(out).toHaveLength(1);
    overlay.beforeFrame(); // a frame went out and may have overwritten the image
    overlay.afterRender();
    expect(out).toHaveLength(2);
  });

  it("erases the image ahead of the first frame that no longer shows it", () => {
    const out: string[] = [];
    const overlay = new ImageOverlay((d) => out.push(d));
    overlay.request({ image: image(), row: 7, col: 101 });
    overlay.afterRender();
    overlay.request(undefined);
    expect(overlay.beforeFrame()).toBe(`${ESC}7${ESC}[0m${ESC}[7;101H   ${ESC}[8;101H   ${ESC}8`);
    overlay.afterRender();
    expect(out).toHaveLength(1); // nothing drawn again
    // Gone without a new frame: erased right away.
    overlay.request({ image: image(), row: 7, col: 101 });
    overlay.afterRender();
    overlay.request(undefined);
    overlay.afterRender();
    expect(out.at(-1)).toContain(`${ESC}[8;101H   `);
  });

  it("kitty: sends the data once, deletes its placement instead of overwriting cells, and resends after a reset", () => {
    const out: string[] = [];
    const overlay = new ImageOverlay((d) => out.push(d));
    const kitty = image({ protocol: "kitty", setup: "<DATA>", draw: "<PLACE>", clear: "<DELETE>" });
    overlay.request({ image: kitty, row: 7, col: 101 });
    overlay.afterRender();
    overlay.beforeFrame();
    overlay.afterRender();
    expect(out.join("").match(/<DATA>/g)).toHaveLength(1);
    expect(out.join("").match(/<PLACE>/g)).toHaveLength(2);
    overlay.request(undefined);
    expect(overlay.beforeFrame()).toBe("<DELETE>");
    overlay.reset(); // e.g. the full-screen preview deleted all images
    overlay.request({ image: kitty, row: 7, col: 101 });
    overlay.afterRender();
    expect(out.join("").match(/<DATA>/g)).toHaveLength(2);
  });

  it("kitty placeholders: the data goes out ahead of the frame that contains the placeholder text", () => {
    const overlay = new ImageOverlay(() => undefined);
    const placeholders = image({ protocol: "kitty", draw: undefined, text: "\u{10EEEE}", setup: "<DATA>", clear: "<DELETE>" });
    overlay.request({ image: placeholders, row: 7, col: 101 });
    expect(overlay.beforeFrame()).toBe("<DATA>");
    expect(overlay.beforeFrame()).toBe("");
    overlay.request(undefined);
    expect(overlay.beforeFrame()).toBe("<DELETE>");
  });

  it("the stdout proxy puts the overlay's output ahead of the frame and passes everything else through", () => {
    const term = new Terminal(160, 40);
    const overlay = new ImageOverlay(() => undefined);
    const proxy = overlayStdout(term as unknown as NodeJS.WriteStream, overlay);
    expect(proxy.columns).toBe(160);
    overlay.request({ image: image({ protocol: "kitty", draw: undefined, text: "x", setup: "<DATA>" }), row: 1, col: 1 });
    proxy.write("FRAME");
    expect(term.writes).toEqual(["<DATA>", "FRAME"]);
  });
});

describe("side panel in the app", () => {
  async function app(c2pa = false) {
    const dir = mkdtempSync(join(tmpdir(), "imgwand-side-"));
    const path = join(dir, "photo.jpg");
    writeFileSync(path, c2pa ? await signC2pa(await fullJpeg(), "image/jpeg", { signer: testSigner(), digitalSourceType: "digitalCapture" }) : await fullJpeg());
    const term = new Terminal(160, 40);
    const keyboard = new Keyboard();
    const drawn: string[] = [];
    const overlay = new ImageOverlay((d) => drawn.push(d));
    const deps: AppDeps = {
      listDir,
      openDocument: (p) => ImageDocument.open(p),
      imageInfo: async () => ({ format: "jpeg", width: 320, height: 200, displayWidth: 320, displayHeight: 200 }),
      renderInline: async () => ({ protocol: "iterm", cols: 30, rows: 10, text: "", draw: "<IMG>" }),
      writeFile: writeFileAtomic,
      sign: async (b) => b,
      loadSigner: async () => undefined,
      fullscreen: async () => undefined,
      overlay,
    };
    const instance = inkRender(<App startDir={dir} startFile={path} capabilities={caps({ protocol: "iterm" })} config={{}} version="0" deps={deps} />, {
      stdout: overlayStdout(term as unknown as NodeJS.WriteStream, overlay),
      stdin: keyboard as unknown as NodeJS.ReadStream,
      onRender: () => overlay.afterRender(),
      interactive: true, // as the app does (CI=true would otherwise make Ink non-interactive)
      patchConsole: false,
      exitOnCtrlC: false,
    });
    unmounts.push(() => instance.unmount());
    const all = () => term.writes.join("");
    const waitFor = async (test: () => boolean, what: string) => {
      for (let i = 0; i < 200 && !test(); i++) await new Promise((r) => setTimeout(r, 20));
      if (!test()) throw new Error(`timed out waiting for ${what}`);
    };
    const press = async (key: string) => {
      keyboard.write(key);
      await new Promise((r) => setTimeout(r, 60));
    };
    return { drawn, all, waitFor, press };
  }

  it("draws the iTerm2 image over the cells the panel reserves, and erases it when the panel goes away", async () => {
    const t = await app();
    await t.waitFor(() => t.drawn.length > 0, "the image");
    // Header (5 rows) + the frame's title row: the panel's content starts on row 7. Main area 100 columns
    // (160 - 56 - ... see layout): the panel's content starts 3 cells right of it, centered in its 52 cells.
    const at = /\x1b7\x1b\[(\d+);(\d+)H<IMG>\x1b8/.exec(t.drawn.at(-1)!)!;
    expect(Number(at[1])).toBe(7);
    const sideWidth = Math.min(56, Math.floor(160 * 0.36));
    expect(Number(at[2])).toBe(160 - sideWidth + 3 + Math.floor((sideWidth - 4 - 30) / 2));
    // Moving the cursor writes a frame: the image is drawn again over it.
    const before = t.drawn.length;
    await t.press("j");
    await t.waitFor(() => t.drawn.length > before, "a redraw");
    // The help screen has no side panel: the image is erased ahead of that frame and not drawn again.
    const drawsBeforeHelp = t.drawn.length;
    await t.press("?");
    await t.waitFor(() => /Content Credentials/.test(strip(t.all())), "help");
    expect(t.all()).toContain(`\x1b[${at[1]};${at[2]}H${" ".repeat(30)}`);
    expect(t.drawn.length).toBe(drawsBeforeHelp);
  });
});

it("Text placeholder lines survive Ink's layout (kitty in tmux)", () => {
  const { lastFrame, unmount } = render(<Text>{"\x1b[38;2;29;44;60m\u{10EEEE}̅̅\u{10EEEE}\x1b[39m"}</Text>);
  expect(lastFrame()).toContain("\u{10EEEE}");
  unmount();
});

it("C2PA states have one color each: Invalid red, Well-formed white, Valid yellow, Trusted green (UI and CLI)", async () => {
  const { c2paStateColor, THEME } = await import("../../src/tui/components.js");
  expect(["Invalid", "Well-formed", "Valid", "Trusted"].map(c2paStateColor)).toEqual([THEME.bad, "white", THEME.marked, THEME.ok]);
  const { c2paStateStyle } = await import("../../src/commands/c2pa.js");
  const { createStyle } = await import("../../src/style.js");
  const style = createStyle(true);
  expect(c2paStateStyle("Invalid", style)("x")).toBe(style.red("x"));
  expect(c2paStateStyle("Well-formed", style)("x")).toBe("x");
  expect(c2paStateStyle("Valid", style)("x")).toBe(style.yellow("x"));
  expect(c2paStateStyle("Trusted", style)("x")).toBe(style.green("x"));
});
