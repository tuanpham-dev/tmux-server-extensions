# tmux-server extensions

Optional [tmux-server](https://github.com/tuanpham-dev/tmux-server) extensions, packaged as installable `.tsix` files and served as a registry catalog. These are not bundled with tmux-server itself — install the ones you want through the app's Extensions sidebar tab.

## Extensions

| Extension | Type | Source | License |
|---|---|---|---|
| Full Keyboard | on-screen keyboard | first-party (tmux-server) | MIT |
| One-Hand Operation | bottom swipe bar | first-party (tmux-server) | MIT |
| Dark Modern | color theme | flattened from [microsoft/vscode](https://github.com/microsoft/vscode)'s `dark_modern.json` include chain | MIT |
| Light Modern | color theme | flattened from [microsoft/vscode](https://github.com/microsoft/vscode)'s `light_modern.json` include chain | MIT |
| One Dark Pro | color theme (5 variants) | [Binaryify/OneDark-Pro](https://github.com/Binaryify/OneDark-Pro) | MIT |
| VSCode Icons | file icon theme | [vscode-icons/vscode-icons](https://github.com/vscode-icons/vscode-icons) | MIT |
| Popular Monospace Fonts | terminal fonts (4 groups) | Fira Code, JetBrains Mono, Cascadia Code, Source Code Pro — via [Fontsource](https://fontsource.org/) | OFL-1.1 |

Each extension's `LICENSE.txt` carries the full upstream license text and attribution.

### Dark Modern / Light Modern

VS Code's own theme loader chains `dark_modern.json → dark_plus.json → dark_vs.json` (same for light). tmux-server's theme loader only follows one `include` level, and the `*_plus.json` layer contributes no workbench colors anyway (only `tokenColors`, which tmux-server ignores) — so these two themes are authored as single flattened JSON files merging the `*_vs.json` + `*_modern.json` color layers.

A handful of keys VS Code sets via `registerColor()` defaults in its own source rather than in any theme JSON — the 16 `terminal.ansi*` colors, `editor.selectionBackground`, `gitDecoration.*`, `charts.yellow`/`charts.green`, `editorWarning.foreground` — are injected from those same registry defaults so the themes render a complete, self-contained palette. See the provenance comment at the top of each theme JSON for the full list and source.

### Popular Monospace Fonts

One extension, four selectable font groups (Fira Code, JetBrains Mono, Cascadia Code, Source Code Pro), each with core latin + latin-ext coverage across regular/500/bold weights plus italic where the upstream family ships one — sourced from the already-split, already-subsetted [`@fontsource`](https://fontsource.org/) npm packages rather than raw upstream releases, same approach as tmux-server's own bundled `ibm-plex-mono` extension.

## Packing

```sh
npm install   # first time only — pulls esbuild for code extensions
npm run pack
```

`pack` first runs `npm run build`, which esbuild-bundles any **code** extension (a folder with `src/client.tsx` — e.g. Full Keyboard) into its `dist/client.js`/`client.css`, with `react`/`@tmux-server/engine-support` aliased to the host-instance shims in `scripts/shims/`. Data-only extensions (themes, fonts, icons) have no build step. Then, per extension, it produces: `dist/<extension>-<version>.tsix` (a zip with contents under a top-level `extension/` folder, matching the format tmux-server's extension installer expects), a `-README.md` copy, and a `-icon.<ext>` copy for any extension with an `icon` manifest field — plus a `dist/index.json` catalog listing all of the above, in the shape tmux-server's registry feature expects.

## Registry (recommended)

`dist/` is itself a valid registry source — no separate publishing step needed. In tmux-server:

1. Open the **Extensions** sidebar tab (`Ctrl+Shift+X`).
2. Click the gear icon → "Manage registries".
3. Add this repo's absolute `dist/` path (e.g. `/works/tmux-server-extensions/dist`) as a source, or serve it over HTTP (`python3 -m http.server` from inside `dist/`) and add that URL instead.
4. Every extension in the table above appears under **Available** — click Install.

Re-running `npm run pack` after editing a theme/font and clicking the refresh icon in the Extensions tab picks up the change immediately, without reinstalling.

## Hosting the registry on GitHub Pages

For a shareable, always-online registry, this repo publishes `dist/` to GitHub Pages via [`.github/workflows/pages.yml`](.github/workflows/pages.yml). The workflow runs `npm run pack` and deploys the built catalog on every push to `main` — `dist/` is never committed (it's `.gitignore`d); it's regenerated in CI.

tmux-server fetches the catalog server-side, so no CORS config is needed. Once Pages is live, add this URL as a registry source in the Extensions tab:

```
https://tuanpham-dev.github.io/tmux-server-extensions/
```

The server appends `index.json` to that base, then downloads each `.tsix`/README/icon by the relative path in the catalog.

### One-time setup

```sh
# from inside this repo, with the GitHub CLI authenticated (gh auth login)
git remote add origin git@github.com:tuanpham-dev/tmux-server-extensions.git
gh repo create tuanpham-dev/tmux-server-extensions --public --source=. --remote=origin --push
```

Then enable Pages with the **GitHub Actions** source (once):

```sh
gh api -X POST repos/tuanpham-dev/tmux-server-extensions/pages \
  -f 'build_type=workflow'
```

Or via the web UI: **Settings → Pages → Build and deployment → Source: GitHub Actions**. After the first workflow run finishes (Actions tab), the URL above is live. Publishing a new extension version is just `git push` — bump the version, push, wait for the Action, then hit refresh in the Extensions tab (allow a few minutes for GitHub's CDN cache).

## Installing manually

Without setting up a registry source, install one `.tsix` at a time: in the Extensions tab, click "Install from .tsix" and pick a file from `dist/`. Or via the API — the endpoint expects the raw file bytes as the request body, not a multipart upload:

```sh
curl -X POST -H "content-type: application/octet-stream" \
  --data-binary @dist/vscode-icons-12.19.0.tsix \
  http://localhost:<port>/api/extensions/install
```
