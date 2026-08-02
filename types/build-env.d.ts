// ghostty-engine/src/engine.ts guards its devtools handles behind
// `import.meta.env.DEV` — a Vite-ism inherited from when that extension lived
// in tmux-server's client. This repo builds with esbuild, which substitutes
// the expression at build time (scripts/build.mjs's
// `define: { "import.meta.env.DEV": "false" }`) rather than providing Vite's
// ambient types, so tsc needs the shape declared here.
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
