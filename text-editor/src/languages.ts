// Languages this extension adds to Monaco.
//
// Monaco ships 81 language definitions, but its list and Shiki's grammar list
// don't line up: some languages Monaco knows have no id we can attach a
// TextMate grammar to under the same name, and several everyday formats
// (TOML, Vue, Zig, CMake…) Monaco doesn't know at all — a file of that type
// resolves to plain text and renders unstyled.
//
// Each entry here registers the language with Monaco when it isn't already
// there, so `chunks/monaco.ts` can then attach the matching Shiki grammar by
// name. Only the id and extensions are strictly needed; the small
// comment/bracket config is what makes "toggle comment" and auto-closing
// behave, and costs a couple of lines.
import type { MonacoNs } from "./monacoNs";

interface LanguageSpec {
  id: string;
  extensions: string[];
  aliases?: string[];
  filenames?: string[];
  lineComment?: string;
  blockComment?: [string, string];
}

// Deliberately not exhaustive: these are the formats worth carrying in a
// bundle, not every grammar Shiki ships. Anything outside this list and
// Monaco's own set still opens and saves — it just falls back to Monaco's
// Monarch tokenizer, or to plain text.
export const EXTRA_LANGUAGES: LanguageSpec[] = [
  { id: "toml", extensions: [".toml"], aliases: ["TOML"], lineComment: "#" },
  { id: "vue", extensions: [".vue"], aliases: ["Vue"], blockComment: ["<!--", "-->"] },
  { id: "zig", extensions: [".zig"], aliases: ["Zig"], lineComment: "//" },
  { id: "haskell", extensions: [".hs", ".lhs"], aliases: ["Haskell"], lineComment: "--", blockComment: ["{-", "-}"] },
  { id: "erlang", extensions: [".erl", ".hrl"], aliases: ["Erlang"], lineComment: "%" },
  { id: "groovy", extensions: [".groovy", ".gvy", ".gradle"], aliases: ["Groovy"], lineComment: "//", blockComment: ["/*", "*/"] },
  { id: "cmake", extensions: [".cmake"], filenames: ["CMakeLists.txt"], aliases: ["CMake"], lineComment: "#" },
  { id: "make", extensions: [".mk", ".mak"], filenames: ["Makefile", "makefile", "GNUmakefile"], aliases: ["Makefile"], lineComment: "#" },
  { id: "viml", extensions: [".vim", ".vimrc"], aliases: ["Vim Script"], lineComment: '"' },
  { id: "latex", extensions: [".tex", ".sty", ".cls"], aliases: ["LaTeX"], lineComment: "%" },
  { id: "diff", extensions: [".diff", ".patch"], aliases: ["Diff"] },
  { id: "jsonc", extensions: [".jsonc"], aliases: ["JSON with Comments"], lineComment: "//", blockComment: ["/*", "*/"] },
  { id: "nginx", extensions: [".nginx", ".nginxconf"], filenames: ["nginx.conf"], aliases: ["Nginx"], lineComment: "#" },
  { id: "apache", extensions: [".conf", ".htaccess"], aliases: ["Apache"], lineComment: "#" },
  { id: "prisma", extensions: [".prisma"], aliases: ["Prisma"], lineComment: "//" },
  { id: "c", extensions: [".c", ".h"], aliases: ["C"], lineComment: "//", blockComment: ["/*", "*/"] },
];

/**
 * Registers every language above that Monaco doesn't already define. Skipping
 * the ones it knows matters: re-registering an existing id would replace its
 * configuration (and its own extension associations) with this thinner one.
 */
export function registerExtraLanguages(monaco: MonacoNs): void {
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  for (const spec of EXTRA_LANGUAGES) {
    if (known.has(spec.id)) continue;
    monaco.languages.register({
      id: spec.id,
      extensions: spec.extensions,
      aliases: spec.aliases ?? [spec.id],
      filenames: spec.filenames,
    });
    monaco.languages.setLanguageConfiguration(spec.id, {
      ...(spec.lineComment || spec.blockComment
        ? {
            comments: {
              ...(spec.lineComment ? { lineComment: spec.lineComment } : {}),
              ...(spec.blockComment ? { blockComment: spec.blockComment } : {}),
            },
          }
        : {}),
      brackets: [
        ["{", "}"],
        ["[", "]"],
        ["(", ")"],
      ],
      autoClosingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: '"', close: '"', notIn: ["string"] },
        { open: "'", close: "'", notIn: ["string"] },
      ],
      surroundingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
      ],
    });
  }
}
