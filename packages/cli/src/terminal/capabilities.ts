import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, constants, openSync, readSync } from "node:fs";

/**
 * Works out how to draw images in the current terminal: which graphics protocol it speaks, whether we are inside
 * tmux (and whether tmux will pass graphics through), and how big a character cell is in pixels.
 */

export type GraphicsProtocol = "kitty" | "iterm" | "sixel" | "blocks" | "ascii" | "none";
export const PROTOCOLS: readonly GraphicsProtocol[] = ["kitty", "iterm", "sixel", "blocks", "ascii", "none"];

export interface TmuxInfo {
  /** The terminal tmux's client is attached to (TERM of the outer terminal), e.g. "xterm-kitty". */
  readonly clientTermName?: string;
  /** The outer terminal's self-reported name, e.g. "iTerm2 3.5.0", "WezTerm 20240203". */
  readonly clientTermType?: string;
  /** `allow-passthrough` is on, so graphics escape sequences reach the outer terminal. */
  readonly passthrough: boolean;
  readonly version?: string;
}

export interface Capabilities {
  readonly protocol: GraphicsProtocol;
  /** Why this protocol was chosen (shown by `imgwand -v`). */
  readonly reason: string;
  readonly terminal: string;
  readonly tmux?: TmuxInfo;
  readonly truecolor: boolean;
  /** Kitty images are placed with Unicode placeholders (needed inside tmux, where cursor-positioned images break). */
  readonly kittyPlaceholders: boolean;
  /** Size of one character cell in pixels (measured, or a typical default). */
  readonly cell: { readonly width: number; readonly height: number; readonly measured: boolean };
  /** Warnings for the user, e.g. how to enable tmux passthrough. */
  readonly hints: readonly string[];
}

export type Exec = (command: string, args: readonly string[]) => string | undefined;

export const defaultExec: Exec = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

export function tmuxInfo(env: NodeJS.ProcessEnv, exec: Exec): TmuxInfo | undefined {
  if (!env.TMUX) return undefined;
  const client = exec("tmux", ["display-message", "-p", "#{client_termname}\t#{client_termtype}"]);
  const [clientTermName, clientTermType] = (client ?? "").split("\t");
  const passthrough = exec("tmux", ["show-options", "-gqv", "allow-passthrough"]);
  const version = exec("tmux", ["-V"]);
  return {
    clientTermName: clientTermName || undefined,
    clientTermType: clientTermType || undefined,
    passthrough: passthrough === "on" || passthrough === "all",
    version: version?.replace(/^tmux\s+/, ""),
  };
}

interface Guess {
  protocol: GraphicsProtocol;
  terminal: string;
  reason: string;
}

/** Identifies the terminal from environment variables (and the tmux client, when inside tmux). */
export function guessFromEnvironment(env: NodeJS.ProcessEnv, tmux?: TmuxInfo): Guess {
  const term = (tmux?.clientTermName ?? env.TERM ?? "").toLowerCase();
  const type = (tmux?.clientTermType ?? "").toLowerCase();
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  const lcTerminal = (env.LC_TERMINAL ?? "").toLowerCase();
  const via = tmux ? " (outer terminal of tmux)" : "";

  if (env.KITTY_WINDOW_ID || term.includes("kitty") || type.startsWith("kitty")) return { protocol: "kitty", terminal: "kitty", reason: `kitty detected${via}` };
  if (program === "ghostty" || env.GHOSTTY_RESOURCES_DIR || term.includes("ghostty") || type.startsWith("ghostty")) {
    return { protocol: "kitty", terminal: "Ghostty", reason: `Ghostty detected${via}` };
  }
  if (program === "wezterm" || env.WEZTERM_EXECUTABLE || type.startsWith("wezterm") || term.includes("wezterm")) {
    return { protocol: "iterm", terminal: "WezTerm", reason: `WezTerm detected${via}` };
  }
  if (program === "iterm.app" || lcTerminal === "iterm2" || type.startsWith("iterm2")) return { protocol: "iterm", terminal: "iTerm2", reason: `iTerm2 detected${via}` };
  if (env.KONSOLE_VERSION || type.startsWith("konsole")) return { protocol: "kitty", terminal: "Konsole", reason: `Konsole detected${via}` };
  if (program === "warpterminal" || program === "warp") return { protocol: "kitty", terminal: "Warp", reason: "Warp detected" };
  if (env.WT_SESSION) return { protocol: "sixel", terminal: "Windows Terminal", reason: "Windows Terminal detected (sixel)" };
  if (term.startsWith("foot") || type.startsWith("foot")) return { protocol: "sixel", terminal: "foot", reason: `foot detected${via}` };
  if (term.includes("mlterm") || term.includes("contour") || type.startsWith("contour")) return { protocol: "sixel", terminal: term || type, reason: `sixel terminal detected${via}` };
  if (program === "apple_terminal") return { protocol: "blocks", terminal: "Terminal.app", reason: "Terminal.app has no image protocol; using colored blocks" };
  if (program === "vscode") return { protocol: "blocks", terminal: "VS Code", reason: "VS Code terminal: images need terminal.integrated.enableImages; using colored blocks" };
  if (term === "dumb" || term === "") return { protocol: "ascii", terminal: term || "unknown", reason: "no capable terminal detected" };
  return { protocol: "blocks", terminal: env.TERM_PROGRAM ?? env.TERM ?? "unknown", reason: "no image protocol detected; using colored blocks" };
}

export interface DetectOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly exec?: Exec;
  /** Forced protocol (--graphics / IMGWAND_GRAPHICS). "auto" means detect. */
  readonly force?: GraphicsProtocol | "auto";
  /** Results of active terminal queries, when the caller could run them (see queryTerminal). */
  readonly query?: { readonly sixel?: boolean; readonly kitty?: boolean; readonly cell?: { width: number; height: number } };
}

