// Bridges Shiki's real TextMate tokenization (textmate.ts) into CodeMirror
// decorations — replaces the old lezer-tag-to-CSS-class HighlightStyle with
// per-token inline colors resolved from the theme's actual tokenColors
// rules. Tokenization is async (Shiki's loadTheme/loadLanguage are), so
// decorations arrive via a StateEffect rather than being computed inline in
// EditorState.create; the field maps the previous decoration set through
// doc changes in the meantime so typing doesn't flash back to plain text.
import { EditorView, ViewPlugin, type ViewUpdate, Decoration, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { tokenizeDoc, type TokenColorRule } from "./textmate";

// vscode-textmate's FontStyle bit values (None=0, Italic=1, Bold=2,
// Underline=4, Strikethrough=8) — Shiki's ThemedToken.fontStyle is an
// OR-mask of these, not re-exported as a named enum from @shikijs/core.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

function styleFor(fontStyle: number | undefined): string {
  if (!fontStyle) return "";
  const parts: string[] = [];
  if (fontStyle & FONT_STYLE_ITALIC) parts.push("font-style:italic");
  if (fontStyle & FONT_STYLE_BOLD) parts.push("font-weight:bold");
  const lines: string[] = [];
  if (fontStyle & FONT_STYLE_UNDERLINE) lines.push("underline");
  if (fontStyle & FONT_STYLE_STRIKETHROUGH) lines.push("line-through");
  if (lines.length) parts.push(`text-decoration:${lines.join(" ")}`);
  return parts.join(";");
}

// VS Code's default "Bracket Pair Colorization" (on by default since 1.60,
// editor.bracketPairColorization.enabled) — a real editor feature, not a
// theme's tokenColors: each nesting level of (), {}, [] cycles through a
// small palette (editorBracketHighlight.foreground1/2/3 in VS Code's own
// source), regardless of bracket kind, overriding the base punctuation
// color from tokenColors for just that character.
//
// Bracket *positions* come from the language's own lezer parse tree, not
// from scanning Shiki's token stream: Shiki merges adjacent tokens that
// resolve to the identical color into one chunk (a real, observed behavior
// — e.g. ") { " often collapses into a single 4-character token when a
// theme's punctuation and whitespace happen to share a color), so a
// "single-character token" test silently misses most brackets. The lezer
// tree has no such merging — every bracket is always its own leaf node —
// and it already correctly excludes brackets inside strings/comments/regex
// (those never appear as bracket-named leaf nodes).
//
// Both this and the base per-token color come out of ONE decoration pass
// (buildRanges below) rather than two separate decoration-contributing
// extensions: two Decoration.mark ranges covering the identical character
// nest as ancestor/descendant spans, and CSS only lets the *descendant*
// win — which of the two ends up as descendant isn't something either
// extension controls on its own. A single pass that already knows which
// characters are brackets never creates the competing decoration in the
// first place.
const DARK_BRACKET_PALETTE = ["#FFD700", "#DA70D6", "#179FFF"];
const LIGHT_BRACKET_PALETTE = ["#0431FA", "#319331", "#7B3814"];
const OPEN_BRACKETS: Record<string, true> = { "(": true, "{": true, "[": true };
const CLOSE_BRACKETS: Record<string, true> = { ")": true, "}": true, "]": true };

function isLightBackground(editorBackground: string | undefined): boolean {
  if (!editorBackground) return false;
  const hex = editorBackground.replace("#", "");
  if (hex.length < 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

// Position -> bracket color, for every real bracket character in the
// document, keyed by its 0-based offset. Built once per retokenize from the
// lezer tree (cheap — a single linear walk) and consulted while splitting
// Shiki's token spans below.
function bracketColorsByPosition(view: EditorView, palette: string[]): Map<number, string> {
  const result = new Map<number, string>();
  const stack: number[] = [];
  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.to - node.from !== 1) return;
      const text = view.state.doc.sliceString(node.from, node.to);
      const isOpen = OPEN_BRACKETS[text];
      const isClose = CLOSE_BRACKETS[text];
      if (!isOpen && !isClose) return;
      const depth = isOpen ? stack.length : Math.max(0, stack.length - 1);
      if (isOpen) stack.push(depth);
      else stack.pop();
      result.set(node.from, palette[depth % palette.length]);
    },
  });
  return result;
}

