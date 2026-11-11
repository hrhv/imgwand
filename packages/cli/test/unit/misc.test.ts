import { describe, expect, it } from "vitest";
import { configPath, expandHome, loadConfig } from "../../src/config.js";
import { colorEnabled, createStyle, sanitize, truncate } from "../../src/style.js";
import { buildRows, parseCommand, rowIds, scrollWindow } from "../../src/tui/model.js";
import { graphicsCycle } from "../../src/tui/fullscreen.js";
import type { MetadataField } from "@hrhv/imgwand";

describe("style", () => {
  it("sanitizes untrusted text: no escape sequences or control characters reach the terminal", () => {
    const evil = "Canon\x1b]52;c;ZXZpbA==\x07\x1b[2J\x1bPq#0;2;0;0;0\x1b\\\x9b31m\r\x00ok\nnext\x1b_Ga=d\x1b\\";
    expect(sanitize(evil)).toBe("Canonok↵ next");
    expect(sanitize("tab\tstays")).toBe("tab stays");
    expect(sanitize("\x9d8;;https://evil\x9cclick\x9d8;;\x9c")).toBe("click");
    expect(sanitize("a\x1bcb")).toBe("ab");
    expect(sanitize("x\x1b(By\x1b7z")).toBe("xyz");
    expect(sanitize("unterminated \x1b]0;title")).toBe("unterminated ");
    expect(sanitize("ünïcödé ✓ 日本")).toBe("ünïcödé ✓ 日本");
  });

  it("styles only when enabled", () => {
    expect(createStyle(true).red("x")).toBe("\x1b[31mx\x1b[39m");
    expect(createStyle(false).red("x")).toBe("x");
    const s = createStyle(true);
    for (const fn of [s.bold, s.dim, s.green, s.yellow, s.cyan, s.magenta]) expect(fn("a")).toMatch(/^\x1b\[\d+ma\x1b\[\d+m$/);
  });

  it("decides on color from NO_COLOR, FORCE_COLOR and the TTY", () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" }, false)).toBe(false);
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false);
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(truncate("abc", 0)).toBe("");
  });
});

describe("config", () => {
  const env = { HOME: "/home/u" };
  it("finds the config file", () => {
    expect(configPath(env)).toBe("/home/u/.config/imgwand/config.json");
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/imgwand/config.json");
    expect(expandHome("~/k.pem", env)).toBe("/home/u/k.pem");
    expect(expandHome("/abs", env)).toBe("/abs");
  });

  it("parses and validates it", () => {
    const read = (text: string) => () => text;
    expect(loadConfig(env, () => {
      throw new Error("ENOENT");
    })).toEqual({});
    expect(loadConfig(env, read('{"graphics":"sixel","backup":true,"trustAnchors":"~/a.pem","signer":{"cert":"~/c.pem","key":"/k.pem","alg":"ps256","tsa":"http://t"}}'))).toEqual({
      graphics: "sixel",
      backup: true,
      trustAnchors: "/home/u/a.pem",
      signer: { cert: "/home/u/c.pem", key: "/k.pem", alg: "ps256", tsa: "http://t" },
    });
    expect(loadConfig(env, read('{"signer":{"cert":"c","key":"k"}}')).signer?.alg).toBe("es256");
    expect(() => loadConfig(env, read("{nope"))).toThrow(/not valid JSON/);
    expect(() => loadConfig(env, read("[1]"))).not.toThrow();
    expect(() => loadConfig(env, read("3"))).toThrow(/JSON object/);
    expect(() => loadConfig(env, read('{"signer":{"cert":"c"}}'))).toThrow(/needs "cert" and "key"/);
    expect(() => loadConfig(env, read('{"signer":{"cert":"c","key":"k","alg":"md5"}}'))).toThrow(/signer.alg/);
  });
});

const field = (id: string, group: MetadataField["group"], extra: Partial<MetadataField> = {}): MetadataField => ({
  id, group, section: "S", name: id.split(":").pop()!, value: `${id}-value`, removal: "field", writable: true, sensitive: false, blockIds: [1], ...extra,
});