export function detectCapabilities(options: DetectOptions = {}): Capabilities {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const tmux = tmuxInfo(env, exec);
  const hints: string[] = [];
  const truecolor = /truecolor|24bit/i.test(env.COLORTERM ?? "") || Boolean(env.KITTY_WINDOW_ID || env.WT_SESSION || env.TERM_PROGRAM);
  let guess = guessFromEnvironment(env, tmux);

  if (options.query?.kitty && guess.protocol !== "kitty") guess = { protocol: "kitty", terminal: guess.terminal, reason: "terminal answered the kitty graphics query" };
  else if (options.query?.sixel && (guess.protocol === "blocks" || guess.protocol === "ascii")) {
    guess = { protocol: "sixel", terminal: guess.terminal, reason: "terminal reports sixel support" };
  }

  const forced = options.force ?? (env.IMGWAND_GRAPHICS as GraphicsProtocol | "auto" | undefined);
  if (forced && forced !== "auto") {
    if (!PROTOCOLS.includes(forced)) hints.push(`Unknown graphics mode "${forced}"; using auto-detection`);
    else guess = { protocol: forced, terminal: guess.terminal, reason: "forced with --graphics / IMGWAND_GRAPHICS" };
  }

  // Inside tmux, image escapes only reach the outer terminal with passthrough enabled. Sixel is the exception:
  // tmux 3.4+ built with sixel support renders it itself.
  if (tmux && !tmux.passthrough && (guess.protocol === "kitty" || guess.protocol === "iterm")) {
    hints.push("tmux is not passing graphics through; run `tmux set -g allow-passthrough on` for full-quality images");
    guess = { protocol: "blocks", terminal: guess.terminal, reason: `${guess.reason}, but tmux allow-passthrough is off; using colored blocks` };
  }

  return {
    protocol: guess.protocol,
    reason: guess.reason,
    terminal: guess.terminal,
    tmux,
    truecolor,
    kittyPlaceholders: Boolean(tmux) && guess.protocol === "kitty",
    cell: options.query?.cell ? { ...options.query.cell, measured: true } : { width: 8, height: 16, measured: false },
    hints,
  };
}

/** Wraps an escape sequence so tmux forwards it to the outer terminal (DCS passthrough, ESC doubled). */
export function tmuxWrap(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

export interface QueryIo {
  /** Opens a private read handle on the controlling terminal; undefined when there is none. */
  readonly openTty?: () => NodeJS.ReadStream | undefined;
  readonly stdout: NodeJS.WriteStream;
}

/** A separate handle on /dev/tty, so process.stdin (which Ink reads later) is never paused or resumed here. */
export function openControllingTty(): NodeJS.ReadStream | undefined {
  if (process.platform === "win32") return undefined;
  // Raw mode is a property of the terminal, not of a descriptor: it is switched through stdin, which must be it.
  const stdin = process.stdin as NodeJS.ReadStream;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return undefined;
  let fd: number;
  try {
    fd = openSync("/dev/tty", constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  // A non-blocking descriptor polled on a timer, never a stream: a stream keeps a read pending in the background,
  // and under Bun (the standalone binary) that read outlives destroy() and swallows the user's next keystroke.
  const handle = new EventEmitter() as EventEmitter & { setRawMode(on: boolean): void; destroy(): void };
  const buffer = Buffer.alloc(4096);
  const poll = setInterval(() => {
    for (;;) {
      let n = 0;
      try {
        n = readSync(fd, buffer, 0, buffer.length, null);
      } catch {
        return; // EAGAIN: nothing typed yet
      }
      if (n <= 0) return;
      handle.emit("data", Buffer.from(buffer.subarray(0, n)));
    }
  }, 10);
  handle.setRawMode = (on: boolean) => {
    stdin.setRawMode(on);
  };
  handle.destroy = () => {
    clearInterval(poll);
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  };
  return handle as unknown as NodeJS.ReadStream;
}

/**
 * Asks the terminal about itself: kitty graphics support, sixel support (DA1 attribute 4) and cell size
 * (CSI 16 t). A DA1 request is sent last; every terminal answers it (in order), so the wait normally ends as
 * soon as the replies are in. The timeout is generous because a reply that arrives after this handle is closed
 * would be read by the UI as keystrokes.
 */
export async function queryTerminal(io: QueryIo, timeoutMs = 300, inTmux = false): Promise<DetectOptions["query"]> {
  const { stdout } = io;
  if (!stdout.isTTY) return undefined;
  const tty = (io.openTty ?? openControllingTty)();
  if (!tty || typeof tty.setRawMode !== "function") return undefined;
  const kittyQuery = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
  let answer = "";
  try {
    tty.setRawMode(true);
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      tty.on("data", (chunk: Buffer) => {
        answer += chunk.toString("latin1");
        if (/\x1b\[\?[\d;]*c/.test(answer)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    stdout.write((inTmux ? tmuxWrap(kittyQuery) : kittyQuery) + "\x1b[16t" + "\x1b[c");
    await done;
  } finally {
    tty.setRawMode(false);
    tty.destroy();
  }
  const da1 = /\x1b\[\?([\d;]*)c/.exec(answer);
  const cell = /\x1b\[6;(\d+);(\d+)t/.exec(answer);
  return {
    kitty: /\x1b_Gi=31;OK/.test(answer),
    sixel: da1 ? da1[1]!.split(";").includes("4") : false,
    cell: cell ? { width: Number(cell[2]), height: Number(cell[1]) } : undefined,
  };
}
