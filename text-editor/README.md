# Text Editor

A CodeMirror-based editor tab with syntax highlighting and save-back to disk — for a
quick edit without a round-trip through nvim. Registers as a **preview** viewer by
default: a FILES-tree click still opens nvim as usual; this is reached via the hover
Preview icon, the "Preview" context-menu item, or Shift+Enter.

## Supported languages

Syntax highlighting is bundled for JS/JSX, TS/TSX, JSON, CSS, HTML, Markdown, and
Python. Any other extension in the configured list still opens and saves — it just
renders as plain text. (A broader language set was tried via
`@codemirror/language-data` and dropped: this repo's build has no code-splitting, so
that package's language list statically pulls in ~30 legacy-mode packages regardless
of "lazy" loading, ballooning the bundle from ~1.1MB to 2.7MB for languages most users
would never open.)

## Settings

| Key | Default | Description |
|---|---|---|
| `textEditor.extensions` | `ts,tsx,js,jsx,mjs,cjs,css,py,go,rs,sh,txt,toml` | File extensions this editor opens for — excludes json/yml/yaml, md/markdown, html/htm, and csv/tsv by default since those already have a dedicated bundled preview; add one back here if you'd rather edit it as plain text |
| `textEditor.openOnClick` | `false` | Open directly on a plain FILES-tree click instead of nvim (takes effect after a reload) |

Files over 2MB, or files that look binary, show a refusal message instead of loading —
open those in another viewer.

Ctrl/Cmd+S saves, and the toolbar's Save button lights up while there are unsaved
changes (closing a dirty tab confirms first).
