#!/usr/bin/env node
// Builds each code extension's <name>/src/client.tsx into <name>/dist/client.js
// (+ dist/client.css if the entry pulls in CSS). Data-only extensions (themes,
// fonts, icons — no src/client.tsx) are skipped. react/react-dom/
// react-jsx-runtime/@tmux-server/engine-support are aliased to scripts/shims/*
// so every bundled extension shares the host's single React/engine-support
// instance instead of shipping its own — a second real copy of React would have
// its own hook dispatcher and break under the host's ReactDOM. Mirrors
// tmux-server's own extensions/build.mjs.
//
// Two extra, optional entry conventions, both loaded at runtime by URL through
// ctx.assetUrl (the host's /api/extensions/<id>/file/* route) rather than by a
// static import — that's what keeps them out of client.js:
//
//   <name>/src/chunks/*.ts   -> <name>/dist/chunks/*.js   lazily import()ed
//                                                          bundles, for weight
//                                                          that shouldn't load
//                                                          until first use
//   <name>/src/workers/*.ts  -> <name>/dist/workers/*.js   web-worker entries
//
// Any CSS or font a chunk imports lands beside it (dist/chunks/*.css and the
// asset files its url() references), so relative URLs inside the stylesheet
// resolve through the same file route. Reference: text-editor, whose Monaco
// bundle, editor stylesheet, codicon font, and five language-service workers
// all come out of these two conventions.
import { build } from "esbuild";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsDir);

// monaco-vim imports Monaco through the pre-0.56 "monaco-editor/esm/vs/..."
// specifier style, which that version's `exports` map no longer resolves (the
// same breakage the worker entries hit). Pointing each at its real file fixes
// resolution and — crucially — keeps them the *same module instances* the rest
// of the chunk already imports through "monaco-editor", so esbuild dedupes
// instead of bundling a second ~5MB Monaco that vim would then attach to
// instead of the real editor.
const monacoDir = path.join(repoRoot, "node_modules/monaco-editor/esm/vs");
const monacoInternalAliases = {
  "monaco-editor/esm/vs/editor/editor.api": path.join(monacoDir, "editor/editor.api.js"),
  "monaco-editor/esm/vs/editor/common/commands/shiftCommand": path.join(
    monacoDir,
    "editor/common/commands/shiftCommand.js",
  ),
};

// A missing target would silently fall back to bundling a duplicate Monaco, so
// stop the build instead — a failure here is cheap to read, that one is not.
for (const [specifier, target] of Object.entries(monacoInternalAliases)) {
  if (!existsSync(target)) {
    throw new Error(
      `Alias target for "${specifier}" does not exist: ${target}\n` +
        "monaco-editor probably moved this internal path. Update monacoInternalAliases in scripts/build.mjs — " +
        "without the alias, esbuild bundles a second copy of Monaco and monaco-vim attaches to the wrong instance.",
    );
  }
}

const shims = {
  react: path.join(scriptsDir, "shims/react.mjs"),
  "react-dom": path.join(scriptsDir, "shims/react-dom.mjs"),
  "react-dom/client": path.join(scriptsDir, "shims/react-dom-client.mjs"),
  "react/jsx-runtime": path.join(scriptsDir, "shims/react-jsx-runtime.mjs"),
  "@tmux-server/engine-support": path.join(scriptsDir, "shims/engine-support.mjs"),
  ...monacoInternalAliases,
};

// Shared by the client entry, chunks, and workers so a module behaves
// identically whichever one pulls it in.
const commonOptions = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  // Production artifacts: no sourcemap, and stub the Vite-only
  // import.meta.env.DEV an extension moved from core might reference.
  sourcemap: false,
  alias: shims,
  logLevel: "info",
  define: { "import.meta.env.DEV": "false" },
  // Fonts referenced from bundled CSS (Monaco's codicon.ttf) are emitted as
  // files next to the stylesheet; [name] keeps the URL stable across builds so
  // the host's file route serves a predictable path.
  loader: { ".ttf": "file" },
  assetNames: "[name]",
};

// A code extension is any top-level folder with a src/client.tsx entry (mirrors
// tmux-server's findExtensionNames).
function findCodeExtensions() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(repoRoot, name, "src/client.tsx")));
}

// The .ts/.tsx files directly inside <name>/src/<subdir>, if that folder exists.
function findEntries(name, subdir) {
  const dir = path.join(repoRoot, name, "src", subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(dir, e.name));
}

async function buildOne(name) {
  await build({
    ...commonOptions,
    entryPoints: [path.join(repoRoot, name, "src/client.tsx")],
    outfile: path.join(repoRoot, name, "dist/client.js"),
  });

  for (const subdir of ["chunks", "workers"]) {
    const entryPoints = findEntries(name, subdir);
    if (entryPoints.length === 0) continue;
    await build({
      ...commonOptions,
      entryPoints,
      outdir: path.join(repoRoot, name, "dist", subdir),
      // Minified, unlike client.js: these are the multi-megabyte artifacts
      // (Monaco is ~9MB raw), they're fetched over the network on first use,
      // and nobody reads them — where an extension's own client.js stays
      // readable for debugging in the browser.
      minify: true,
    });
    console.log(`[extensions] built ${name} ${subdir} (${entryPoints.length})`);
  }

  console.log(`[extensions] built ${name}`);
}

const names = findCodeExtensions();
if (names.length === 0) {
  console.log("[extensions] no code extensions with a src/client.tsx entry found");
} else {
  await Promise.all(names.map(buildOne));
}
