# Popular Monospace Fonts

Four popular terminal/coding monospace fonts, each in regular, medium, and bold weights (plus italic where the upstream family ships one): **Fira Code**, **JetBrains Mono**, **Cascadia Code**, and **Source Code Pro**.

## Contributes

- **Font groups:** Fira Code, JetBrains Mono, Cascadia Code, Source Code Pro

Each group covers core latin + latin-ext character coverage, split into per-script `unicode-range` subsets so the browser only fetches the glyphs it actually needs.

## Source

OFL-1.1 licensed; see `LICENSE.txt` for the per-family copyright notices and license text.

## Install

```sh
npm run pack
```

Then, in tmux-server's Extensions sidebar tab:
- **Registry (recommended):** click the gear icon, add this repo's `dist/` folder as a source, and click Install on Popular Monospace Fonts.
- **Manual:** click "Install from .tsix" and pick `dist/mono-fonts-<version>.tsix`.

Then pick a font group from Settings → Terminal.
