// QWERTY layout for the full keyboard grid, plus resolveSend — the byte(s) a
// key produces given the current one-shot modifier state. The customizable
// top bar uses spec.ts/parseSend instead; this backs only the fixed grid.

// The three grid pages, matching the reference keyboard: letters, then two
// symbol pages toggled by the 1/2 <-> 2/2 key sitting in the Shift position.
export type PageId = "letters" | "symbols1" | "symbols2";

export type KeyKind =
  | "char" // a printable character (default) — obeys shift/ctrl/alt
  | "shift" // one-shot Shift toggle
  | "ctrl" // one-shot Ctrl toggle
  | "alt" // one-shot Alt toggle
  | "page" // switch to the page named by `target`
  | "backspace"
  | "enter"
  | "space"
  | "spacer"; // non-interactive gap that staggers a row (renders nothing)

export interface KeyDef {
  label: string;
  // Bytes for a "char" key when unshifted; defaults to `label`. Set explicitly
  // only when the sent character differs from the shown label.
  send?: string;
  // Label/bytes when Shift is armed. For a plain letter both default to the
  // uppercase of the base (so a-z need neither field); digits/punctuation with
  // a distinct shifted glyph set both (e.g. "1" -> "!").
  shiftLabel?: string;
  shiftSend?: string;
  kind?: KeyKind;
  // Destination page for a "page" key.
  target?: PageId;
  // The key's width in grid units (default 1, i.e. one character cell). Every
  // row sums to ROW_UNITS units so a "1" here is the same fraction of the width
  // on every row — that's what keeps columns aligned. Rows shorter than a full
  // complement absorb the slack with "spacer" keys, producing the half-key
  // indent of a real staggered keyboard (see the reference in .backups).
  width?: number;
}

// Every row's widths (keys + spacers) sum to this. A phone row fits ~10 cells.
export const ROW_UNITS = 10;

const spacer = (width: number): KeyDef => ({ label: "", kind: "spacer", width });

const ROW_DIGITS: KeyDef[] = [
  { label: "1", shiftLabel: "!", shiftSend: "!" },
  { label: "2", shiftLabel: "@", shiftSend: "@" },
  { label: "3", shiftLabel: "#", shiftSend: "#" },
  { label: "4", shiftLabel: "$", shiftSend: "$" },
  { label: "5", shiftLabel: "%", shiftSend: "%" },
  { label: "6", shiftLabel: "^", shiftSend: "^" },
  { label: "7", shiftLabel: "&", shiftSend: "&" },
  { label: "8", shiftLabel: "*", shiftSend: "*" },
  { label: "9", shiftLabel: "(", shiftSend: "(" },
  { label: "0", shiftLabel: ")", shiftSend: ")" },
];

const chars = (s: string): KeyDef[] => [...s].map((label) => ({ label }));

// A symbol key whose label is exactly the character it sends (no shift glyph).
const sym = (s: string): KeyDef[] => [...s].map((label) => ({ label, kind: "char" as const }));

// Wide end keys, sized so their rows still sum to ROW_UNITS (see below). Ctrl
// and Alt aren't grid keys — they live in the special-key top bar (as one-shot
// modifiers driving the grid's mod state), matching the reference layout, which
// keeps only the page toggle, slash, space, period and enter on the bottom row.
const SHIFT: KeyDef = { label: "⇧", kind: "shift", width: 1.5 };
const BACKSPACE: KeyDef = { label: "⌫", kind: "backspace", width: 1.5 };
const SPACE: KeyDef = { label: "space", kind: "space", width: 5 };
const ENTER: KeyDef = { label: "⏎", kind: "enter", width: 1.5 };
const DOT: KeyDef = { label: ".", kind: "char" };
const SLASH: KeyDef = { label: "/", kind: "char" };

// Page-navigation keys. The letter page's bottom-left goes to symbol page 1;
// the symbol pages' bottom-left returns to letters; and the 1/2 <-> 2/2 key in
// the Shift position flips between the two symbol pages (matching the reference
// keyboard's two-page symbol mode).
const TO_SYMBOLS: KeyDef = { label: "!#1", kind: "page", target: "symbols1", width: 1.5 };
const TO_LETTERS: KeyDef = { label: "ABC", kind: "page", target: "letters", width: 1.5 };
const TO_SYMBOLS_2: KeyDef = { label: "1/2", kind: "page", target: "symbols2", width: 1.5 };
const TO_SYMBOLS_1: KeyDef = { label: "2/2", kind: "page", target: "symbols1", width: 1.5 };

