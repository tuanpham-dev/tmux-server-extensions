# Dark Modern

VS Code's **Dark Modern** color theme, flattened into a single tmux-server-compatible theme file.

## Contributes

- **Color theme:** Dark Modern

## Source

Flattened from `microsoft/vscode`'s `theme-defaults` extension (`dark_modern.json` → `dark_plus.json` → `dark_vs.json` include chain), with the default `terminal.ansi*` palette and `editor.selectionBackground` injected — see `themes/dark-modern-color-theme.json` for the provenance comment. MIT-licensed; see `LICENSE.txt`.

## Install

```sh
npm run pack
```

Then, in tmux-server's Extensions sidebar tab:
- **Registry (recommended):** click the gear icon, add this repo's `dist/` folder as a source, and click Install on Dark Modern.
- **Manual:** click "Install from .tsix" and pick `dist/dark-modern-theme-<version>.tsix`.
