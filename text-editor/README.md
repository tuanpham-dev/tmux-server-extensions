# Text Editor

A **Monaco**-based editor — the editor VS Code itself is built on — with syntax
highlighting, IntelliSense, git diffs, merge-conflict resolution, and save-back to disk.

Pick it in **Settings → Editor** and it replaces nvim outright: every file, diff and merge
conflict the app would have opened in a tmux pane opens here instead. Leave nvim selected and
this extension does nothing at all — the same deal nvim has when Monaco is chosen. There is no
per-file-type list to configure and no half-on state.

(On an app too old to have the Editor setting, it falls back to what it was before: a preview
viewer for common code files, reached via the hover Preview icon, the "Preview" context-menu
item, or Shift+Enter.)

You get the editor you already know: find and replace, multi-cursor, code folding,
bracket-pair colorization, go-to-definition within the file, and the command palette
(F1) — all of Monaco's own keybindings, except the few the app claims first
(`Ctrl+P`, `Ctrl+Shift+P`, `Ctrl+W`).

## Loading

Monaco is **lazy-loaded**. Having this extension enabled costs ~20 KB up front; the
editor bundle (~7.5 MB, all grammars included) is fetched the first time you actually open an editor tab, and each
language-service worker only when a file of that kind is opened. Nothing is downloaded in a
session where you only use terminals.

| Artifact | Size | Fetched |
|---|---:|---|
| `dist/client.js` | 19 KB | at activation |
| `dist/chunks/monaco.js` | 7.5 MB | first editor tab |
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

### Which languages

Around fifty languages carry a real TextMate grammar and therefore match VS Code exactly:
TypeScript/JavaScript with JSX, JSON, CSS/SCSS/Less, HTML, Markdown, Python, Go, Rust, Shell,
YAML, TOML, Java, C, C++, C#, PHP, Ruby, SQL, XML, Dockerfile, Lua, Swift, Kotlin, Perl,
GraphQL, Vue, PowerShell, Makefile, HCL/Terraform, Protobuf, Zig, Elixir, Erlang, Haskell,
Clojure, Scala, Dart, Objective-C, Julia, Groovy, CMake, Vim script, LaTeX, diff/patch, INI,
JSONC, Handlebars, Liquid, nginx, Apache, Prisma and Solidity.

Several of those Monaco doesn't know at all — it opens a `.toml`, `.vue`, `.zig` or
`CMakeLists.txt` as plain text — so `src/languages.ts` registers them first, along with the
comment and bracket behaviour that makes commenting and auto-closing work.

**Everything else still gets colour.** Monaco carries its own, coarser tokenizers for around
eighty languages, and the generated theme includes a second approximate rule set keyed to
their token names. An R or Pascal file looks like code rather than a wall of grey, just
without the per-scope precision the grammars above give. Anything with no tokenizer at all
opens and saves as plain text.

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

## Preview

A file that some other extension can render — Markdown, JSON/YAML, CSV — gets an **Open
Preview** button in the tab bar, next to Save. It opens the same rendered view the FILES
tree's hover icon does, in its own tab, leaving the editor open beside it.

This is a tab's advantage over a tmux pane: nvim has nowhere to put such a button, so the
rendered view was only ever reachable from the file tree. Whether a click lands here or in
the preview first is that viewer's own setting — Markdown's `markdown.clickAction`, for
instance.

## Git diffs

With this editor selected, clicking a file in the Source Control panel opens Monaco's diff
editor: syntax highlighted, side-by-side or inline (toggle in the tab bar), with
character-level highlighting inside a changed line.

The right-hand side is editable when it is a real working file, and Ctrl/Cmd+S writes it —
so a diff doubles as the place to fix what you were reviewing. A staged file's diff compares
HEAD to the index; that side is editable only while the working tree still matches the index,
because writing index text over a drifted working tree would throw away the unstaged changes.
When it can't be edited, the tab says why.

Commit diffs stay in the Source Control panel's own view: a commit is a multi-file patch, and
Monaco's diff editor shows one file.

## Merge conflicts

A conflicted file opens as itself — markers and all — with each block tinted and four actions
above it: **Accept Current Change**, **Accept Incoming Change**, **Accept Both Changes** and
**Compare Changes**. These are the same four VS Code's built-in merge-conflict extension
contributes, and the colours are VS Code's own.

Accepting rewrites the block through Monaco's edit history, so undo works and nothing reaches
disk until you save. The tab bar also carries accept-all-current and accept-all-incoming, and
a **Mark as Resolved** button that stages the file — enabled only once no markers remain and
the file is saved.

The Source Control panel keeps its own diff and conflict views as a secondary action ("Open in
Git Diff View", "Resolve in Git Merge View"), and falls back to them whenever a file can't be
shown here, such as a binary one.

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

Which editor opens your files is the app's own **Settings → Editor** choice, not this
extension's. What it does own is how the editor looks:

| Key | Default | Description |
|---|---|---|
| `textEditor.minimap` | `auto` | Whether to draw the minimap, the code overview down the right edge. **Auto** shows it on desktop and hides it on phones and tablets, where it only eats width; **Always show** and **Always hide** override that. Applies to open tabs immediately. Diffs and merge conflicts never show one. |

Files over 2MB, or files that look binary, show a refusal message instead of loading —
open those in another viewer.

Ctrl/Cmd+S saves, and the toolbar's Save button lights up while there are unsaved
changes (closing a dirty tab confirms first).

## Notes on mobile

Monaco renders and scrolls on a phone, and the minimap is turned off automatically on touch
devices, but its touch text-selection is weaker than a native editor's — nvim remains a tap
away through the FILES-tree click.
