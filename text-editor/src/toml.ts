// Registers TOML as a Monaco language, because Monaco ships none and
// @shikijs/monaco can only attach a grammar to a language Monaco already
// knows. Tokenization itself comes from Shiki's source.toml TextMate grammar
// (see chunks/monaco.ts) — the same one VS Code uses — so all this contributes
// is the language id, its file extension, and the bracket/comment behavior the
// editor needs for auto-closing and toggling comments.
import type { MonacoNs } from "./monacoNs";

export function registerToml(monaco: MonacoNs): void {
  monaco.languages.register({
    id: "toml",
    extensions: [".toml"],
    aliases: ["TOML", "toml"],
    mimetypes: ["text/x-toml", "application/toml"],
  });

  monaco.languages.setLanguageConfiguration("toml", {
    comments: { lineComment: "#" },
    brackets: [
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

}
