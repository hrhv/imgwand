import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, useWindowSize, type Key } from "ink";
import { constants as fsConstants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  DIGITAL_SOURCE_TYPES,
  c2paVerdict,
  formatBytes,
  type C2paSigner,
  type C2paSignOptions,
  type EditOutcome,
  type ImageDocument,
  type ImageInfo,
  type MetadataField,
  type WriteOptions,
  type WriteResult,
} from "@hrhv/imgwand";
import { c2paLadder } from "../commands/c2pa.js";
import type { Config } from "../config.js";
import { sanitize, truncate } from "../style.js";
import type { Capabilities } from "../terminal/capabilities.js";
import { Crumbs, Dialog, FlashLine, Frame, Header, InputLine, THEME, c2paStateColor, type ContextRow, type DialogChoice, type FlashLevel } from "./components.js";
import type { DirEntry, ListDir } from "./fs.js";
import { runFullscreenPreview, type FullscreenRequest } from "./fullscreen.js";
import type { ImageOverlay, SideImage } from "./overlay.js";
import { BROWSER, C2PA_VIEW, COMMANDS, INSPECTOR, NAVIGATION, PREVIEW, type Binding } from "./keys.js";
import { buildRows, duplicateName, invalidFileName, parseCommand, rowIds, scrollWindow, type Row } from "./model.js";

export interface AppDeps {
  readonly listDir: ListDir;
  readonly openDocument: (path: string) => Promise<ImageDocument>;
  readonly imageInfo: (bytes: Uint8Array) => Promise<ImageInfo | undefined>;
  /** The side panel's preview, in the best graphics protocol the terminal supports there. */
  readonly renderInline: (bytes: Uint8Array, box: { cols: number; rows: number }) => Promise<SideImage>;
  /** Draws pixel images over the frame (absent in tests and when the terminal has no pixel graphics). */
  readonly overlay?: Pick<ImageOverlay, "request" | "reset">;
  readonly writeFile: (path: string, bytes: Uint8Array, options: WriteOptions) => Promise<WriteResult>;
  readonly sign: (bytes: Uint8Array, mimeType: string, options: C2paSignOptions) => Promise<Uint8Array>;
  /** The configured signer, or undefined when none is configured. */
  readonly loadSigner: () => Promise<C2paSigner | undefined>;
  /** Overrides the full-screen preview (tests). */
  readonly fullscreen?: (request: FullscreenRequest) => Promise<void>;
}

export interface AppProps {
  readonly startDir: string;
  readonly startFile?: string;
  readonly capabilities: Capabilities;
  readonly config: Config;
  readonly version: string;
  readonly deps: AppDeps;
}

type Screen = "browser" | "inspector" | "c2pa" | "help";
type Mode = { kind: "normal" } | { kind: "filter" } | { kind: "command" } | { kind: "prompt"; label: string; hint?: string; submit: (value: string) => void | Promise<void> };
interface DialogState {
  title: string;
  lines: string[];
  /** For button dialogs, `run` gets the text field's value. */
  choices: (DialogChoice & { run: (value: string) => void | Promise<void> })[];
  /** Button dialog: index of the focused button (Enter presses it). Plain dialogs answer to the choice keys. */
  focus?: number;
  input?: { label: string; value: string };
  error?: string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function App({ startDir, startFile, capabilities, config, version, deps }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const size = useWindowSize();
  const width = Math.max(60, size.columns || 100);
  const height = Math.max(18, (size.rows || 30) - 1);

  const [screen, setScreen] = useState<Screen>(startFile ? "inspector" : "browser");
  const [returnTo, setReturnTo] = useState<Screen>("browser");
  const [dir, setDir] = useState(startDir);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [browser, setBrowser] = useState({ cursor: 0, offset: 0 });
  const [doc, setDoc] = useState<ImageDocument>();
  const [info, setInfo] = useState<ImageInfo>();
  const [inline, setInline] = useState<SideImage | undefined>(undefined);
  const [table, setTable] = useState({ cursor: 0, offset: 0 });
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Record<string, string>>({});
  // Mode, input line and dialog are read by the key handler, which can run several times before React re-renders
  // (fast typing, pasted text): refs hold the current values, state only drives rendering.
  const [mode, setModeState] = useState<Mode>({ kind: "normal" });
  const [input, setInputState] = useState("");
  const [dialog, setDialogState] = useState<DialogState>();
  const modeRef = useRef<Mode>({ kind: "normal" });
  const inputRef = useRef("");
  const dialogRef = useRef<DialogState>(undefined);
  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);
  const setInput = useCallback((v: string) => {
    inputRef.current = v;
    setInputState(v);
  }, []);
  const setDialog = useCallback((d: DialogState | undefined) => {
    dialogRef.current = d;
    setDialogState(d);
  }, []);
  const [flashMessage, setFlashState] = useState<{ text: string; level: FlashLevel }>();
  const [busy, setBusy] = useState<string>();
  const [spin, setSpin] = useState(0);
  const [c2paScroll, setC2paScroll] = useState(0);
  const [unsavedSignature, setUnsavedSignature] = useState(false);
  const [, forceRender] = useState(0);
  const flashTimer = useRef<NodeJS.Timeout>(undefined);

