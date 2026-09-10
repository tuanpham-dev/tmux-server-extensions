// Real TextMate highlighting, so colors match VS Code / code-server rather
// than approximating them.
//
// Monaco's own Monarch tokenizers emit a coarse token vocabulary (`const` and
// `return` are both plain `keyword`, a call and a declaration share one token),
// so no amount of scope mapping reproduces what VS Code shows. VS Code
// tokenizes with TextMate grammars and colors the resulting *scopes* with the
// theme's `tokenColors`. This module does the same: Shiki carries the very
// grammars code-server ships (verified against
// /usr/lib/code-server/lib/vscode/extensions — same scopeNames, same
// repository keys), and the bridge below feeds its tokenizer into Monaco.
//
// Everything here is imported only by chunks/monaco.ts, so Shiki and its
// grammars stay inside the lazily fetched bundle.
//
// ---------------------------------------------------------------------------
// Why this doesn't use @shikijs/monaco
//
// That package makes the round trip *token -> color -> scope name*: it builds a
// (color, fontStyle) -> scope lookup from the theme's rules, and each tokenized
// span is labelled with whatever scope has that exact pair, leaving Monaco to
// resolve the scope back to a color. Any (color, fontStyle) combination that no
// single theme rule produces falls through to the default foreground.
//
// Real themes hit that constantly, because a scope's color and its font style
// routinely come from *different* rules. Plastic Legacy is a plain example:
//
//     { "scope": ["comment", "punctuation.definition.comment"], "foreground": "#5F6672" }
//     { "scope": ["comment", "markup.italic", ...],             "fontStyle": "italic" }
//
// A comment resolves to (#5F6672, italic) — a pair no rule declares — so every
// comment rendered in the editor's default foreground, upright, while VS Code
// showed dim italic grey.
//
// The bridge here keeps the resolved value instead of trying to name it. The
// tokenizer already hands back a *resolved* foreground index and font-style
// mask per span; those two numbers become the Monaco token name, and the Monaco
// theme carries one rule per (color, style) combination. Nothing is inferred, so
// nothing can be lost.
import { EncodedTokenMetadata, INITIAL, type IGrammar, type StateStack } from "@shikijs/vscode-textmate";
import type { HighlighterCore } from "@shikijs/core";
import type { MonacoNs, TokenizerState } from "./monacoNs";

