import { Command, CommanderError, Option } from "commander";
import { C2PA_ALGORITHMS, DIGITAL_SOURCE_TYPES, isImgwandError, VERSION } from "@hrhv/imgwand";
import { c2paRedactCommand, c2paRemoveCommand, c2paShowCommand, c2paSignCommand } from "./commands/c2pa.js";
import { setCommand, stripCommand } from "./commands/edit.js";
import { fieldsHelp, infoCommand, type NativeInfo } from "./commands/info.js";
import { parseGraphics, previewCommand } from "./commands/preview.js";
import { C2PA_POLICY_HELP, type CommandContext } from "./commands/shared.js";
import { showCommand } from "./commands/show.js";
import { loadConfig, type Config } from "./config.js";
import { colorEnabled, createStyle, sanitize } from "./style.js";
import { detectCapabilities, queryTerminal, type Capabilities, type DetectOptions, type GraphicsProtocol } from "./terminal/capabilities.js";

export interface TuiOptions {
  readonly path: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly config: Config;
  readonly capabilities: Capabilities;
}

export interface CliDeps {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  /** Whether stdout is a terminal (enables color and the TUI). */
  readonly isTTY?: boolean;
  readonly terminalSize?: () => { cols: number; rows: number };
  /** Terminal capability detection (tests inject a fixed answer). */
  readonly detect?: (options: DetectOptions) => Capabilities | Promise<Capabilities>;
  /** Starts the interactive UI; loaded lazily so plain commands never load React/Ink. */
  readonly launchTui?: (options: TuiOptions) => Promise<number>;
  readonly config?: Config;
  readonly native?: NativeInfo;
}

const EXAMPLES = `
Examples:
  $ imgwand                                   browse the current directory in the interactive UI
  $ imgwand photo.jpg                         inspect one image interactively
  $ imgwand show photo.jpg                    print every metadata field
  $ imgwand strip photo.jpg -f privacy --in-place
  $ imgwand strip *.jpg -f gps -f xmp:dc:creator --in-place --backup
  $ imgwand strip photo.jpg -f all -f '!icc' -o clean.jpg
  $ imgwand set photo.jpg exif:IFD0:Artist="Jane Doe" xmp:dc:title="Sunset" --in-place
  $ imgwand c2pa show signed.jpg
  $ imgwand c2pa sign photo.jpg --cert chain.pem --key key.pem --source-type digitalCapture --in-place
  $ imgwand c2pa redact signed.jpg cawg.training-mining --cert chain.pem --key key.pem -o redacted.jpg
  $ imgwand preview photo.jpg --graphics sixel

Edits are lossless: the compressed picture is never re-encoded, and every write is verified and atomic.`;

function addWriteOptions(cmd: Command): Command {
  return cmd
    .option("-o, --output <file>", "write the result to this file")
    .option("-i, --in-place", "overwrite the input file")
    .option("-n, --dry-run", "show what would change without writing anything")
    .option("--backup", "keep a copy of the original as <file>.bak")
    .option("--force", "allow -o to overwrite an existing file");
}

