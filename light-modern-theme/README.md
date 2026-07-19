# Light Modern

VS Code's **Light Modern** color theme, flattened into a single tmux-server-compatible theme file.

## Contributes

- **Color theme:** Light Modern

## Source

Flattened from `microsoft/vscode`'s `theme-defaults` extension (`light_modern.json` → `light_plus.json` → `light_vs.json` include chain), with the default `terminal.ansi*` palette and `editor.selectionBackground` injected — see `themes/light-modern-color-theme.json` for the provenance comment. MIT-licensed; see `LICENSE.txt`.

## Install

```sh
npm run pack
```

Then, in tmux-server's Extensions sidebar tab:
- **Registry (recommended):** click the gear icon, add this repo's `dist/` folder as a source, and click Install on Light Modern.
- **Manual:** click "Install from .tsix" and pick `dist/light-modern-theme-<version>.tsix`.
