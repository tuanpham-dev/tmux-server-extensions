# tmux-server extensions

Optional [tmux-server](https://github.com/) extensions, packaged as installable `.tsix` files. These are not bundled with tmux-server itself — install the ones you want through the app's Settings → Extensions UI.

## Extensions

| Extension | Type | Source | License |
|---|---|---|---|
| Dark Modern | color theme | flattened from [microsoft/vscode](https://github.com/microsoft/vscode)'s `dark_modern.json` include chain | MIT |
| Light Modern | color theme | flattened from [microsoft/vscode](https://github.com/microsoft/vscode)'s `light_modern.json` include chain | MIT |
| One Dark Pro | color theme (5 variants) | [Binaryify/OneDark-Pro](https://github.com/Binaryify/OneDark-Pro) | MIT |
| VSCode Icons | file icon theme | [vscode-icons-team/vscode-icons](https://github.com/vscode-icons-team/vscode-icons) | MIT |
| Popular Monospace Fonts | terminal fonts (4 groups) | Fira Code, JetBrains Mono, Cascadia Code, Source Code Pro — via [Fontsource](https://fontsource.org/) | OFL-1.1 |

Each extension's `LICENSE.txt` carries the full upstream license text and attribution.

### Dark Modern / Light Modern

VS Code's own theme loader chains `dark_modern.json → dark_plus.json → dark_vs.json` (same for light). tmux-server's theme loader only follows one `include` level, and the `*_plus.json` layer contributes no workbench colors anyway (only `tokenColors`, which tmux-server ignores) — so these two themes are authored as single flattened JSON files merging the `*_vs.json` + `*_modern.json` color layers.

A handful of keys VS Code sets via `registerColor()` defaults in its own source rather than in any theme JSON — the 16 `terminal.ansi*` colors, `editor.selectionBackground`, `gitDecoration.*`, `charts.yellow`/`charts.green`, `editorWarning.foreground` — are injected from those same registry defaults so the themes render a complete, self-contained palette. See the provenance comment at the top of each theme JSON for the full list and source.

### Popular Monospace Fonts

One extension, four selectable font groups (Fira Code, JetBrains Mono, Cascadia Code, Source Code Pro), each with core latin + latin-ext coverage across regular/500/bold weights plus italic where the upstream family ships one — sourced from the already-split, already-subsetted [`@fontsource`](https://fontsource.org/) npm packages rather than raw upstream releases, same approach as tmux-server's own bundled `ibm-plex-mono` extension.

## Packing

```sh
npm run pack
```

Produces `dist/<extension>-<version>.tsix` for each extension — a zip with contents under a top-level `extension/` folder, matching the format tmux-server's extension installer expects.

## Installing

In tmux-server, open Settings → Extensions → Install from file, and pick a `.tsix` from `dist/`. Or via the API — the endpoint expects the raw file bytes as the request body, not a multipart upload:

```sh
curl -X POST -H "content-type: application/octet-stream" \
  --data-binary @dist/vscode-icons-12.19.0.tsix \
  http://localhost:<port>/api/extensions/install
```