  const flash = useCallback((text: string, level: FlashLevel = "info") => {
    // Flash messages often quote field names and values from the file: never let escapes through.
    setFlashState({ text: sanitize(text), level });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashState(undefined), level === "error" ? 8000 : 4000);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 90);
    return () => clearInterval(t);
  }, [busy]);

  const task = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      try {
        await fn();
      } catch (error) {
        flash(sanitize((error as Error).message), "error");
      } finally {
        setBusy(undefined);
      }
    },
    [flash],
  );

  // --- layout -------------------------------------------------------------------------------------------------
  // Help replaces the header (it lists every key anyway), which lets it fit a 24-row terminal.
  const headerHeight = screen === "help" ? 0 : 5;
  const mainHeight = Math.max(6, height - headerHeight - 2);
  const sidePanel = screen === "inspector" && width >= 120;
  const sideWidth = sidePanel ? Math.min(56, Math.floor(width * 0.36)) : 0;
  const mainWidth = width - sideWidth;
  const bodyRows = Math.max(1, mainHeight - 3); // frame title + bottom border + column header

  // --- browser ------------------------------------------------------------------------------------------------
  const loadDir = useCallback(
    (path: string, hidden = showHidden, select?: string) =>
      task("Reading directory", async () => {
        const list = await deps.listDir(path, hidden);
        const parent = resolve(path, "..");
        const all: DirEntry[] = parent !== path ? [{ name: "..", path: parent, kind: "parent", size: 0 }, ...list] : list;
        setEntries(all);
        setDir(path);
        // Land on `select` (e.g. a file just created), scrolled into view.
        const cursor = Math.max(0, select === undefined ? 0 : all.findIndex((e) => e.name === select));
        setBrowser({ cursor, offset: Math.max(0, cursor - bodyRows + 1) });
      }),
    [deps, showHidden, task, bodyRows],
  );

  /** d in the browser: copy an image next to itself, under a name the user confirms (or edits). */
  const duplicate = useCallback(
    (entry: DirEntry) => {
      const suggested = duplicateName(entry.name, new Set(entries.map((e) => e.name)));
      setDialog({
        title: `Duplicate ${entry.name}`,
        lines: [`A byte-for-byte copy in ${dir}`, ""],
        input: { label: "Name", value: suggested },
        focus: 0,
        choices: [
          {
            key: "ok",
            label: "OK",
            run: async (name) => {
              const problem = invalidFileName(name);
              const current = dialogRef.current;
              if (problem) return current && setDialog({ ...current, error: problem });
              try {
                // COPYFILE_EXCL: never overwrite an existing file.
                await copyFile(entry.path, join(dir, name), fsConstants.COPYFILE_EXCL);
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                const message = code === "EEXIST" ? `${name} already exists` : `Could not copy: ${code ?? (error as Error).message}`;
                return dialogRef.current && setDialog({ ...dialogRef.current, error: message });
              }
              setDialog(undefined);
              setFilters((f) => ({ ...f, browser: "" }));
              await loadDir(dir, showHidden, name);
              flash(`Duplicated ${entry.name} as ${name}`, "ok");
            },
          },
          { key: "cancel", label: "Cancel", run: () => setDialog(undefined) },
        ],
      });
    },
    [dir, entries, flash, loadDir, setDialog, showHidden],
  );

  const visibleEntries = useMemo(() => {
    const q = (filters.browser ?? "").toLowerCase();
    return q ? entries.filter((e) => e.kind === "parent" || e.name.toLowerCase().includes(q)) : entries;
  }, [entries, filters.browser]);

  // --- inspector ----------------------------------------------------------------------------------------------
  const openFile = useCallback(
    (path: string) =>
      task(`Opening ${basename(path)}`, async () => {
        const d = await deps.openDocument(path);
        setDoc(d);
        setUnsavedSignature(false);
        setC2paScroll(0);
        setMarks(new Set());
        setTable({ cursor: 0, offset: 0 });
        setFilters((f) => ({ ...f, inspector: "" }));
        setInfo(await deps.imageInfo(d.bytes));
        setScreen("inspector");
      }),
    [deps, task],
  );

  useEffect(() => {
    if (startFile) void openFile(startFile);
    void loadDir(startDir);
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!doc || !sidePanel) return;
    let cancelled = false;
    deps
      .renderInline(doc.bytes, { cols: sideWidth - 4, rows: Math.max(4, Math.floor(mainHeight * 0.55)) })
      .then((image) => !cancelled && setInline(image))
      .catch(() => !cancelled && setInline(undefined));
    return () => {
      cancelled = true;
    };
  }, [doc, doc?.bytes, sidePanel, sideWidth, mainHeight, deps]);

  const rows: Row[] = useMemo(() => buildRows(doc?.fields ?? [], filters.inspector), [doc, doc?.fields, filters.inspector]);
  const pendingRemovals = doc?.pendingRemovals ?? new Set<string>();
  const pendingSets = doc?.pendingSets ?? new Map<string, string>();
  const currentRow = rows[table.cursor];
  const currentField = currentRow?.type === "field" ? currentRow.field : undefined;

  /** Stages a value and validates it immediately; an invalid value is rolled back rather than left staged. */
  const stageValue = useCallback(
    (id: string, value: string, message: string) => {
      if (!doc) return;
      doc.stageSet(id, value);
      try {
        doc.preview();
        flash(message, "ok");
      } catch (error) {
        doc.undo();
        flash((error as Error).message, "error");
      }
      forceRender((n) => n + 1);
    },
    [doc, flash],
  );

  const stage = useCallback(
    (fn: () => string | void) => {
      if (!doc) return;
      try {
        const message = fn();
        if (message) flash(message, "ok");
      } catch (error) {
        flash(sanitize((error as Error).message), "error");
      }
      forceRender((n) => n + 1);
    },
    [doc, flash],
  );

  const stageRemoval = useCallback(
    (selectors: string[], label?: string) =>
      stage(() => {
        const ids = doc!.stageRemove(selectors);
        setMarks(new Set());
        return ids.size === 0 ? `Nothing matched ${selectors.join(" ")}` : `Staged ${ids.size} field${ids.size === 1 ? "" : "s"} for removal${label ? ` (${label})` : ""}. Press w to write.`;
      }),
    [doc, stage],
  );

  // --- writing ------------------------------------------------------------------------------------------------
  const write = useCallback(
    async (outcome: EditOutcome, backup: boolean, then?: () => void) => {
      if (!doc?.path) return;
      await task("Writing", async () => {
        // Apply staged edits in memory, then always write the document's bytes: they may also hold a new
        // signature even when the staged edits turn out to change nothing.
        if (doc.dirty) await doc.apply();
        const result: WriteResult = await deps.writeFile(doc.path!, doc.bytes, { backup });
        setUnsavedSignature(false);
        setInfo(await deps.imageInfo(doc.bytes));
        setTable((t) => ({ ...t, cursor: Math.min(t.cursor, Math.max(0, buildRows(doc.fields).length - 1)) }));
        flash(`Wrote ${basename(doc.path!)}${outcome.removed.length ? `: removed ${outcome.removed.length} field${outcome.removed.length === 1 ? "" : "s"}` : ""}${result?.backupPath ? ` (backup: ${basename(result.backupPath)})` : ""}`, "ok");
        then?.();
      });
    },
    [deps, doc, flash, task],
  );

  const confirmWrite = useCallback(
    (then?: () => void) => {
      if (!doc || (!doc.dirty && !unsavedSignature)) {
        if (then) return then();
        flash(doc ? "Nothing to write" : "Open an image first", "info");
        return;
      }
      let outcome: EditOutcome;
      try {
        outcome = doc.preview();
      } catch (error) {
        flash(sanitize((error as Error).message), "error");
        return;
      }
      const lines = [`File: ${sanitize(doc.path ?? "")}`];
      if (unsavedSignature) lines.push("New C2PA signature (signed in memory)");
      if (outcome.removed.length) lines.push(`Remove ${outcome.removed.length} field${outcome.removed.length === 1 ? "" : "s"}: ${truncate(outcome.removed.map((f) => f.name).join(", "), 70)}`);
      if (outcome.updated.length) lines.push(`Set ${outcome.updated.length}: ${truncate(outcome.updated.join(", "), 70)}`);
      lines.push(`Size: ${formatBytes(doc.bytes.length)} → ${formatBytes(outcome.bytes.length)} (picture data untouched)`);
      for (const w of outcome.warnings) lines.push(`! ${w}`);
      const backup = config.backup ?? false;
      const choices: DialogState["choices"] = [];
      if (outcome.c2paInvalidated) {
        choices.push({
          key: "r",
          label: "write, removing C2PA too",
          run: () => {
            doc.stageRemove(["c2pa"]);
            void write(doc.preview(), backup, then);
          },
        });
        choices.push({ key: "k", label: "write, keep invalid C2PA", run: () => void write(outcome, backup, then) });
      } else {
        choices.push({ key: "y", label: "write", run: () => void write(outcome, backup, then) });
        choices.push({ key: "b", label: "write + backup", run: () => void write(outcome, true, then) });
      }
      choices.push({ key: "n", label: "cancel", run: () => undefined });
      setDialog({ title: `Write changes to ${sanitize(basename(doc.path ?? "image"))}?`, lines, choices });
    },
    [config.backup, doc, flash, unsavedSignature, write],
  );

  const quit = useCallback(() => {
    if (doc && (doc.dirty || unsavedSignature)) {
      setDialog({
        title: "Unsaved changes",
        lines: ["You have staged changes that are not written yet."],
        choices: [
          { key: "w", label: "write and quit", run: () => confirmWrite(() => exit()) },
          { key: "d", label: "discard and quit", run: () => exit() },
          { key: "n", label: "cancel", run: () => undefined },
        ],
      });
      return;
    }
    exit();
  }, [confirmWrite, doc, exit, unsavedSignature]);

  const leaveInspector = useCallback(() => {
    const go = () => {
      setDoc(undefined);
      setScreen("browser");
    };
    if (doc && (doc.dirty || unsavedSignature)) {
      setDialog({
        title: "Unsaved changes",
        lines: ["Leave this image and discard staged changes?"],
        choices: [
          { key: "w", label: "write first", run: () => confirmWrite(go) },
          { key: "d", label: "discard", run: go },
          { key: "n", label: "stay", run: () => undefined },
        ],
      });
    } else go();
  }, [confirmWrite, doc, unsavedSignature]);

  // --- preview / C2PA -----------------------------------------------------------------------------------------
  const preview = useCallback(
    async (bytes: Uint8Array, title: string) => {
      const request: FullscreenRequest = { bytes, title, capabilities };
      // The full-screen preview clears the screen (and kitty's images): the side image must be redrawn afterwards.
      deps.overlay?.reset();
      try {
        if (deps.fullscreen) await deps.fullscreen(request);
        else await suspendTerminal(() => runFullscreenPreview({ stdout: stdout as NodeJS.WriteStream }, request));
      } catch (error) {
        flash(`Preview failed: ${sanitize((error as Error).message)}`, "error");
      } finally {
        deps.overlay?.reset();
      }
    },
    [capabilities, deps, flash, stdout, suspendTerminal],
  );

  const sign = useCallback(
    (redact?: string) => {
      if (!doc) return;
      if (doc.dirty) {
        flash("Write or discard the staged edits before signing (any later edit would invalidate the signature)", "warn");
        return;
      }
      void task(redact ? "Redacting" : "Signing", async () => {
        const signer = await deps.loadSigner();
        if (!signer) {
          flash("No signer configured: add a signer to the config file or set IMGWAND_C2PA_CERT and IMGWAND_C2PA_KEY", "error");
          return;
        }
        const run = async (sourceType?: string) => {
          await task(redact ? "Redacting" : "Signing", async () => {
            const signed = await deps.sign(doc.bytes, doc.report.mimeType, {
              signer,
              title: basename(doc.path ?? "image"),
              digitalSourceType: sourceType as C2paSignOptions["digitalSourceType"],
              redact: redact ? [redact] : undefined,
            });
            await doc.replaceBytes(signed);
            setUnsavedSignature(true);
            setC2paScroll(0);
            flash(`${redact ? `Redacted ${redact} and re-signed` : "Signed"} in memory. Press w to write.`, "ok");
          });
        };
        if (doc.report.c2pa || redact) await run();
        else {
          setInput("digitalCapture");
          setMode({
            kind: "prompt",
            label: "Digital source type: ",
            hint: `how the content was made (${DIGITAL_SOURCE_TYPES.slice(0, 4).join(", ")}, …)`,
            submit: async (value) => {
              if (!(DIGITAL_SOURCE_TYPES as readonly string[]).includes(value)) {
                flash(`Unknown source type. Use one of: ${DIGITAL_SOURCE_TYPES.join(", ")}`, "error");
                return;
              }
              await run(value);
            },
          });
        }
      });
    },
    [deps, doc, flash, task],
  );

  // --- commands -----------------------------------------------------------------------------------------------
  const runCommand = useCallback(
    (line: string) => {
      const { name, args } = parseCommand(line);
      switch (name) {
        case "":
          return;
        case "q":
        case "quit":
          return quit();
        case "q!":
          return exit();
        case "w":
        case "write":
          return confirmWrite();
        case "wq":
        case "x":
          return confirmWrite(() => exit());
        case "rm":
        case "remove":
        case "strip":
        case "del":
          if (!doc) return flash("Open an image first", "warn");
          if (args.length === 0) return flash("Usage: :rm <selector…>  e.g. :rm gps xmp:dc:creator", "warn");
          return stageRemoval(args);
        case "privacy":
          return doc ? stageRemoval(["privacy"], "privacy") : flash("Open an image first", "warn");
        case "strip-all":
          return doc ? stageRemoval(["all", "!icc", "!exif:IFD0:Orientation"], "all except ICC profile and orientation") : flash("Open an image first", "warn");
        case "set": {
          if (!doc) return flash("Open an image first", "warn");
          // The value is taken verbatim (quotes and spacing are part of it), not word-split.
          const raw = line.trim().replace(/^:?set\s+/i, "");
          const eq = raw.indexOf("=");
          if (eq <= 0) return flash("Usage: :set <field>=<value>", "warn");
          const id = raw.slice(0, eq).trim();
          return stageValue(id, raw.slice(eq + 1), `Staged ${id}. Press w to write.`);
        }
        case "undo":
        case "u":
          return stage(() => (doc!.undo() ? "Undone" : "Nothing to undo"));
        case "reset":
          return stage(() => {
            doc!.discard();
            return "Dropped all staged edits";
          });
        case "open":
        case "o": {
          const target = resolve(dir, args.join(" ") || ".");
          const go = () =>
            void deps
              .listDir(target, showHidden)
              .then(() => {
                setDoc(undefined);
                setScreen("browser");
                void loadDir(target);
              })
              .catch(() => void openFile(target));
          if (doc && (doc.dirty || unsavedSignature)) {
            return setDialog({
              title: "Unsaved changes",
              lines: [`Open ${sanitize(basename(target))} and discard the staged changes?`],
              choices: [
                { key: "w", label: "write first", run: () => confirmWrite(go) },
                { key: "d", label: "discard", run: go },
                { key: "n", label: "cancel", run: () => undefined },
              ],
            });
          }
          return go();
        }
        case "c2pa":
          return doc ? setScreen("c2pa") : flash("Open an image first", "warn");
        case "preview":
        case "p":
          return doc ? void preview(doc.bytes, basename(doc.path ?? "image")) : flash("Open an image first", "warn");
        case "help":
        case "h":
          setReturnTo(screen === "help" ? returnTo : screen);
          return setScreen("help");
        default:
          return flash(`Unknown command :${name} (press ? for help)`, "error");
      }
    },
    [confirmWrite, deps, dir, doc, exit, flash, loadDir, openFile, preview, quit, returnTo, screen, showHidden, stage, stageRemoval, stageValue, unsavedSignature],
  );

  // --- keyboard -----------------------------------------------------------------------------------------------
  const moveIn = (setter: typeof setTable, total: number, key: Key, input: string, page: number) => {
    setter((s) => {
      let c = s.cursor;
      if (key.downArrow || input === "j") c++;
      else if (key.upArrow || input === "k") c--;
      else if (input === "g" || key.home) c = 0;
      else if (input === "G" || key.end) c = total - 1;
      else if (key.pageDown || (key.ctrl && input === "d")) c += page;
      else if (key.pageUp || (key.ctrl && input === "u")) c -= page;
      else return s;
      return scrollWindow(c, s.offset, page, total);
    });
  };
  const isMove = (key: Key, input: string) =>
    key.downArrow || key.upArrow || key.pageDown || key.pageUp || key.home || key.end || ["j", "k", "g", "G"].includes(input) || (key.ctrl && (input === "d" || input === "u"));

  const handleInput = (value: string, key: Key): void => {
    // Ctrl+C always quits, even mid-task or with a dialog open (the app opts out of Ink's own handler).
    if (key.ctrl && value === "c") return exit();
    // Pasted text (or keys typed faster than they are read) arrives as one chunk: handle it one character at a
    // time, newlines as Enter, so it behaves exactly like typing in every mode.
    if ([...value].length > 1 && !key.ctrl && !key.meta && !value.includes("\x1b")) {
      const none = Object.fromEntries(Object.keys(key).map((k) => [k, false])) as unknown as Key;
      for (const ch of value) {
        if (ch === "\r" || ch === "\n") handleInput("", { ...none, return: true });
        else handleInput(ch, none);
      }
      return;
    }
    // Overlays next.
    const dialog = dialogRef.current;
    const mode = modeRef.current;
    const input = inputRef.current;
    if (dialog && dialog.focus !== undefined) {
      // Button dialog: Enter presses the focused button; typing edits the text field.
      const count = dialog.choices.length;
      if (key.escape) return setDialog(undefined);
      if (key.return) return void dialog.choices[dialog.focus]?.run(dialog.input?.value ?? "");
      if (key.tab || key.leftArrow || key.rightArrow) {
        const step = key.leftArrow || (key.tab && key.shift) ? count - 1 : 1;
        return setDialog({ ...dialog, focus: (dialog.focus + step) % count });
      }
      if (!dialog.input) return;
      if (key.backspace || key.delete) return setDialog({ ...dialog, error: undefined, input: { ...dialog.input, value: [...dialog.input.value].slice(0, -1).join("") } });
      if (value && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) return setDialog({ ...dialog, error: undefined, input: { ...dialog.input, value: dialog.input.value + value } });
      return;
    }
    if (dialog) {
      const choice = dialog.choices.find((c) => c.key === value) ?? (key.escape ? dialog.choices.find((c) => c.key === "n") : undefined);
      if (choice) {
        setDialog(undefined);
        void choice.run("");
      }
      return;
    }
    if (mode.kind !== "normal") {
      if (key.escape) {
        if (mode.kind === "filter") setFilters((f) => ({ ...f, [screen]: "" }));
        setMode({ kind: "normal" });
        setInput("");
        return;
      }
      if (key.return) {
        const text = input;
        setMode({ kind: "normal" });
        setInput("");
        if (mode.kind === "command") runCommand(text);
        else if (mode.kind === "prompt") void mode.submit(text);
        return;
      }
      const next = key.backspace || key.delete ? input.slice(0, -1) : key.ctrl || key.meta || key.tab ? input : input + value;
      setInput(next);
      if (mode.kind === "filter") {
        setFilters((f) => ({ ...f, [screen]: next }));
        setTable({ cursor: 0, offset: 0 });
        setBrowser({ cursor: 0, offset: 0 });
      }
      return;
    }
    if (busy) return;

    // Global keys.
    if (value === ":") return void (setMode({ kind: "command" }), setInput(""));
    if (value === "/" && screen !== "help") return void (setMode({ kind: "filter" }), setInput(filters[screen] ?? ""));
    if (value === "?") {
      if (screen === "help") return setScreen(returnTo);
      setReturnTo(screen);
      return setScreen("help");
    }
    switch (screen) {
      case "help":
        if (key.escape || value === "q") setScreen(returnTo);
        return;
      case "browser": {
        if (isMove(key, value)) return moveIn(setBrowser, visibleEntries.length, key, value, bodyRows);
        const entry = visibleEntries[browser.cursor];
        if (key.return || key.rightArrow || value === "l") {
          if (!entry) return;
          if (entry.kind === "image") return void openFile(entry.path);
          return void loadDir(entry.path);
        }
        if (key.backspace || key.delete || key.leftArrow || value === "h") return void loadDir(resolve(dir, ".."));
        if (value === "p" && entry?.kind === "image") {
          return void task("Rendering", async () => {
            const d = await deps.openDocument(entry.path);
            await preview(d.bytes, entry.name);
          });
        }
        if (value === ".") {
          setShowHidden(!showHidden);
          return void loadDir(dir, !showHidden);
        }
        if (value === "r") return void loadDir(dir);
        if (value === "d") {
          if (entry?.kind !== "image") return flash("Select an image to duplicate", "warn");
          return duplicate(entry);
        }
        if (key.escape) return setFilters((f) => ({ ...f, browser: "" }));
        if (value === "q") return quit();
        return;
      }
      case "inspector": {
        if (!doc) return;
        if (isMove(key, value)) return moveIn(setTable, rows.length, key, value, bodyRows);
        if (value === " ") {
          const ids = rowIds(rows, table.cursor).filter((id) => doc.fields.find((f) => f.id === id)?.removal !== "none");
          setMarks((m) => {
            const next = new Set(m);
            const allMarked = ids.every((id) => next.has(id));
            for (const id of ids) allMarked ? next.delete(id) : next.add(id);
            return next;
          });
          return moveIn(setTable, rows.length, { downArrow: true } as Key, "", bodyRows);
        }
        if (value === "a") {
          const group = currentRow?.type === "group" ? currentRow.group : currentField?.group;
          if (!group) return;
          return setMarks((m) => new Set([...m, ...doc.fields.filter((f) => f.group === group && f.removal !== "none").map((f) => f.id)]));
        }
        if (value === "d" || key.delete) {
          const ids = marks.size > 0 ? [...marks] : rowIds(rows, table.cursor);
          if (ids.length === 0) return;
          return stageRemoval(ids);
        }
        if (value === "x") {
          const ids = marks.size > 0 ? [...marks] : rowIds(rows, table.cursor);
          return stage(() => {
            doc.unstageRemove(ids);
            setMarks(new Set());
            return "Restored";
          });
        }
        if (value === "P") return stageRemoval(["privacy"], "privacy");
        if (value === "D") {
          return setDialog({
            title: "Strip metadata",
            lines: ["Stage removal of all metadata?", "Keeping the ICC profile and Orientation keeps the picture looking the same."],
            choices: [
              { key: "k", label: "all but ICC + orientation", run: () => stageRemoval(["all", "!icc", "!exif:IFD0:Orientation"], "all except ICC profile and orientation") },
              { key: "a", label: "everything", run: () => stageRemoval(["all"], "everything") },
              { key: "n", label: "cancel", run: () => undefined },
            ],
          });
        }
        if (value === "e" && currentField) {
          if (!currentField.writable) return flash(`${currentField.name} is read-only${currentField.note ? `: ${currentField.note}` : ""}`, "warn");
          setInput(sanitize(pendingSets.get(currentField.id) ?? currentField.value));
          return setMode({
            kind: "prompt",
            label: `${sanitize(currentField.id)} = `,
            submit: (v) => stageValue(currentField.id, v, `Staged new value for ${currentField.name}. Press w to write.`),
          });
        }
        if (value === "n") {
          setInput("");
          return setMode({
            kind: "prompt",
            label: "New field (id=value): ",
            hint: "e.g. exif:IFD0:Artist=Jane  xmp:dc:title=Sunset  iptc:Keywords=a; b",
            submit: (line) => {
              const eq = line.indexOf("=");
              if (eq <= 0) return flash("Expected <field>=<value>", "warn");
              stageValue(line.slice(0, eq).trim(), line.slice(eq + 1), `Staged ${line.slice(0, eq).trim()}. Press w to write.`);
            },
          });
        }
        if (value === "u") return stage(() => (doc.undo() ? "Undone" : "Nothing to undo"));
        if (value === "w") return confirmWrite();
        if (value === "c") return setScreen("c2pa");
        if (value === "p") return void preview(doc.bytes, basename(doc.path ?? "image"));
        if (key.escape) {
          if (marks.size > 0) return setMarks(new Set());
          if (filters.inspector) return setFilters((f) => ({ ...f, inspector: "" }));
          return leaveInspector();
        }
        if (value === "q") return quit();
        return;
      }
      case "c2pa": {
        if (!doc) return;
        if (key.downArrow || value === "j") return setC2paScroll((s) => Math.min(s + 1, 500));
        if (key.upArrow || value === "k") return setC2paScroll((s) => Math.max(0, s - 1));
        if (value === "s") return sign();
        if (value === "r") {
          const labels = [...new Set(doc.report.c2pa?.manifests.flatMap((m) => m.assertions.map((a) => a.label)) ?? [])].filter((l) => !/^c2pa\.(actions|hash|thumbnail|ingredient)/.test(l));
          if (labels.length === 0) return flash("No redactable assertions", "warn");
          setInput(sanitize(labels[0]!));
          return setMode({ kind: "prompt", label: "Redact assertion: ", hint: sanitize(labels.join(", ")), submit: (v) => sign(v.trim()) });
        }
        if (value === "x") {
          setScreen("inspector");
          return stageRemoval(["c2pa"], "C2PA manifest store");
        }
        if (value === "w") return confirmWrite();
        if (key.escape || value === "q") return setScreen("inspector");
        return;
      }
    }
  };
  useInput(handleInput);

  // --- rendering ----------------------------------------------------------------------------------------------
  const bindings: readonly Binding[] = screen === "browser" ? [...BROWSER, ...NAVIGATION] : screen === "inspector" ? [...INSPECTOR, ...NAVIGATION] : screen === "c2pa" ? [...C2PA_VIEW, ...NAVIGATION] : NAVIGATION;
  const c2paState = doc?.report.c2pa ? c2paVerdict(doc.report.c2pa).label : undefined;
  const context: ContextRow[] =
    screen === "browser"
      ? [
          ["Dir", dir],
          ["Images", String(entries.filter((e) => e.kind === "image").length)],
          ["Graphics", `${capabilities.protocol}${capabilities.tmux ? " (tmux)" : ""}`],
          ["Terminal", capabilities.terminal],
          ["imgwand", version],
        ]
      : [
          ["File", doc?.path ? basename(doc.path) : "-"],
          ["Image", info ? `${doc?.report.format.toUpperCase()} ${info.displayWidth}×${info.displayHeight} ${formatBytes(doc?.bytes.length ?? 0)}` : (doc?.report.format.toUpperCase() ?? "-")],
          ["Fields", `${doc?.fields.length ?? 0}  staged: −${pendingRemovals.size} ~${pendingSets.size}`],
          c2paState
            ? ["C2PA", `${c2paState}${unsavedSignature ? " (unsaved)" : ""}`, c2paStateColor(c2paState)]
            : ["C2PA", doc?.fields.some((f) => f.group === "c2pa") ? "present" : "none"],
          ["Graphics", `${capabilities.protocol}${capabilities.tmux ? " (tmux)" : ""}`],
        ];

  let main: React.ReactNode;
  if (dialog) {
    main = (
      <Box height={mainHeight} width={width} justifyContent="center" alignItems="center">
        <Dialog title={dialog.title} lines={dialog.lines} choices={dialog.choices} width={width} input={dialog.input} focus={dialog.focus} error={dialog.error} />
      </Box>
    );
  } else if (screen === "help") {
    main = <HelpView width={width} height={mainHeight} />;
  } else if (screen === "browser") {
    main = <BrowserView entries={visibleEntries} cursor={browser.cursor} offset={browser.offset} dir={dir} width={width} height={mainHeight} rows={bodyRows} filter={filters.browser} />;
  } else if (screen === "c2pa") {
    main = <C2paView doc={doc} width={width} height={mainHeight} scroll={c2paScroll} />;
  } else {
    main = (
      <Box>
        <InspectorView
          rows={rows}
          cursor={table.cursor}
          offset={table.offset}
          marks={marks}
          pendingRemovals={pendingRemovals}
          pendingSets={pendingSets}
          title={doc?.path ? basename(doc.path) : "image"}
          width={mainWidth}
          height={mainHeight}
          bodyRows={bodyRows}
          filter={filters.inspector}
          total={doc?.fields.length ?? 0}
        />
        {sidePanel && <SidePanel width={sideWidth} height={mainHeight} preview={inline} info={info} doc={doc} field={currentField} />}
      </Box>
    );
  }

  const crumbs = screen === "browser" ? ["browser"] : screen === "help" ? ["help"] : screen === "c2pa" ? ["browser", basename(doc?.path ?? ""), "c2pa"] : ["browser", basename(doc?.path ?? "")];
  let bottom: React.ReactNode;
  if (mode.kind === "command") bottom = <InputLine prefix=":" value={input} hint="rm <sel> · set id=v · w · q · privacy · strip-all · undo · open <path>" />;
  else if (mode.kind === "filter") bottom = <InputLine prefix="/" value={input} />;
  else if (mode.kind === "prompt") bottom = <InputLine prefix={mode.label} value={input} hint={mode.hint} />;
  else if (busy) bottom = <Text color={THEME.accent}>{`${SPINNER[spin]} ${busy}…`}</Text>;
  else bottom = <FlashLine text={flashMessage?.text} level={flashMessage?.level} />;

  // Pixel images are drawn over the frame, at the cells the side panel reserves for them. Requested here, during
  // render, so the overlay always matches the frame Ink is about to write (never drawn over a dialog or another screen).
  const overlayVisible = screen === "inspector" && sidePanel && !dialog && inline !== undefined;
  deps.overlay?.request(
    overlayVisible && inline
      ? { image: inline, row: headerHeight + 2, col: mainWidth + 3 + Math.max(0, Math.floor((sideWidth - 4 - inline.cols) / 2)) }
      : undefined,
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      {headerHeight > 0 && <Header width={width} context={context} bindings={bindings} />}
      {main}
      <Crumbs crumbs={crumbs} right={screen === "inspector" && (pendingRemovals.size || pendingSets.size) ? `${pendingRemovals.size} to remove · ${pendingSets.size} to set · w to write` : undefined} />
      {bottom}
    </Box>
  );
}

