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
import { registerExtraLanguages } from "../languages";

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
// Everyday languages beyond the core set above. Each costs its grammar's size
// in this chunk (the whole block below is about 1.6MB) and buys VS Code-exact
// colors for that file type instead of Monaco's coarser Monarch tokens.
import javaGrammar from "@shikijs/langs/java";
import cGrammar from "@shikijs/langs/c";
import cppGrammar from "@shikijs/langs/cpp";
import csharpGrammar from "@shikijs/langs/csharp";
import phpGrammar from "@shikijs/langs/php";
import rubyGrammar from "@shikijs/langs/ruby";
import sqlGrammar from "@shikijs/langs/sql";
import xmlGrammar from "@shikijs/langs/xml";
import dockerGrammar from "@shikijs/langs/docker";
import luaGrammar from "@shikijs/langs/lua";
import swiftGrammar from "@shikijs/langs/swift";
import kotlinGrammar from "@shikijs/langs/kotlin";
import perlGrammar from "@shikijs/langs/perl";
import graphqlGrammar from "@shikijs/langs/graphql";
import vueGrammar from "@shikijs/langs/vue";
import powershellGrammar from "@shikijs/langs/powershell";
import makeGrammar from "@shikijs/langs/make";
import hclGrammar from "@shikijs/langs/hcl";
import protoGrammar from "@shikijs/langs/proto";
import zigGrammar from "@shikijs/langs/zig";
import elixirGrammar from "@shikijs/langs/elixir";
import haskellGrammar from "@shikijs/langs/haskell";
import clojureGrammar from "@shikijs/langs/clojure";
import scalaGrammar from "@shikijs/langs/scala";
import dartGrammar from "@shikijs/langs/dart";
import objcGrammar from "@shikijs/langs/objective-c";
import juliaGrammar from "@shikijs/langs/julia";
import groovyGrammar from "@shikijs/langs/groovy";
import cmakeGrammar from "@shikijs/langs/cmake";
import vimGrammar from "@shikijs/langs/viml";
import latexGrammar from "@shikijs/langs/latex";
import diffGrammar from "@shikijs/langs/diff";
import iniGrammar from "@shikijs/langs/ini";
import jsoncGrammar from "@shikijs/langs/jsonc";
import handlebarsGrammar from "@shikijs/langs/handlebars";
import nginxGrammar from "@shikijs/langs/nginx";
import apacheGrammar from "@shikijs/langs/apache";
import prismaGrammar from "@shikijs/langs/prisma";
import solidityGrammar from "@shikijs/langs/solidity";
import erlangGrammar from "@shikijs/langs/erlang";
import liquidGrammar from "@shikijs/langs/liquid";

// A grammar is attached to the Monaco language whose id equals its Shiki name
// (see shikiTheme.ts's registerTokenProviders), and the two vocabularies don't
// always agree — Shiki's `shellscript` is Monaco's `shell`, its `docker` is
// Monaco's `dockerfile`.
//
// The Monaco id goes on as an *alias* rather than replacing the name. Grammars
// reference each other by name for embedded languages (graphql embeds tsx,
// ruby embeds shellscript), so renaming one breaks every grammar that includes
// it. Shiki resolves aliases everywhere it resolves names, and reports them
// from getLoadedLanguages(), so an alias is enough.
function aliasTo(grammars: LanguageRegistration[], scopeName: string, alias: string): LanguageRegistration[] {
  return grammars.map((g) =>
    g.scopeName === scopeName ? { ...g, aliases: [...new Set([...(g.aliases ?? []), alias])] } : g,
  );
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
  ...aliasTo(tsxGrammar, "source.tsx", "typescript"),
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
  ...aliasTo(shellGrammar, "source.shell", "shell"),
  ...yamlGrammar,
  ...tomlGrammar,
  // Shiki's own name matches Monaco's language id for most of these; the few
  // that differ are renamed so @shikijs-style attachment finds them.
  ...javaGrammar,
  ...cGrammar,
  ...cppGrammar,
  ...csharpGrammar,
  ...phpGrammar,
  ...rubyGrammar,
  ...sqlGrammar,
  ...xmlGrammar,
  ...aliasTo(dockerGrammar, "source.dockerfile", "dockerfile"),
  ...luaGrammar,
  ...swiftGrammar,
  ...kotlinGrammar,
  ...perlGrammar,
  ...graphqlGrammar,
  ...vueGrammar,
  ...powershellGrammar,
  ...makeGrammar,
  ...hclGrammar,
  ...aliasTo(protoGrammar, "source.proto", "protobuf"),
  ...zigGrammar,
  ...elixirGrammar,
  ...haskellGrammar,
  ...clojureGrammar,
  ...scalaGrammar,
  ...dartGrammar,
  ...objcGrammar,
  ...juliaGrammar,
  ...groovyGrammar,
  ...cmakeGrammar,
  ...vimGrammar,
  ...latexGrammar,
  ...diffGrammar,
  ...iniGrammar,
  ...jsoncGrammar,
  ...handlebarsGrammar,
  ...nginxGrammar,
  ...apacheGrammar,
  ...prismaGrammar,
  ...solidityGrammar,
  ...erlangGrammar,
  // Shopify templates. The grammar embeds html/css/js/json, which are already
  // loaded above — dedupe keeps one copy of each, and Liquid resolves them by
  // scope name either way.
  ...liquidGrammar,
];

// html/scss pull in embedded copies of grammars loaded standalone above
// (source.js, source.css); registering one scopeName twice is wasted work at
// best, so keep the first of each.
function dedupe(grammars: LanguageRegistration[]): LanguageRegistration[] {
  const seen = new Set<string>();
  return grammars.filter((g) => (seen.has(g.scopeName) ? false : (seen.add(g.scopeName), true)));
}

registerExtraLanguages(monaco);

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