// Rows are staggered like a physical keyboard rather than gridded into strict
// columns: the number and top letter rows span the full 10 units, the home row
// is inset half a key on each side, and the bottom letter row is bracketed by a
// wide Shift and Backspace. Each row's widths sum to ROW_UNITS = 10:
//   digits/qwerty  10x1                     = 10
//   asdfghjkl      0.5 + 9x1 + 0.5          = 10
//   zxcvbnm        1.5(⇧) + 7x1 + 1.5(⌫)    = 10
//   bottom         1.5 + 1 + 5 + 1 + 1.5    = 10
export const LETTER_PAGE: KeyDef[][] = [
  ROW_DIGITS,
  chars("qwertyuiop"),
  [spacer(0.5), ...chars("asdfghjkl"), spacer(0.5)],
  [SHIFT, ...chars("zxcvbnm"), BACKSPACE],
  [TO_SYMBOLS, SLASH, SPACE, DOT, ENTER],
];

// Symbol page 1, mirroring the reference: the common punctuation. The 1/2 key
// (Shift position) flips to page 2. Every printable ASCII the letter page
// doesn't reach lives across these two pages (verified by the coverage test).
// Row 4 = 1/2(1.5) + 7x1 + ⌫(1.5) = 10.
export const SYMBOL_PAGE_1: KeyDef[][] = [
  ROW_DIGITS,
  sym("+×÷=/_<>[]"),
  sym("!@#$%^&*()"),
  [TO_SYMBOLS_2, ...sym("-'\":;,?"), BACKSPACE],
  [TO_LETTERS, SLASH, SPACE, DOT, ENTER],
];

// Symbol page 2, mirroring the reference: backtick/tilde/brackets and currency
// on row 2 (the ASCII ones — ` ~ \ | { } — complete printable-ASCII coverage),
// then assorted glyphs. The 2/2 key (Shift position) flips back to page 1.
// Non-ASCII glyphs send their UTF-8 as-is. Row 4 = 2/2(1.5) + 7x1 + ⌫(1.5) = 10.
export const SYMBOL_PAGE_2: KeyDef[][] = [
  ROW_DIGITS,
  sym("`~\\|{}€£¥₩"),
  sym("°·○●□■♤♡◇♧"),
  [TO_SYMBOLS_1, ...sym("☆▪¤《》¡¿"), BACKSPACE],
  [TO_LETTERS, SLASH, SPACE, DOT, ENTER],
];

export interface Mods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

// The glyph to show on a key given the armed modifiers — uppercased letters and
// shifted symbols when Shift is armed, so the keyboard face reflects what a tap
// will send.
export function resolveLabel(key: KeyDef, mods: Mods): string {
  if ((key.kind ?? "char") !== "char") return key.label;
  if (mods.shift) {
    if (key.shiftLabel !== undefined) return key.shiftLabel;
    if (/^[a-z]$/.test(key.label)) return key.label.toUpperCase();
  }
  return key.label;
}

// The bytes a key sends given the armed one-shot modifiers. Non-char kinds map
// to their control bytes (Backspace -> DEL, Enter -> CR, Space -> SP); char
// keys apply Shift (shifted glyph / uppercase), then Ctrl (C0 control code for
// @A-Z[\]^_ and, as a convenience, lowercase letters), then Alt (ESC prefix,
// the standard meta convention). Page/shift/ctrl/alt keys never reach here —
// the component handles them as state toggles.
export function resolveSend(key: KeyDef, mods: Mods): string {
  const kind = key.kind ?? "char";
  if (kind === "backspace") return "\x7f";
  if (kind === "enter") return "\r";

  let ch: string;
  if (kind === "space") {
    ch = " ";
  } else {
    // char
    ch = key.send ?? key.label;
    if (mods.shift) {
      if (key.shiftSend !== undefined) ch = key.shiftSend;
      else ch = ch.toUpperCase();
    }
  }

  let data = ch;
  if (mods.ctrl) {
    const upper = ch.length === 1 ? ch.toUpperCase() : ch;
    const code = upper.charCodeAt(0);
    // Ctrl maps @A-Z[\]^_ (0x40-0x5f) to their C0 control code (code & 0x1f).
    // Lowercase letters fold to the same code via the uppercase above.
    if (code >= 0x40 && code <= 0x5f) data = String.fromCharCode(code & 0x1f);
    // Other characters (digits, most symbols) have no Ctrl combination — sent
    // as-is, matching how a hardware keyboard's Ctrl+<digit> mostly no-ops.
  }
  if (mods.alt) {
    // Meta/Alt: ESC-prefix the resulting byte(s), the xterm convention tmux and
    // readline both decode.
    data = "\x1b" + data;
  }
  return data;
}