// --- views -------------------------------------------------------------------------------------------------------

function BrowserView({ entries, cursor, offset, dir, width, height, rows, filter }: { entries: DirEntry[]; cursor: number; offset: number; dir: string; width: number; height: number; rows: number; filter?: string }) {
  const inner = width - 4;
  const sizeW = 10;
  const typeW = 6;
  const dateW = 17;
  const nameW = Math.max(10, inner - sizeW - typeW - dateW - 3);
  const fmtDate = (d?: Date) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "");
  const images = entries.filter((e) => e.kind === "image").length;
  return (
    <Frame title={`Images(${sanitize(dir)})`} subtitle={`[${images}]${filter ? ` </${filter}>` : ""}`} width={width} height={height}>
      <Text bold color={THEME.accent} wrap="truncate">
        {`${"NAME".padEnd(nameW)} ${"TYPE".padEnd(typeW)} ${"SIZE".padStart(sizeW)} ${"MODIFIED".padEnd(dateW)}`}
      </Text>
      {entries.length === 0 ? <Text color={THEME.dim}>No images or folders here.</Text> : null}
      {entries.slice(offset, offset + rows).map((e, i) => {
        const selected = offset + i === cursor;
        const name = e.kind === "image" ? sanitize(e.name) : `${sanitize(e.name)}/`;
        const line = `${truncate(name, nameW).padEnd(nameW)} ${(e.kind === "image" ? (e.format ?? "") : "dir").padEnd(typeW)} ${(e.kind === "image" ? formatBytes(e.size) : "").padStart(sizeW)} ${fmtDate(e.modified).padEnd(dateW)}`;
        return (
          <Text key={e.path} wrap="truncate" backgroundColor={selected ? THEME.selectedBg : undefined} bold={selected} color={e.kind === "image" ? "white" : THEME.accent}>
            {line.padEnd(inner)}
          </Text>
        );
      })}
    </Frame>
  );
}

