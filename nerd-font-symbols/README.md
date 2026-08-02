# Symbols Nerd Font

The symbols-only [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) face — **Symbols Nerd Font Mono** — carrying all 10,413 icon glyphs: powerline separators, Font Awesome, Devicons, Octicons, Material Design Icons, Weather Icons, Seti-UI and the rest.

It contains **no letters or digits**, which is the point: it sits *behind* whichever font you actually type in, and the browser falls back to it only for glyphs your primary font doesn't have. Prompts like starship and powerlevel10k, and file listings from `eza`/`lsd`, render their icons instead of tofu boxes (`▯`).

## Contributes

- **Font group:** Symbols Nerd Font (one family, `Symbols Nerd Font Mono`, regular weight)

## Install

```sh
npm run pack
```

Then, in tmux-server's Extensions sidebar tab:
- **Registry (recommended):** click the gear icon, add this repo's `dist/` folder as a source, and click Install on Symbols Nerd Font.
- **Manual:** click "Install from .tsix" and pick `dist/nerd-font-symbols-<version>.tsix`.

## Use it

In **Settings → Terminal**, leave **Font family** as whatever you already use and set **Secondary font** to *Symbols Nerd Font*:

```
Font family:    IBM Plex Mono        ← unchanged
Secondary font: Symbols Nerd Font    ← this extension
```

That writes a stack of `'IBM Plex Mono', 'Symbols Nerd Font Mono', …`, so text keeps rendering in your font and only missing icon glyphs fall through. Picking it as the **primary** font instead would leave you with a terminal that can't draw letters.

Check it with:

```sh
printf '    \n'
```

The font file only downloads once the family is actually present in your font stack — installing the extension alone costs nothing.

## Source

`fonts/symbols-nerd-font-mono-400-normal.woff2` (1,177,504 bytes) is converted — **without subsetting** — from `SymbolsNerdFontMono-Regular.ttf` (2,507,556 bytes), the exact file tmux-server itself bundled until commit `56e7c22` removed it from core. All 10,413 glyphs and the format-12 cmap survive the conversion.

To regenerate it from that same source:

```sh
git -C /path/to/tmux-server show 56e7c22^:client/public/fonts/SymbolsNerdFontMono-Regular.ttf > /tmp/symbols.ttf
npm install --no-save wawoff2
node -e "const{compress}=require('wawoff2');const fs=require('fs');compress(fs.readFileSync('/tmp/symbols.ttf')).then(w=>fs.writeFileSync('fonts/symbols-nerd-font-mono-400-normal.woff2',Buffer.from(w)))"
```

MIT licensed; see `LICENSE.txt` for the upstream notice and the per-icon-set attribution.
