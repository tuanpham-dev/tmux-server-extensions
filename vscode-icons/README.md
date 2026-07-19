# VSCode Icons

The **vscode-icons** file-icon theme — SVG icons for common file types, languages, and folder states.

## Contributes

- **Icon theme:** VSCode Icons

## Source

[vscode-icons/vscode-icons](https://github.com/vscode-icons/vscode-icons), MIT-licensed; see `LICENSE.txt`. Icon theme JSON and ~1,150 SVG icons vendored unmodified (path separators normalized to `/`).

## Install

```sh
npm run pack
```

Then, in tmux-server's Extensions sidebar tab:
- **Registry (recommended):** click the gear icon, add this repo's `dist/` folder as a source, and click Install on VSCode Icons.
- **Manual:** click "Install from .tsix" and pick `dist/vscode-icons-<version>.tsix`.
