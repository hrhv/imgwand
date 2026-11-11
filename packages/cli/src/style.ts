/** Minimal ANSI styling that respects NO_COLOR and non-TTY output. */

export interface Style {
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

export function createStyle(enabled: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

export function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return Boolean(isTTY) && env.TERM !== "dumb";
}

/**
 * Makes untrusted text (metadata comes from arbitrary files) safe to print: removes complete escape sequences in
 * both 7-bit (ESC [, ESC ], ESC P, ESC _, ESC ^, ESC X) and 8-bit C1 forms (CSI 0x9b, OSC 0x9d, DCS 0x90, ...),
 * then every remaining control character. Tabs become spaces and newlines a visible marker, so one value always
 * stays on one line.
 */
export function sanitize(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "") // CSI
      // eslint-disable-next-line no-control-regex
      .replace(/(?:\x1b[\]P_^X]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "") // OSC, DCS, SOS, PM, APC
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[ -/]*[0-~]?/g, "") // other escapes: ESC c (reset), ESC ( B, ESC 7, ...
      .replace(/\t/g, " ")
      .replace(/\r?\n/g, "↵ ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
  );
}

/** Display width-aware truncation (single-width assumption, which holds for the ASCII-heavy metadata we print). */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/**
 * JSON for terminals: JSON.stringify escapes only U+0000-U+001F, but U+007F-U+009F (8-bit C1 controls such as
 * U+009B, which some terminals treat as CSI) can come from file metadata too, so escape those as well.
 */
export function safeJson(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
