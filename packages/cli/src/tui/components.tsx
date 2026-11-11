import React from "react";
import { Box, Text } from "ink";
import type { Binding } from "./keys.js";
import { sanitize, truncate } from "../style.js";

/** k9s-flavoured building blocks: header with context + key hints, titled frames, crumbs, a flash line. */

export const THEME = {
  border: "cyan",
  title: "#ff9f1a",
  accent: "#5fd7ff",
  key: "#5fafff",
  dim: "gray",
  selectedBg: "#005f87",
  marked: "#ffd75f",
  removed: "#ff5f5f",
  updated: "#87d75f",
  sensitive: "#ffaf5f",
  ok: "#5fd787",
  bad: "#ff5f5f",
} as const;

/**
 * Colors of the C2PA validation states, one per rung of the specification's ladder: Invalid red, Well-formed white,
 * Valid yellow (verified, but the signer is not trusted), Trusted green.
 */
export const C2PA_STATE_COLORS: Readonly<Record<string, string>> = {
  Invalid: THEME.bad,
  "Well-formed": "white",
  Valid: THEME.marked,
  Trusted: THEME.ok,
  Remote: THEME.marked,
};
export const c2paStateColor = (label: string): string => C2PA_STATE_COLORS[label] ?? THEME.bad;

const LOGO = ["╻┏┳┓┏━╸╻ ╻┏━┓┏┓╻╺┳┓", "┃┃┃┃┃╺┓┃╻┃┣━┫┃┗┫ ┃┃", "╹╹ ╹┗━┛┗┻┛╹ ╹╹ ╹╺┻┛"];

/** One row of the header's context block: label, value, and optionally the value's color. */
export type ContextRow = readonly [label: string, value: string, color?: string];

export interface HeaderProps {
  readonly width: number;
  readonly context: readonly ContextRow[];
  readonly bindings: readonly Binding[];
}

/** Display width of a hint (every character used in key hints is one cell wide). */
const cells = (text: string) => [...text].length;

export interface HintColumn {
  readonly items: readonly Binding[];
  /** Width of the widest `<key>` in the column: every action in the column starts after it. */
  readonly keyWidth: number;
  readonly width: number;
}

/**
 * Lays the key hints out in columns of `rows`, each as wide as its longest hint, with the same gap between columns.
 * When they don't all fit, the gap shrinks to 2, then columns are dropped from the right, but the last one (help and
 * quit) always stays.
 */
export function layoutHints(bindings: readonly Binding[], rows: number, available: number): { columns: HintColumn[]; gap: number } {
  const columns: HintColumn[] = [];
  for (let i = 0; i < bindings.length; i += rows) {
    const items = bindings.slice(i, i + rows);
    const keyWidth = Math.max(...items.map((b) => cells(`<${b.keys}>`)));
    columns.push({ items, keyWidth, width: keyWidth + 1 + Math.max(...items.map((b) => cells(b.action))) });
  }
  const total = (list: readonly HintColumn[], gap: number) => list.reduce((sum, c) => sum + c.width, 0) + gap * Math.max(0, list.length - 1);
  for (const gap of [3, 2]) if (total(columns, gap) <= available) return { columns, gap };
  const last = columns.at(-1);
  if (!last) return { columns: [], gap: 2 };
  const kept: HintColumn[] = [];
  let used = last.width;
  for (const column of columns.slice(0, -1)) {
    if (used + 2 + column.width > available) break;
    kept.push(column);
    used += 2 + column.width;
  }
  return { columns: [...kept, last], gap: 2 };
}

const SUBTITLE = "lossless metadata surgery";

