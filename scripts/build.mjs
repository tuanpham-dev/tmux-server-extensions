#!/usr/bin/env node
// Builds each code extension's <name>/src/client.tsx into <name>/dist/client.js
// (+ dist/client.css if the entry pulls in CSS). Data-only extensions (themes,
// fonts, icons — no src/client.tsx) are skipped. react/react-dom/
// react-jsx-runtime/@tmux-server/engine-support are aliased to scripts/shims/*
// so every bundled extension shares the host's single React/engine-support
// instance instead of shipping its own — a second real copy of React would have
// its own hook dispatcher and break under the host's ReactDOM. Mirrors
// tmux-server's own extensions/build.mjs.
import { build } from "esbuild";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsDir);

const shims = {
  react: path.join(scriptsDir, "shims/react.mjs"),
  "react-dom": path.join(scriptsDir, "shims/react-dom.mjs"),
  "react-dom/client": path.join(scriptsDir, "shims/react-dom-client.mjs"),
  "react/jsx-runtime": path.join(scriptsDir, "shims/react-jsx-runtime.mjs"),
  "@tmux-server/engine-support": path.join(scriptsDir, "shims/engine-support.mjs"),
};

// A code extension is any top-level folder with a src/client.tsx entry (mirrors
// tmux-server's findExtensionNames).
function findCodeExtensions() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(repoRoot, name, "src/client.tsx")));
}

async function buildOne(name) {
  await build({
    entryPoints: [path.join(repoRoot, name, "src/client.tsx")],
    outfile: path.join(repoRoot, name, "dist/client.js"),
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
  });
  console.log(`[extensions] built ${name}`);
}

const names = findCodeExtensions();
if (names.length === 0) {
  console.log("[extensions] no code extensions with a src/client.tsx entry found");
} else {
  await Promise.all(names.map(buildOne));
}