interface InspectorViewProps {
  rows: Row[];
  cursor: number;
  offset: number;
  marks: ReadonlySet<string>;
  pendingRemovals: ReadonlySet<string>;
  pendingSets: ReadonlyMap<string, string>;
  title: string;
  width: number;
  height: number;
  bodyRows: number;
  filter?: string;
  total: number;
}

function InspectorView({ rows, cursor, offset, marks, pendingRemovals, pendingSets, title, width, height, bodyRows, filter, total }: InspectorViewProps) {
  const inner = width - 4;
  const nameW = Math.min(30, Math.max(16, Math.floor(inner * 0.32)));
  const valueW = Math.max(8, inner - nameW - 6);
  return (
    <Frame title={`Metadata(${sanitize(title)})`} subtitle={`[${total}]${filter ? ` </${filter}>` : ""}`} width={width} height={height}>
      <Text bold color={THEME.accent} wrap="truncate">
        {`   ${"FIELD".padEnd(nameW)} VALUE`}
      </Text>
      {rows.length === 0 ? <Text color={THEME.dim}>{filter ? "No fields match the filter." : "No metadata in this image."}</Text> : null}
      {rows.slice(offset, offset + bodyRows).map((row, i) => {
        const selected = offset + i === cursor;
        if (row.type === "group") {
          return (
            <Text key={`g:${row.group}`} wrap="truncate" backgroundColor={selected ? THEME.selectedBg : undefined} bold color={THEME.title}>
              {` ▾ ${row.title} (${row.count})`.padEnd(inner)}
            </Text>
          );
        }
        const f: MetadataField = row.field;
        const removed = pendingRemovals.has(f.id);
        const newValue = pendingSets.get(f.id);
        const marked = marks.has(f.id);
        const flag = removed ? "✗" : newValue !== undefined ? "~" : marked ? "●" : f.sensitive ? "•" : " ";
        const flagColor = removed ? THEME.removed : newValue !== undefined ? THEME.updated : marked ? THEME.marked : THEME.sensitive;
        const value = newValue !== undefined ? `${truncate(sanitize(f.value), Math.floor(valueW / 2) - 2)} → ${sanitize(newValue)}` : sanitize(f.value);
        return (
          <Text key={f.id} wrap="truncate" backgroundColor={selected ? THEME.selectedBg : undefined}>
            <Text color={flagColor}>{` ${flag} `}</Text>
            <Text bold={selected} color={removed ? THEME.dim : marked ? THEME.marked : "white"} strikethrough={removed}>
              {truncate(sanitize(f.name), nameW).padEnd(nameW)}
            </Text>
            <Text> </Text>
            <Text color={removed ? THEME.dim : newValue !== undefined ? THEME.updated : undefined} strikethrough={removed}>
              {truncate(value, valueW).padEnd(valueW)}
            </Text>
          </Text>
        );
      })}
    </Frame>
  );
}

