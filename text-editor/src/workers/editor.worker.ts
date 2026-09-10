// Monaco editor worker entry — built by scripts/build.mjs into dist/workers/editor.worker.js
// and loaded through ctx.assetUrl by MonacoEnvironment.getWorker (see client.tsx).
// The specifier goes through monaco-editor's exports map ("./*.js" -> "./esm/vs/*.js"),
// so the historical "monaco-editor/esm/vs/..." form no longer resolves in 0.56.
import "monaco-editor/editor/editor.worker.js";