describe("TUI model", () => {
  const fields = [field("exif:IFD0:Make", "exif"), field("exif:GPS:GPSLatitude", "gps"), field("c2pa:ManifestStore", "c2pa"), field("exif:IFD0:Model", "exif")];

  it("groups rows in display order and filters them", () => {
    const rows = buildRows(fields);
    expect(rows.map((r) => (r.type === "group" ? `[${r.group}:${r.count}]` : r.field.id))).toEqual(["[c2pa:1]", "c2pa:ManifestStore", "[exif:2]", "exif:IFD0:Make", "exif:IFD0:Model", "[gps:1]", "exif:GPS:GPSLatitude"]);
    expect(buildRows(fields, "model").map((r) => (r.type === "group" ? r.group : r.field.id))).toEqual(["exif", "exif:IFD0:Model"]);
    expect(buildRows(fields, "MAKE-value")).toHaveLength(2);
    expect(buildRows([], "")).toEqual([]);
  });

  it("maps a row to field ids (a group row stands for its fields)", () => {
    const rows = buildRows(fields);
    expect(rowIds(rows, 2)).toEqual(["exif:IFD0:Make", "exif:IFD0:Model"]);
    expect(rowIds(rows, 3)).toEqual(["exif:IFD0:Make"]);
    expect(rowIds(rows, 99)).toEqual([]);
  });

  it("keeps the cursor visible while scrolling", () => {
    expect(scrollWindow(5, 0, 3, 10)).toEqual({ cursor: 5, offset: 3 });
    expect(scrollWindow(1, 3, 3, 10)).toEqual({ cursor: 1, offset: 1 });
    expect(scrollWindow(-4, 0, 3, 10)).toEqual({ cursor: 0, offset: 0 });
    expect(scrollWindow(40, 0, 3, 10)).toEqual({ cursor: 9, offset: 7 });
    expect(scrollWindow(0, 5, 3, 0)).toEqual({ cursor: 0, offset: 0 });
  });

  it("parses command lines with quotes", () => {
    expect(parseCommand(":rm gps xmp:dc:creator")).toEqual({ name: "rm", args: ["gps", "xmp:dc:creator"] });
    expect(parseCommand(`set xmp:dc:title="Two words" 'x y'`)).toEqual({ name: "set", args: ["xmp:dc:title=Two words", "x y"] });
    expect(parseCommand("   ")).toEqual({ name: "", args: [] });
    expect(parseCommand("WQ")).toEqual({ name: "wq", args: [] });
  });

  it("cycles graphics from the detected protocol to the text fallbacks", () => {
    expect(graphicsCycle("kitty")).toEqual(["kitty", "blocks", "ascii"]);
    expect(graphicsCycle("blocks")).toEqual(["blocks", "ascii"]);
    expect(graphicsCycle("none")).toEqual(["blocks", "ascii"]);
  });
});

describe("duplicate names", () => {
  it("adds -copy-imgwand before the extension, numbering when taken, and validates edits", async () => {
    const { duplicateName, invalidFileName } = await import("../../src/tui/model.js");
    expect(duplicateName("photo.jpg", new Set())).toBe("photo-copy-imgwand.jpg");
    expect(duplicateName("archive.tar.png", new Set())).toBe("archive.tar-copy-imgwand.png");
    expect(duplicateName("noext", new Set())).toBe("noext-copy-imgwand");
    expect(duplicateName(".hidden.jpg", new Set())).toBe(".hidden-copy-imgwand.jpg");
    expect(duplicateName("p.jpg", new Set(["p-copy-imgwand.jpg", "p-copy-imgwand-2.jpg"]))).toBe("p-copy-imgwand-3.jpg");
    expect(invalidFileName("ok.jpg")).toBeUndefined();
    expect(invalidFileName(" ")).toMatch(/Enter a file name/);
    expect(invalidFileName("..")).toMatch(/Not a file name/);
    expect(invalidFileName("a/b.jpg")).toMatch(/same folder/);
  });
});