// Mirrors client/src/theme.ts's TokenColorRule in the host repo — the informal
// contract with ctx.app.getTokenColors()'s return shape.
export interface TokenColorRule {
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// vscode-textmate packs font style as a bitmask (Italic 1, Bold 2, Underline 4,
// Strikethrough 8), so 16 combinations exist per color.
const FONT_STYLE_COMBINATIONS = 16;
const FONT_STYLE_NAMES: Array<[number, string]> = [
  [1, "italic"],
  [2, "bold"],
  [4, "underline"],
  [8, "strikethrough"],
];

// Lines longer than this are handed back as a single unstyled token rather than
// tokenized — the same guard VS Code applies, so one minified file can't lock
// the editor up.
const MAX_TOKENIZE_LINE_LENGTH = 20000;
const TOKENIZE_TIME_LIMIT_MS = 500;

/** Monaco token name for a resolved (foreground index, font style mask) pair. */
function tokenName(foreground: number, fontStyle: number): string {
  return `tm${foreground}s${fontStyle}`;
}

function fontStyleString(mask: number): string | undefined {
  const parts = FONT_STYLE_NAMES.filter(([bit]) => mask & bit).map(([, name]) => name);
  return parts.length ? parts.join(" ") : undefined;
}

// Perceived brightness of the editor background, which decides whether the
// theme registers as light or dark — Shiki needs `type`, and Monaco derives its
// base theme from it.
export function isLightBackground(editorBackground: string | undefined): boolean {
  if (!editorBackground) return false;
  const hex = editorBackground.replace("#", "");
  if (hex.length < 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

function filterColors(colors: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors ?? {})) {
    if (typeof value === "string" && HEX_COLOR.test(value)) safe[key] = value;
  }
  return safe;
}

// The host hands us VS Code's own theme data, which is already the shape a
// TextMate theme takes — so this is a pass-through with hygiene, not a
// translation.
function buildShikiTheme(name: string, colors: Record<string, string>, tokenColors: TokenColorRule[]) {
  const safeColors = filterColors(colors);
  const settings = (tokenColors ?? [])
    .filter((rule) => rule.settings && (rule.settings.foreground || rule.settings.background || rule.settings.fontStyle))
    .map((rule) => ({ scope: rule.scope, settings: rule.settings! }));
  return {
    name,
    type: isLightBackground(safeColors["editor.background"]) ? ("light" as const) : ("dark" as const),
    colors: safeColors,
    // Shiki derives the default foreground/background from these when the
    // theme has no scope-less default rule, which VS Code themes usually don't.
    fg: safeColors["editor.foreground"],
    bg: safeColors["editor.background"],
    settings,
  };
}

class TextMateState implements TokenizerState {
  constructor(readonly ruleStack: StateStack) {}
  clone(): TextMateState {
    return new TextMateState(this.ruleStack);
  }
  equals(other: TokenizerState): boolean {
    return other instanceof TextMateState && other.ruleStack === this.ruleStack;
  }
}

// Registered once; a later theme change only redefines colors, and Monaco
// re-tokenizes every model itself when the theme changes.
let providersRegistered = false;

function registerTokenProviders(monaco: MonacoNs, highlighter: HighlighterCore): void {
  if (providersRegistered) return;
  providersRegistered = true;

  const monacoLanguages = new Set(monaco.languages.getLanguages().map((l) => l.id));
  for (const language of highlighter.getLoadedLanguages()) {
    if (!monacoLanguages.has(language)) continue;
    monaco.languages.setTokensProvider(language, {
      getInitialState: () => new TextMateState(INITIAL),
      tokenize(line: string, state: TextMateState) {
        if (line.length >= MAX_TOKENIZE_LINE_LENGTH) {
          return { endState: state, tokens: [{ startIndex: 0, scopes: "" }] };
        }
        const grammar = highlighter.getLanguage(language) as unknown as IGrammar;
        const result = grammar.tokenizeLine2(line, state.ruleStack, TOKENIZE_TIME_LIMIT_MS);
        const tokens = [];
        for (let i = 0; i < result.tokens.length / 2; i++) {
          const startIndex = result.tokens[2 * i];
          const metadata = result.tokens[2 * i + 1];
          const foreground = EncodedTokenMetadata.getForeground(metadata);
          const fontStyle = Math.max(0, EncodedTokenMetadata.getFontStyle(metadata)) % FONT_STYLE_COMBINATIONS;
          tokens.push({ startIndex, scopes: tokenName(foreground, fontStyle) });
        }
        return { tokens, endState: new TextMateState(result.ruleStack) };
      },
    });
  }
}

// Shiki has no "replace a registered theme in place" call, so each host theme
// change registers under a fresh name (a theme registration is a small object).
let themeSeq = 0;

export async function applyHostTheme(
  monaco: MonacoNs,
  highlighter: HighlighterCore,
  colors: Record<string, string>,
  tokenColors: TokenColorRule[],
): Promise<void> {
  const name = `tmux-server-active-${themeSeq++}`;
  const safeColors = filterColors(colors);
  await highlighter.loadTheme(buildShikiTheme(name, colors, tokenColors));

  // Selecting the theme in Shiki resolves it to a color palette; index into
  // that palette is exactly what the tokenizer reports per span.
  const { colorMap } = highlighter.setTheme(name);

  const rules: Array<{ token: string; foreground?: string; fontStyle?: string }> = [];
  for (let index = 0; index < colorMap.length; index++) {
    const color = colorMap[index];
    if (!color || !HEX_COLOR.test(color)) continue;
    const foreground = color.replace("#", "");
    for (let style = 0; style < FONT_STYLE_COMBINATIONS; style++) {
      const fontStyle = fontStyleString(style);
      rules.push({ token: tokenName(index, style), foreground, ...(fontStyle ? { fontStyle } : {}) });
    }
  }

  monaco.editor.defineTheme(name, {
    base: isLightBackground(safeColors["editor.background"]) ? "vs" : "vs-dark",
    // Every token name here is generated, so there is nothing for a base theme
    // to usefully contribute — and inheriting would let its rules win for spans
    // this theme deliberately leaves at the default foreground.
    inherit: false,
    colors: safeColors,
    rules,
  });
  monaco.editor.setTheme(name);

  registerTokenProviders(monaco, highlighter);
}
