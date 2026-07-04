// Packs each top-level extension folder into a .tsix — a zip whose contents
// sit under a top-level extension/ folder, matching what tmux-server's
// installFromTsixFile (server/src/extensions.ts) expects to unzip.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(repoRoot, "dist");

// Discovered rather than hardcoded — any top-level folder with a
// package.json is an extension, so adding one under the repo root is picked
// up automatically (mirrors tmux-server's own listFoldersIn/discoverExtensions
// pattern in server/src/extensions.ts).
const EXTENSIONS = readdirSync(repoRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(repoRoot, e.name, "package.json")))
  .map((e) => e.name);

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

    // Zipped to a uniquely-named path inside dist/ itself (not workDir, whose
    // filesystem may differ from dist/'s and make the rename below fail with
    // EXDEV — see installFromTsixFile's own cp-not-rename comment for the
    // same tradeoff), then moved into place with a same-directory atomic
    // rename — two concurrent `npm run pack` runs would otherwise both write
    // the same dist/<name>.tsix path and could interleave/corrupt output.
    const tsixName = `${name}-${version}.tsix`;
    const stagedTsixPath = path.join(distDir, `.tmp-${randomUUID()}-${tsixName}`);
    try {
      execFileSync("zip", ["-q", "-r", stagedTsixPath, "extension"], { cwd: workDir });
      renameSync(stagedTsixPath, path.join(distDir, tsixName));
    } catch (err) {
      rmSync(stagedTsixPath, { force: true });
      if (err.code === "ENOENT") {
        throw new Error('packing extensions requires the "zip" command, which was not found on PATH');
      }
      throw err;
    }
    console.log(`packed ${tsixName}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
