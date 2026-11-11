/** Key bindings, shown in the header hints and on the help screen. */

export interface Binding {
  readonly keys: string;
  readonly action: string;
}

export const NAVIGATION: readonly Binding[] = [
  { keys: "j/k ↑/↓", action: "move" },
  { keys: "g/G", action: "top / bottom" },
  { keys: "ctrl-d/u", action: "page down / up" },
  { keys: "/", action: "filter" },
  { keys: ":", action: "command" },
  { keys: "esc", action: "back / clear" },
  { keys: "?", action: "help" },
  { keys: "q", action: "quit" },
];

export const BROWSER: readonly Binding[] = [
  { keys: "enter", action: "open" },
  { keys: "h/⌫", action: "parent dir" },
  { keys: "p", action: "preview" },
  { keys: ".", action: "hidden files" },
  { keys: "r", action: "refresh" },
  { keys: "d", action: "duplicate" },
];

export const INSPECTOR: readonly Binding[] = [
  { keys: "space", action: "mark" },
  { keys: "a", action: "mark group" },
  { keys: "d", action: "delete marked" },
  { keys: "P", action: "privacy strip" },
  { keys: "D", action: "strip all" },
  { keys: "e", action: "edit value" },
  { keys: "n", action: "new field" },
  { keys: "u", action: "undo" },
  { keys: "w", action: "write" },
  { keys: "c", action: "C2PA" },
  { keys: "p", action: "preview" },
];

export const C2PA_VIEW: readonly Binding[] = [
  { keys: "s", action: "sign" },
  { keys: "r", action: "redact" },
  { keys: "x", action: "remove" },
  { keys: "w", action: "write" },
];

export const PREVIEW: readonly Binding[] = [
  { keys: "esc/q", action: "back" },
  { keys: "g", action: "cycle graphics" },
];

export const COMMANDS: readonly Binding[] = [
  { keys: ":rm <selector…>", action: "stage removal" },
  { keys: ":set <id>=<value>", action: "stage a value" },
  { keys: ":privacy  :strip-all", action: "stage a preset" },
  { keys: ":w  :wq  :q  :q!", action: "write / quit" },
  { keys: ":undo  :reset", action: "undo / drop all" },
  { keys: ":open <path>  :c2pa", action: "open / view" },
];
