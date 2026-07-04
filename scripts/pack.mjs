// Packs each top-level extension folder into a .tsix — a zip whose contents
// sit under a top-level extension/ folder, matching what tmux-server's
// installFromTsixFile (server/src/extensions.ts) expects to unzip.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(repoRoot, "dist");

const EXTENSIONS = ["dark-modern-theme", "light-modern-theme", "one-dark-pro-theme", "vscode-icons"];

mkdirSync(distDir, { recursive: true });

for (const name of EXTENSIONS) {
  const srcDir = path.join(repoRoot, name);
  const manifest = JSON.parse(readFileSync(path.join(srcDir, "package.json"), "utf8"));
  const version = manifest.version || "0.0.0";

  const workDir = mkdtempSync(path.join(tmpdir(), "tmux-server-ext-pack-"));
  try {
    const stagedRoot = path.join(workDir, "extension");
    mkdirSync(stagedRoot, { recursive: true });
    cpSync(srcDir, stagedRoot, { recursive: true });

    const tsixName = `${name}-${version}.tsix`;
    const tsixPath = path.join(distDir, tsixName);
    rmSync(tsixPath, { force: true });
    execFileSync("zip", ["-q", "-r", tsixPath, "extension"], { cwd: workDir });
    console.log(`packed ${tsixName}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