/** Context on the left, key hints in aligned columns in the middle, the logo on the right (when there is room). */
export function Header({ width, context, bindings }: HeaderProps) {
  const rows = 5;
  const labelWidth = Math.max(...context.map(([k]) => cells(k))) + 2;
  // As wide as the context needs (within limits), so the hints get the rest.
  const contextWidth = Math.min(46, Math.max(28, labelWidth + Math.max(0, ...context.map(([, v]) => cells(sanitize(v)))) + 2));
  const logoWidth = Math.max(...LOGO.map(cells), SUBTITLE.length);
  const showLogo = width >= 110;
  const hintsWidth = Math.max(0, width - contextWidth - (showLogo ? logoWidth + 2 : 0));
  const { columns, gap } = layoutHints(bindings, rows, hintsWidth);
  return (
    <Box height={rows} width={width}>
      <Box flexDirection="column" width={contextWidth} flexShrink={0}>
        {context.slice(0, rows).map(([k, v, color]) => (
          <Text key={k} wrap="truncate">
            <Text color={THEME.title}>{`${k}:`.padEnd(labelWidth)}</Text>
            <Text bold color={color}>
              {truncate(sanitize(v), contextWidth - labelWidth - 1)}
            </Text>
          </Text>
        ))}
      </Box>
      <Box width={hintsWidth} flexShrink={0}>
        {columns.map((column, i) => (
          <Box key={i} flexDirection="column" width={column.width} marginRight={i < columns.length - 1 ? gap : 0} flexShrink={0}>
            {column.items.map((b) => (
              <Text key={b.keys} wrap="truncate">
                <Text color={THEME.key}>{`<${b.keys}>${" ".repeat(column.keyWidth - cells(`<${b.keys}>`))}`}</Text>
                <Text color={THEME.dim}>{` ${b.action}`}</Text>
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      {showLogo && (
        <Box flexDirection="column" width={logoWidth} marginLeft={2} flexShrink={0}>
          {LOGO.map((line, i) => (
            <Text key={i} color={THEME.title}>
              {line}
            </Text>
          ))}
          <Text color={THEME.dim}>{SUBTITLE}</Text>
        </Box>
      )}
    </Box>
  );
}

/** A bordered frame with a centered k9s-style title: ─── Metadata(photo.jpg)[42] ───. */
export function Frame({ title: rawTitle, subtitle: rawSubtitle, width, height, children }: { title: string; subtitle?: string; width: number; height: number; children: React.ReactNode }) {
  const title = sanitize(rawTitle);
  const subtitle = rawSubtitle === undefined ? undefined : sanitize(rawSubtitle);
  const label = ` ${title}${subtitle ? ` ${subtitle}` : ""} `;
  const inner = Math.max(0, width - 2);
  const left = Math.max(1, Math.floor((inner - label.length) / 2));
  const right = Math.max(1, inner - left - label.length);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate">
        <Text color={THEME.border}>{`┌${"─".repeat(left)}`}</Text>
        <Text color={THEME.title} bold>
          {` ${title}`}
        </Text>
        {subtitle ? <Text color={THEME.accent}>{` ${subtitle}`}</Text> : null}
        <Text color={THEME.border}>{` ${"─".repeat(right)}┐`}</Text>
      </Text>
      <Box borderStyle="single" borderTop={false} borderColor={THEME.border} flexDirection="column" width={width} height={height - 1} paddingX={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}

export function Crumbs({ crumbs, right }: { crumbs: readonly string[]; right?: string }) {
  return (
    <Box justifyContent="space-between">
      <Box>
        {crumbs.map((c, i) => (
          <Text key={i}>
            <Text backgroundColor={i === crumbs.length - 1 ? "#ff9f1a" : "#005f87"} color={i === crumbs.length - 1 ? "black" : "white"} bold>{` <${sanitize(c)}> `}</Text>
            <Text> </Text>
          </Text>
        ))}
      </Box>
      {right ? <Text color={THEME.dim}>{right}</Text> : null}
    </Box>
  );
}

export type FlashLevel = "info" | "ok" | "warn" | "error";

export function FlashLine({ text, level }: { text?: string; level?: FlashLevel }) {
  if (!text) return <Text> </Text>;
  const color = level === "error" ? THEME.bad : level === "warn" ? THEME.marked : level === "ok" ? THEME.ok : THEME.accent;
  return (
    <Text color={color} wrap="truncate">
      {text}
    </Text>
  );
}

/** A one-line input (filter, command, prompt) with a block cursor. Always exactly one line, never wraps. */
export function InputLine({ prefix, value, hint }: { prefix: string; value: string; hint?: string }) {
  return (
    <Text wrap="truncate">
      <Text color={THEME.title} bold>
        {sanitize(prefix)}
      </Text>
      <Text>{sanitize(value)}</Text>
      <Text inverse> </Text>
      {hint ? <Text color={THEME.dim}>{`  ${sanitize(hint)}`}</Text> : null}
    </Text>
  );
}

export interface DialogChoice {
  readonly key: string;
  readonly label: string;
}

export interface DialogInput {
  readonly label: string;
  readonly value: string;
}

/**
 * A modal dialog. With `focus` set it is a button dialog: the choices are buttons, the focused one is highlighted
 * and Enter presses it; `input` adds an editable text field above them.
 */
export function Dialog({
  title: rawTitle,
  lines: rawLines,
  choices,
  width,
  input,
  focus,
  error,
}: {
  title: string;
  lines: readonly string[];
  choices: readonly DialogChoice[];
  width: number;
  input?: DialogInput;
  focus?: number;
  error?: string;
}) {
  const title = sanitize(rawTitle);
  const lines = rawLines.map(sanitize);
  const w = Math.min(width - 4, Math.max(50, ...lines.map((l) => l.length + 6), title.length + 8, input ? input.value.length + input.label.length + 10 : 0));
  if (focus !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="double" borderColor={THEME.title} width={w} paddingX={1} alignSelf="center">
        <Text color={THEME.title} bold>
          {title}
        </Text>
        <Text> </Text>
        {lines.map((l, i) => (
          <Text key={i} wrap="truncate">
            {l}
          </Text>
        ))}
        {input && (
          <Text wrap="truncate">
            <Text color={THEME.dim}>{`${input.label}: `}</Text>
            <Text bold>{sanitize(input.value)}</Text>
            <Text inverse> </Text>
          </Text>
        )}
        {error ? <Text color={THEME.bad}>{sanitize(error)}</Text> : <Text> </Text>}
        <Box gap={2} justifyContent="center">
          {choices.map((c, i) => (
            <Text key={c.key} inverse={i === focus} bold={i === focus} color={i === focus ? THEME.title : THEME.dim}>
              {`  ${c.label}  `}
            </Text>
          ))}
        </Box>
        <Text color={THEME.dim}>{"enter: choose · tab/←/→: switch · esc: cancel"}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={THEME.title} width={w} paddingX={1} alignSelf="center">
      <Text color={THEME.title} bold>
        {title}
      </Text>
      <Text> </Text>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate">
          {l}
        </Text>
      ))}
      <Text> </Text>
      <Box gap={2}>
        {choices.map((c) => (
          <Text key={c.key}>
            <Text color={THEME.key} bold>{`[${c.key}]`}</Text> {c.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