const setTMDecorations = StateEffect.define<DecorationSet>();

const tmDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setTMDecorations)) return effect.value;
    }
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Doc changes coalesce for this long before retokenizing — same
// settle-timing spirit as this codebase's SEND_TEXT_SETTLE_MS, just for
// "don't retokenize on every keystroke" rather than a tmux round-trip.
const RETOKENIZE_DEBOUNCE_MS = 200;

interface TMHighlightOptions {
  getLangId: () => string | null;
  getTheme: () => { colors: Record<string, string>; tokenColors: TokenColorRule[] };
  subscribeThemeChange: (cb: () => void) => () => void;
}

export function tmHighlight(opts: TMHighlightOptions): Extension {
  const plugin = ViewPlugin.define((view) => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;

    async function retokenize() {
      const langId = opts.getLangId();
      if (!langId) {
        view.dispatch({ effects: setTMDecorations.of(Decoration.none) });
        return;
      }
      const myGeneration = ++generation;
      const { colors, tokenColors } = opts.getTheme();
      const code = view.state.doc.toString();
      const lines = await tokenizeDoc(code, langId, colors, tokenColors);
      if (myGeneration !== generation) return; // superseded by a newer retokenize

      const palette = isLightBackground(colors["editor.background"]) ? LIGHT_BRACKET_PALETTE : DARK_BRACKET_PALETTE;
      const bracketColors = bracketColorsByPosition(view, palette);

      const ranges = [];
      const docLineCount = view.state.doc.lines;
      for (let i = 0; i < lines.length && i < docLineCount; i++) {
        const lineStart = view.state.doc.line(i + 1).from;
        let pos = lineStart;
        for (const token of lines[i]) {
          const len = token.content.length;
          if (len === 0) continue;
          const tokenStyle = token.color ? `color:${token.color};${styleFor(token.fontStyle)}` : null;

          // Fast path: no bracket falls inside this token's span — emit it
          // as one decoration, same as before splitting existed.
          let hasBracket = false;
          for (let p = pos; p < pos + len; p++) {
            if (bracketColors.has(p)) {
              hasBracket = true;
              break;
            }
          }
          if (!hasBracket) {
            if (tokenStyle) ranges.push(Decoration.mark({ attributes: { style: tokenStyle } }).range(pos, pos + len));
            pos += len;
            continue;
          }

          // Slow path: walk character-by-character, coalescing consecutive
          // non-bracket characters into one run so a token merely adjacent
          // to a bracket doesn't turn into one decoration per character.
          let runStart = pos;
          for (let p = pos; p < pos + len; p++) {
            const bracketColor = bracketColors.get(p);
            if (bracketColor === undefined) continue;
            if (runStart < p && tokenStyle) ranges.push(Decoration.mark({ attributes: { style: tokenStyle } }).range(runStart, p));
            ranges.push(Decoration.mark({ attributes: { style: `color:${bracketColor}` } }).range(p, p + 1));
            runStart = p + 1;
          }
          if (runStart < pos + len && tokenStyle) {
            ranges.push(Decoration.mark({ attributes: { style: tokenStyle } }).range(runStart, pos + len));
          }
          pos += len;
        }
      }
      view.dispatch({ effects: setTMDecorations.of(Decoration.set(ranges, true)) });
    }

    const unsubscribeTheme = opts.subscribeThemeChange(() => scheduleRetokenize());

    function scheduleRetokenize() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void retokenize();
      }, RETOKENIZE_DEBOUNCE_MS);
    }

    void retokenize(); // first paint: no debounce, nothing to coalesce yet

    return {
      update(update: ViewUpdate) {
        if (update.docChanged) scheduleRetokenize();
      },
      destroy() {
        if (debounceTimer) clearTimeout(debounceTimer);
        unsubscribeTheme();
      },
    };
  });

  return [tmDecorationField, plugin];
}