export async function run(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.writeOut ?? ((t: string) => void process.stdout.write(t));
  const err = deps.writeErr ?? ((t: string) => void process.stderr.write(t));
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  const terminalSize = deps.terminalSize ?? (() => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }));

  let exitCode = 0;
  let config: Config = {};
  let ctx: CommandContext | undefined;
  const context = (): CommandContext => {
    if (!ctx) {
      config = deps.config ?? loadConfig(env);
      const global = program.opts<{ color?: boolean }>();
      ctx = { cwd, env, config, style: createStyle(global.color !== false && colorEnabled(env, isTTY)), out, err };
    }
    return ctx;
  };
  const capabilities = async (): Promise<Capabilities> => {
    const forced = parseGraphics(program.opts<{ graphics?: string }>().graphics) ?? context().config.graphics;
    if (deps.detect) return deps.detect({ env, force: forced });
    const query = isTTY && forced === undefined ? await queryTerminal({ stdout: process.stdout }, 800, Boolean(env.TMUX)).catch(() => undefined) : undefined;
    return detectCapabilities({ env, force: forced, query });
  };
  const action =
    <A extends unknown[]>(fn: (...args: A) => Promise<number>) =>
    async (...args: A) => {
      exitCode = await fn(...args);
    };

  const program = new Command()
    .name("imgwand")
    .description("Inspect image metadata in a k9s-style terminal UI and remove it losslessly: EXIF, GPS, XMP, IPTC, ICC, comments and C2PA Content Credentials.")
    .version(VERSION, "-V, --version", "output the version number")
    .option("-v, --info", "show versions, native libraries and terminal graphics support (include this in bug reports)")
    .addOption(new Option("--graphics <mode>", "image protocol for previews").choices(["auto", "kitty", "iterm", "sixel", "blocks", "ascii", "none"]))
    .option("--no-color", "disable colored output")
    .argument("[path]", "image or directory to open in the interactive UI", ".")
    .addHelpText("after", EXAMPLES)
    .configureOutput({ writeOut: out, writeErr: err })
    .exitOverride()
    .action(
      action(async (path: string) => {
        const c = context();
        if (program.opts<{ info?: boolean }>().info) return infoCommand(c, await capabilities(), deps.native);
        if (!isTTY) {
          c.err("The interactive UI needs a terminal. For scripts, use `imgwand show <file>` or `imgwand strip ...` (see --help).\n");
          return 2;
        }
        const launch = deps.launchTui ?? (async (o: TuiOptions) => (await import("./tui/index.js")).launchTui(o));
        return launch({ path, cwd, env, config: c.config, capabilities: await capabilities() });
      }),
    );

  program
    .command("show")
    .description("print the metadata of one or more images")
    .argument("<files...>")
    .option("--json", "machine-readable output")
    .option("-g, --group <group...>", "only these groups (exif, gps, xmp, iptc, icc, c2pa, ...)")
    .option("--no-c2pa", "skip reading C2PA manifests")
    .action(action((files: string[], opts: { json?: boolean; group?: string[]; c2pa?: boolean }) => showCommand(context(), files, { ...opts, width: isTTY ? terminalSize().cols : 100 })));

  addWriteOptions(
    program
      .command("strip")
      .description("remove metadata fields (lossless)")
      .argument("<files...>")
      .requiredOption("-f, --field <selector...>", "what to remove: field ids, globs, groups or presets (see `imgwand fields`)")
      .option("--c2pa <policy>", C2PA_POLICY_HELP, "fail")
      .option("--json", "machine-readable output"),
  ).action(action((files: string[], opts) => stripCommand(context(), files, opts)));

  addWriteOptions(
    program
      .command("set")
      .description("set or create metadata fields (EXIF, XMP, IPTC, comments)")
      .argument("<file>")
      .argument("<assignments...>", "<field>=<value> pairs")
      .option("-f, --field <selector...>", "also remove these fields")
      .option("--c2pa <policy>", C2PA_POLICY_HELP, "fail")
      .option("--json", "machine-readable output"),
  ).action(action((file: string, assignments: string[], opts) => setCommand(context(), file, assignments, opts)));

  const c2pa = program.command("c2pa").description("C2PA Content Credentials: show, sign, redact, remove");
  c2pa
    .command("show")
    .description("show and validate the manifest store")
    .argument("<file>")
    .option("--json", "machine-readable output")
    .option("--trust <pem>", "extra trust anchors (PEM)")
    .option("--network", "allow fetching remote manifests")
    .action(action((file: string, opts) => c2paShowCommand(context(), file, opts)));
  const signOptions = (cmd: Command) =>
    addWriteOptions(
      cmd
        .option("--cert <pem>", "signing certificate chain (PEM)")
        .option("--key <pem>", "private key (PEM)")
        .addOption(new Option("--alg <alg>", "signing algorithm").choices([...C2PA_ALGORITHMS]))
        .option("--tsa <url>", "RFC 3161 time-stamp authority")
        .option("--title <title>", "manifest title (default: file name)")
        .option("--trust <pem>", "extra trust anchors (PEM) for validating the result"),
    );
  signOptions(
    c2pa
      .command("sign")
      .description("sign a new manifest; an existing manifest store becomes its parent ingredient")
      .argument("<file>")
      .addOption(new Option("--source-type <type>", "how the content was made (required for a new history)").choices([...DIGITAL_SOURCE_TYPES]))
      .option("--no-history", "start a new history instead of building on the existing manifest"),
  ).action(action((file: string, opts) => c2paSignCommand(context(), file, opts)));
  signOptions(
    c2pa
      .command("redact")
      .description("re-sign with assertions redacted from the existing manifests")
      .argument("<file>")
      .argument("<assertions...>", "assertion labels (e.g. cawg.training-mining) or JUMBF URIs")
      .option("--reason <reason>", "redaction reason", "c2pa.PII.present"),
  ).action(action((file: string, assertions: string[], opts) => c2paRedactCommand(context(), file, assertions, opts)));
  addWriteOptions(c2pa.command("remove").description("remove the embedded manifest store").argument("<file>")).action(
    action((file: string, opts) => c2paRemoveCommand(context(), file, opts)),
  );

  program
    .command("preview")
    .description("draw an image in the terminal (kitty, iTerm2, sixel, or colored blocks)")
    .argument("<file>")
    .option("-W, --width <cols>", "width in character cells")
    .option("-H, --height <rows>", "height in character cells")
    .action(action(async (file: string, opts) => previewCommand(context(), file, opts, await capabilities(), terminalSize())));

  program
    .command("cache")
    .description("manage the native libraries a standalone binary extracts on first run")
    .command("clean")
    .description("remove cached native libraries that the running binary does not use")
    .action(
      action(async () => {
        const { cleanNativeCache } = await import("./native/extract.js");
        const removed = cleanNativeCache(env, deps.native?.cacheDir);
        context().out(removed.length ? `${removed.map((p) => `removed ${sanitize(p)}`).join("\n")}\n` : "Nothing to clean.\n");
        return 0;
      }),
    );

  program
    .command("fields")
    .description("explain field ids, groups, presets and selectors")
    .action(
      action(async () => {
        context().out(`${fieldsHelp()}\n`);
        return 0;
      }),
    );

  try {
    await program.parseAsync(argv as string[], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    // Not context(): if loading the config is what failed, calling it again would throw from here.
    const style = ctx?.style ?? createStyle(colorEnabled(env, isTTY));
    if (isImgwandError(error)) {
      err(`${style.red("error")} ${sanitize(error.message)}\n`);
      return 1;
    }
    // File-system errors are expected (missing file, no permission); anything else is a bug worth a stack trace.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
      err(`${style.red("error")} ${sanitize((error as Error).message)}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Stack traces are printed line by line through sanitize() too: messages can quote file content.
    const detail = env.IMGWAND_DEBUG && error instanceof Error && error.stack ? error.stack.split("\n").map(sanitize).join("\n") : `${sanitize(message)} (set IMGWAND_DEBUG=1 for a stack trace)`;
    err(`${style.red("unexpected error")} ${detail}\n`);
    return 1;
  }
}

export type { GraphicsProtocol };
