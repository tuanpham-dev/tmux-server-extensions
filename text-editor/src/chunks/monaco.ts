// The lazy Monaco bundle: everything heavy lives here, behind a runtime
// import() from monacoLoader.ts, so opening a terminal tab never pays for the
// editor. scripts/build.mjs emits this as dist/chunks/monaco.js (+ monaco.css
// and codicon.ttf beside it, from Monaco's own CSS imports), served through the
// host's /api/extensions/<id>/file/* route via ctx.assetUrl.
//
// The whole `monaco-editor` package is imported on purpose rather than a
// curated editor.api + contrib list: a missing contrib is a silent feature loss
// (find widget, folding, suggest), and it registers the language ids the
// TextMate grammars below attach to.
import * as monaco from "monaco-editor";
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { applyHostTheme as applyShikiTheme, type TokenColorRule } from "../shikiTheme";
import { registerToml } from "../toml";

import tsxGrammar from "@shikijs/langs/tsx";
import javascriptGrammar from "@shikijs/langs/javascript";
import jsonGrammar from "@shikijs/langs/json";
import cssGrammar from "@shikijs/langs/css";
import scssGrammar from "@shikijs/langs/scss";
import lessGrammar from "@shikijs/langs/less";
import htmlGrammar from "@shikijs/langs/html";
import markdownGrammar from "@shikijs/langs/markdown";
import pythonGrammar from "@shikijs/langs/python";
import goGrammar from "@shikijs/langs/go";
import rustGrammar from "@shikijs/langs/rust";
import shellGrammar from "@shikijs/langs/shellscript";
import yamlGrammar from "@shikijs/langs/yaml";
import tomlGrammar from "@shikijs/langs/toml";

// @shikijs/monaco attaches a grammar to the Monaco language whose id equals the
// Shiki language name, so a couple of grammars are re-labelled to Monaco's id.
function renameTo(grammars: LanguageRegistration[], scopeName: string, name: string): LanguageRegistration[] {
  return grammars.map((g) => (g.scopeName === scopeName ? { ...g, name, aliases: undefined } : g));
}

// VS Code splits TypeScript across two languages — `typescript` (source.ts, for
// .ts/.mts/.cts) and `typescriptreact` (source.tsx, for .tsx) — but Monaco has
// only `typescript`, and its TypeScript worker is hard-wired to that id, so a
// separate `typescriptreact` language would highlight .tsx correctly at the
// cost of all IntelliSense there. source.tsx is a superset of source.ts, so
// using it for both keeps completions everywhere and matches VS Code on every
// construct except the old angle-bracket type assertion (`<Foo>x`), which the
// React grammar necessarily reads as a JSX tag. `as` casts are unaffected.
//
// JavaScript needs no such trick: VS Code's own source.js already carries the
// JSX rules (it is generated from the React grammar), so .js and .jsx are both
// exactly what VS Code shows.
const GRAMMARS: LanguageRegistration[] = [
  ...renameTo(tsxGrammar, "source.tsx", "typescript"),
  ...javascriptGrammar,
  ...jsonGrammar,
  ...cssGrammar,
  ...scssGrammar,
  ...lessGrammar,
  ...htmlGrammar,
  ...markdownGrammar,
  ...pythonGrammar,
  ...goGrammar,
  ...rustGrammar,
  ...renameTo(shellGrammar, "source.shell", "shell"),
  ...yamlGrammar,
  ...tomlGrammar,
];

// html/scss pull in embedded copies of grammars loaded standalone above
// (source.js, source.css); registering one scopeName twice is wasted work at
// best, so keep the first of each.
function dedupe(grammars: LanguageRegistration[]): LanguageRegistration[] {
  const seen = new Set<string>();
  return grammars.filter((g) => (seen.has(g.scopeName) ? false : (seen.add(g.scopeName), true)));
}

registerToml(monaco);

let highlighter: HighlighterCore | null = null;

export async function applyHostTheme(colors: Record<string, string>, tokenColors: TokenColorRule[]): Promise<void> {
  if (!highlighter) {
    highlighter = await createHighlighterCore({
      langs: dedupe(GRAMMARS),
      themes: [],
      // The JavaScript regex engine, not Oniguruma: it needs no .wasm asset to
      // serve, and it handles the grammars bundled here. `forgiving` keeps a
      // single unsupported pattern from taking down the whole editor — that
      // rule is skipped instead, which costs a little color, never the file.
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  await applyShikiTheme(monaco, highlighter, colors, tokenColors);
}

export { monaco };
