// Real TextMate tokenization (Shiki, on the JS regex engine — no WASM asset
// to serve, and this build's esbuild has no code-splitting so a dynamic
// import() would get inlined synchronously anyway; see the module comment in
// client.tsx). Grammars are statically imported so bundling stays as
// predictable as the rest of this extension's language support.
import { createHighlighterCore, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import typescriptLang from "@shikijs/langs/typescript";
import tsxLang from "@shikijs/langs/tsx";
import javascriptLang from "@shikijs/langs/javascript";
import cssLang from "@shikijs/langs/css";
import htmlLang from "@shikijs/langs/html";
import markdownLang from "@shikijs/langs/markdown";
import pythonLang from "@shikijs/langs/python";

// Mirrors client/src/theme.ts's TokenColorRule (the main repo) — this
// extension can't import across repos, so this is the informal contract
// with ctx.app.getTokenColors()'s return shape.
export interface TokenColorRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

export interface ThemedToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      langs: [...typescriptLang, ...tsxLang, ...javascriptLang, ...cssLang, ...htmlLang, ...markdownLang, ...pythonLang],
      themes: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

// Shiki has no "replace a registered theme in place" call, so a theme
// switch registers under a fresh name instead of trying to mutate/reload an
// existing one — cheap (a theme registration is just an object) and avoids
// depending on undocumented overwrite behavior. Cached by the (colors,
// tokenColors) *reference* pair, matching ctx.app.getThemeColors()/
// getTokenColors()'s "same reference until the theme actually changes"
// contract, so a re-render doesn't re-register on every call.
let themeNameSeq = 0;
let cachedColors: Record<string, string> | null = null;
let cachedTokenColors: TokenColorRule[] | null = null;
let cachedThemeName: string | null = null;

async function themeNameFor(highlighter: HighlighterCore, colors: Record<string, string>, tokenColors: TokenColorRule[]) {
  if (cachedColors === colors && cachedTokenColors === tokenColors && cachedThemeName) return cachedThemeName;
  const name = `active-${themeNameSeq++}`;
  const settings = tokenColors.map((rule) => ({ scope: rule.scope, settings: rule.settings ?? {} }));
  await highlighter.loadTheme({ name, type: "dark", colors, settings });
  cachedColors = colors;
  cachedTokenColors = tokenColors;
  cachedThemeName = name;
  return name;
}

export async function tokenizeDoc(
  code: string,
  langId: string,
  colors: Record<string, string>,
  tokenColors: TokenColorRule[],
): Promise<ThemedToken[][]> {
  const highlighter = await getHighlighter();
  if (!highlighter.getLoadedLanguages().includes(langId)) {
    return code.split("\n").map((line) => [{ content: line }]);
  }
  const theme = await themeNameFor(highlighter, colors, tokenColors);
  return highlighter.codeToTokensBase(code, { lang: langId, theme });
}
