# Text Editor

A **Monaco**-based editor tab — the editor VS Code itself is built on — with syntax
highlighting, IntelliSense, and save-back to disk, for a quick edit without a round-trip
through nvim. Registers as a **preview** viewer by default: a FILES-tree click still opens
nvim as usual; this is reached via the hover Preview icon, the "Preview" context-menu item,
or Shift+Enter.

You get the editor you already know: find and replace, multi-cursor, code folding,
bracket-pair colorization, go-to-definition within the file, and the command palette
(F1) — all of Monaco's own keybindings, except the few the app claims first
(`Ctrl+P`, `Ctrl+Shift+P`, `Ctrl+W`).

## Loading

Monaco is **lazy-loaded**. Having this extension enabled costs ~20 KB up front; the
editor bundle (~5.2 MB, grammars included) is fetched the first time you actually open an editor tab, and each
language-service worker only when a file of that kind is opened. Nothing is downloaded in a
session where you only use terminals.

| Artifact | Size | Fetched |
|---|---:|---|
| `dist/client.js` | 19 KB | at activation |
| `dist/chunks/monaco.js` | 5.2 MB | first editor tab |
| `dist/chunks/monaco.css` + `codicon.ttf` | 291 KB | first editor tab |
| `dist/workers/editor.worker.js` | 297 KB | first editor tab |
| `dist/workers/ts.worker.js` | 6.7 MB | first TS/JS file |
| `dist/workers/css.worker.js` | 1.0 MB | first CSS/SCSS/Less file |
| `dist/workers/html.worker.js` | 735 KB | first HTML file |
| `dist/workers/json.worker.js` | 424 KB | first JSON file |

## Syntax highlighting

Colors match VS Code / code-server, because the same machinery produces them:
real **TextMate grammars**, tokenized per scope, colored by the active theme's own
`tokenColors`. Shiki carries the grammars — the very files code-server ships, verified
against `/usr/lib/code-server/lib/vscode/extensions` (same `scopeName`s, same repository
keys) — and `src/shikiTheme.ts` feeds its tokenizer into Monaco.

That bridge is written here rather than taken from `@shikijs/monaco`, which cannot represent
a token whose color and font style come from different theme rules. It labels each span with
the scope whose `(color, fontStyle)` pair matches, so a combination no single rule declares
falls back to the default foreground — and themes produce those constantly. Plastic Legacy is
a plain case: one rule gives `comment` its color, a second gives it italics, and every comment
rendered in the plain text color, upright. The bridge here keeps the *resolved* value instead
of trying to name it — the tokenizer's foreground index and font-style mask become the Monaco
token name, and the theme carries one rule per combination. Nothing is inferred, so nothing is
lost.

This was checked, not assumed. The same file was opened in this editor and in code-server
4.125.0 under the same theme, and every rendered span's computed color, font style and weight
compared:

| Theme | Spans compared | Mismatches |
|---|---:|---:|
| Dark Modern | 49 | 0 |
| Plastic Legacy | 23 | 0 |

across TypeScript, Python, Go, Rust and Shell. The only rendering differences are span
boundaries where Monaco's bracket-pair colorization splits a bracket out of a larger token.

Theme changes recolor in place, with no reload.

### What this depends on

A theme can only color what it declares. The bundled **Plastic Legacy** theme defines just
11 `tokenColors` rules, so syntax under it is deliberately sparse — that is the theme's own
data, not a limit of the editor. For full VS Code fidelity, install a theme with a complete
rule set:

| Theme | `tokenColors` rules |
|---|---:|
| One Dark Pro | ~275 |
| Dark Modern / Light Modern | 65 / 64 |
| Plastic Legacy (bundled default) | 11 |

### Known differences from VS Code

- **Angle-bracket type assertions in `.ts`.** VS Code splits TypeScript into two languages,
  `typescript` (`source.ts`) and `typescriptreact` (`source.tsx`), but Monaco has only
  `typescript` and binds its TypeScript worker to that id. Using `source.tsx` for both keeps
  IntelliSense in `.tsx` files; the cost is that the old `<Foo>x` assertion syntax reads as a
  JSX tag. `as` casts are unaffected. JavaScript needs no such trade: VS Code's own
  `source.js` already carries the JSX rules.
- **No semantic highlighting.** VS Code layers the TypeScript server's semantic tokens over
  the TextMate result, which can recolor some identifiers. Monaco has no equivalent, so
  colors here are the pure TextMate layer — what VS Code shows with
  `editor.semanticHighlighting.enabled: false`.
- **Bracket-pair colors** come from Monaco's native feature rather than the theme's token
  rules, same as VS Code.

## Language services

Four Monaco language-service workers ship: **TypeScript/JavaScript**, **JSON**, **CSS**, and
**HTML**. They give completions, hovers, signature help, and diagnostics.

Semantic validation is deliberately **off** for TypeScript and JavaScript; syntax validation
is on. A file opened on its own has no module graph, so almost every semantic error would be
a false "cannot find module" against imports the worker can't resolve. Completions, hovers,
and type inference *within* the open file still work — `widgets[0].` still offers the right
properties with their types.

## Split panes

Splitting an editor tab gives two views of **one shared document**, like VS Code: typing in
either pane shows up live in the other, the dirty marker belongs to the file rather than the
tab, and saving from either pane clears both. Closing the last tab for a file releases it, so
the next open re-reads from disk.

## Settings

| Key | Default | Description |
|---|---|---|
| `textEditor.extensions` | `ts,tsx,js,jsx,mjs,cjs,css,py,go,rs,sh,txt,toml` | File extensions this editor opens for — excludes json/yml/yaml, md/markdown, html/htm, and csv/tsv by default since those already have a dedicated bundled preview; add one back here if you'd rather edit it as plain text |
| `textEditor.openOnClick` | `false` | Open directly on a plain FILES-tree click instead of nvim (takes effect after a reload) |

Files over 2MB, or files that look binary, show a refusal message instead of loading —
open those in another viewer.

Ctrl/Cmd+S saves, and the toolbar's Save button lights up while there are unsaved
changes (closing a dirty tab confirms first).

## Notes on mobile

Monaco renders and scrolls on a phone, and the minimap is turned off automatically on touch
devices, but its touch text-selection is weaker than a native editor's — nvim remains a tap
away through the FILES-tree click.
