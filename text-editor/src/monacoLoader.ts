// Lazily fetches the Monaco bundle the first time an editor tab actually
// mounts, so a session that only ever opens terminals never downloads it.
//
// The chunk is loaded by URL (ctx.assetUrl -> /api/extensions/<id>/file/…)
// rather than by a static import: esbuild leaves a dynamic import() with a
// non-literal specifier alone, which is exactly what makes dist/chunks/monaco.js
// a separate artifact instead of being inlined into client.js. Its stylesheet
// is injected here too, since nothing else in the eager bundle knows the chunk
// exists.
//
// Theming also goes through the chunk: the TextMate grammars and the Shiki
// tokenizer that colors them live there, so this module only forwards the
// host's theme data and never imports any of that weight itself.
import { injectStylesheet } from "./injectStylesheet";
import type { MonacoNs } from "./monacoNs";
import type { TokenColorRule } from "./shikiTheme";

export interface ThemeApi {
  getThemeColors(): Record<string, string>;
  getTokenColors(): TokenColorRule[];
}

interface MonacoChunk {
  monaco: MonacoNs;
  applyHostTheme(colors: Record<string, string>, tokenColors: TokenColorRule[]): Promise<void>;
}

let loadPromise: Promise<MonacoNs> | null = null;
let loaded: MonacoChunk | null = null;
let removeStylesheet: (() => void) | null = null;

/** The Monaco namespace if the chunk has finished loading, else null. */
export function getLoadedMonaco(): MonacoNs | null {
  return loaded?.monaco ?? null;
}

/**
 * Re-applies the host's current theme to an already-loaded editor. A no-op
 * before the first editor tab, where there is nothing to recolor yet.
 */
export function refreshTheme(themeApi: ThemeApi): void {
  void loaded?.applyHostTheme(themeApi.getThemeColors(), themeApi.getTokenColors());
}

// One-time setup for the language services backing the four workers. Semantic
// validation is off on purpose: a single open file has no module graph, so
// nearly every semantic error would be a false "cannot find module" — syntax
// errors, hovers, and completions are the parts that carry their weight here.
//
// `monaco.typescript`, not the historical `monaco.languages.typescript`: 0.56
// moved the four language-feature namespaces to the top level and left the old
// paths as deprecated stubs typed `{ deprecated: true }`.
function configureLanguageServices(monaco: MonacoNs): void {
  const ts = monaco.typescript;
  const compilerOptions = {
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.React,
    allowNonTsExtensions: true,
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  };
  ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions);
}

export function loadMonaco(assetUrl: (relPath: string) => string, themeApi: ThemeApi): Promise<MonacoNs> {
  if (!loadPromise) {
    loadPromise = (async () => {
      removeStylesheet = injectStylesheet(assetUrl, "dist/chunks/monaco.css");
      const chunkUrl = assetUrl("dist/chunks/monaco.js");
      const chunk = (await import(/* @vite-ignore */ chunkUrl)) as MonacoChunk;
      configureLanguageServices(chunk.monaco);
      // Grammars and theme must be in place before the first model is created,
      // or the first paint shows unhighlighted text.
      await chunk.applyHostTheme(themeApi.getThemeColors(), themeApi.getTokenColors());
      loaded = chunk;
      return chunk.monaco;
    })();
    // A failed fetch (offline, mid-deploy) shouldn't poison every later open.
    loadPromise.catch(() => {
      loadPromise = null;
      removeStylesheet?.();
      removeStylesheet = null;
    });
  }
  return loadPromise;
}

/** For deactivate(): drop the stylesheet and forget the loaded chunk. */
export function unloadMonaco(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  loadPromise = null;
  loaded = null;
}
