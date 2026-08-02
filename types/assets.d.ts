// Extension entries do `import "./style.css"` for its side effect — esbuild
// resolves that and emits dist/client.css, but tsc has no notion of a CSS
// module and would report TS2307. Declared here rather than per-extension so
// one ambient file covers every extension's src/.
declare module "*.css";
