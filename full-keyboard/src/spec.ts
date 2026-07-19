// Send-token spec for the special-key top bar — ported from
// extensions/touch-keys/src/touchKeys.ts (full-keyboard keeps its own copy so
// touch-keys stays untouched; see plans/full-keyboard-extension.md). The QWERTY
// grid itself uses layout.ts/resolveSend, not this parser — this backs only the
// customizable top bar, which mirrors the Touch Keys bar's semantics.

export interface TouchKey {
  label: string;
  // Brace-token notation a phone user can type without an escape-code
  // reference — see parseSend below. A `send` of exactly "{ctrl}" is the
  // special sticky-Ctrl toggle, handled by the renderer before parseSend
  // ever sees it.
  send: string;
  // Comma-separated program names (matched case-insensitively, exact,
  // against pane_current_command) gating when this key shows. Empty = always.
  when: string;
}

// The default top bar: the Touch Keys defaults minus the {ctrl} key — the
// keyboard has its own sticky Ctrl key in its bottom row, so the bar doesn't
// need one. A user can add {ctrl} back via the editor; it then toggles the
// host's shared sticky-Ctrl exactly like the Touch Keys bar does.
export const DEFAULT_TOP_KEYS: TouchKey[] = [
  { label: "Esc", send: "{esc}", when: "" },
  { label: "Tab", send: "{tab}", when: "" },
  { label: "←", send: "{left}", when: "" },
  { label: "↑", send: "{up}", when: "" },
  { label: "↓", send: "{down}", when: "" },
  { label: "→", send: "{right}", when: "" },
  { label: "^C", send: "{^c}", when: "" },
  // Self-hides on browsers without SpeechRecognition (keyButtons.tsx's
  // visibleKeys) — safe to always include by default.
  { label: "🎤", send: "{mic}", when: "" },
  // Opens the native image picker and uploads through the same
  // pasteDropUploadDir pipeline paste/drop use. Gated to claude by default,
  // matching that feature's localEchoWhen gating.
  { label: "📷", send: "{image}", when: "claude" },
];

const SIMPLE_TOKENS: Record<string, string> = {
  esc: "\x1b",
  tab: "\t",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  home: "\x1b[H",
  end: "\x1b[F",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  space: " ",
};

export type ParsedSend = { data: string } | { error: string };

// Literal text passes through as-is; "{name}" tokens (from SIMPLE_TOKENS)
// and "{^x}" (Ctrl-x, e.g. "{^c}" -> "\x03") expand to their escape codes;
// "{{" escapes a literal "{". Tokens and literals concatenate freely, e.g.
// "{esc}:wq{enter}". Anything else inside braces is a parse error rather
// than sent verbatim, so a typo'd token name can't silently inject garbage.
export function parseSend(send: string): ParsedSend {
  let data = "";
  let i = 0;
  while (i < send.length) {
    const ch = send[i];
    if (ch !== "{") {
      data += ch;
      i++;
      continue;
    }
    if (send[i + 1] === "{") {
      data += "{";
      i += 2;
      continue;
    }
    const close = send.indexOf("}", i + 1);
    if (close === -1) {
      return { error: `unterminated token starting at "${send.slice(i)}"` };
    }
    const token = send.slice(i + 1, close);
    const lower = token.toLowerCase();
    if (lower in SIMPLE_TOKENS) {
      data += SIMPLE_TOKENS[lower];
    } else if (/^\^[a-zA-Z]$/.test(token)) {
      data += String.fromCharCode(token[1].toUpperCase().charCodeAt(0) - 64);
    } else {
      return { error: `unknown token "{${token}}"` };
    }
    i = close + 1;
  }
  return { data };
}
