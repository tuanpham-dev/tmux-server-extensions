# Ghostty Terminal Engine

The [ghostty-web](https://github.com/coder/ghostty-web) (WASM) terminal
rendering engine, packaged as an installable tmux-server extension.

Installing it adds a **Ghostty** option under **Settings → Terminal**. When it
isn't installed, tmux-server uses its bundled, required **xterm.js** engine —
so this is purely an opt-in upgrade, and uninstalling it always falls back
cleanly.

It contributes a terminal engine (`ext.tmux-server.ghostty-engine.ghostty`) and
nothing else; the ghostty-web WASM is bundled into the extension's `client.js`
at build time, so there's no separate asset to load.

## License

ghostty-web is MIT-licensed (© Coder). This extension bundles it under those
terms; see the upstream project for the full text.