function SidePanel({ width, height, preview, info, doc, field }: { width: number; height: number; preview?: SideImage; info?: ImageInfo; doc?: ImageDocument; field?: MetadataField }) {
  const previewRows = preview?.text ? preview.text.split("\n") : [];
  // Overlays (iTerm2, sixel, kitty) draw over blank cells reserved here.
  const reserved = preview?.draw ? preview.rows : 0;
  const kinds = new Map<string, number>();
  for (const b of doc?.report.blocks ?? []) if (b.kind !== "structure") kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
  return (
    <Frame title="Preview" width={width} height={height}>
      <Box flexDirection="column" alignItems="center">
        {previewRows.map((line, i) => (
          <Text key={i} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
      {reserved > 0 && <Box height={reserved} flexShrink={0} />}
      <Text> </Text>
      {info && (
        <Text wrap="truncate" color={THEME.dim}>
          {`${info.format.toUpperCase()} ${info.width}×${info.height}${info.space ? ` ${info.space}` : ""}${info.hasAlpha ? " alpha" : ""}${info.orientation && info.orientation !== 1 ? ` orient ${info.orientation}` : ""}`}
        </Text>
      )}
      <Text wrap="truncate" color={THEME.dim}>{`blocks: ${[...kinds].map(([k, n]) => `${k}${n > 1 ? `×${n}` : ""}`).join(" ") || "none"}`}</Text>
      {field && (
        <>
          <Text> </Text>
          <Text color={THEME.title} wrap="truncate">
            {sanitize(field.id)}
          </Text>
          <Text wrap="wrap">{truncate(sanitize(field.value), (width - 4) * 3)}</Text>
          {field.note && (
            <Text color={THEME.dim} wrap="wrap">
              {sanitize(field.note)}
            </Text>
          )}
          <Text color={THEME.dim} wrap="truncate">{`removal: ${field.removal}${field.writable ? " · editable" : ""}${field.sensitive ? " · identifying" : ""}`}</Text>
        </>
      )}
    </Frame>
  );
}

function C2paView({ doc, width, height, scroll }: { doc?: ImageDocument; width: number; height: number; scroll: number }) {
  const report = doc?.report.c2pa;
  const lines: { text: string; color?: string; bold?: boolean }[] = [];
  if (!report) {
    lines.push({ text: doc?.fields.some((f) => f.group === "c2pa") ? "The manifest store could not be read." : "No C2PA manifest store in this image.", color: THEME.dim });
    lines.push({ text: "" }, { text: "s  sign a new manifest with the configured signer", color: THEME.dim });
  } else {
    const verdict = c2paVerdict(report);
    lines.push({ text: `Validation: ${verdict.label} — ${verdict.detail}`, color: c2paStateColor(verdict.label), bold: true });
    lines.push({ text: `  ${c2paLadder(report)}`, color: THEME.dim });
    for (const f of report.failures) lines.push({ text: `  ✗ ${sanitize(f.explanation ?? f.code)}  (${sanitize(f.code)})`, color: THEME.bad });
    for (const f of report.warnings) lines.push({ text: `  ! ${sanitize(f.explanation ?? f.code)}  (${sanitize(f.code)})`, color: THEME.marked });
    report.manifests.forEach((m, i) => {
      lines.push({ text: "" }, { text: `${i === 0 ? "Active manifest" : `Manifest ${i + 1}`}  ${m.label}`, color: THEME.title, bold: true });
      const row = (k: string, v?: string) => v && lines.push({ text: `  ${k.padEnd(14)} ${sanitize(v)}` });
      row("Title", m.title);
      row("Generator", m.claimGenerator);
      row("Signed by", [m.signature.commonName, m.signature.issuer].filter(Boolean).join(" / "));
      row("Signed at", m.signature.time);
      row("Algorithm", m.signature.algorithm);
      for (const a of m.actions) row("Action", [a.action, a.digitalSourceType && `(${a.digitalSourceType})`, a.reason && `reason: ${a.reason}`].filter(Boolean).join(" "));
      for (const a of m.assertions) row("Assertion", a.label);
      for (const g of m.ingredients) row("Ingredient", `${g.title ?? "untitled"} (${g.relationship ?? "?"})`);
      for (const r of m.redactions) row("Redacted", r);
    });
  }
  const visible = lines.slice(Math.min(scroll, Math.max(0, lines.length - 1)), Math.min(scroll, Math.max(0, lines.length - 1)) + height - 2);
  return (
    <Frame title="Content Credentials" subtitle={`[${report?.manifests.length ?? 0}]`} width={width} height={height}>
      {visible.map((l, i) => (
        <Text key={i} wrap="truncate" color={l.color} bold={l.bold}>
          {sanitize(l.text) || " "}
        </Text>
      ))}
    </Frame>
  );
}

function HelpView({ width, height }: { width: number; height: number }) {
  const columns: [string, readonly Binding[]][][] = [
    [
      ["Navigation", NAVIGATION],
      ["Preview", PREVIEW],
    ],
    [["Metadata", INSPECTOR]],
    [
      ["Browser", BROWSER],
      ["Content Credentials", C2PA_VIEW],
    ],
  ];
  const colWidth = Math.floor((width - 4) / columns.length);
  const keyWidth = Math.min(14, Math.floor(colWidth * 0.4));
  const section = ([title, bindings]: [string, readonly Binding[]], kw: number) => (
    <Box key={title} flexDirection="column" flexShrink={0}>
      <Text color={THEME.title} bold wrap="truncate">
        {title}
      </Text>
      {bindings.map((b) => (
        <Text key={b.keys} wrap="truncate">
          <Text color={THEME.key}>{` ${b.keys}`.padEnd(kw)}</Text>
          <Text>{b.action}</Text>
        </Text>
      ))}
    </Box>
  );
  const half = Math.ceil(COMMANDS.length / 2);
  const commandWidth = Math.floor((width - 4) / 2);
  return (
    <Frame title="Help" width={width} height={height}>
      <Box flexShrink={0}>
        {columns.map((list, i) => (
          <Box key={i} flexDirection="column" width={colWidth} flexShrink={0}>
            {list.map((s) => section(s, keyWidth))}
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <Text color={THEME.title} bold>
          Commands
        </Text>
        <Box>
          {[COMMANDS.slice(0, half), COMMANDS.slice(half)].map((list, i) => (
            <Box key={i} flexDirection="column" width={commandWidth}>
              {list.map((b) => (
                <Text key={b.keys} wrap="truncate">
                  <Text color={THEME.key}>{` ${b.keys}`.padEnd(24)}</Text>
                  <Text>{b.action}</Text>
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Frame>
  );
}
