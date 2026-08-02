#!/usr/bin/env node
// Validates every extension manifest in this repo against what tmux-server's
// installer, registry loader, and Settings UI actually require — the checks
// that would otherwise only fail after publishing. This repo is the default
// registry for every tmux-server install (server/src/registry.ts hardcodes its
// GitHub Pages URL), so a malformed catalog reaches every user; CI runs this
// before `pack` and refuses to deploy on failure.
//
// Usage:
//   node scripts/check.mjs                      manifest rules only (R1-R7)
//   node scripts/check.mjs --changed-since <ref>  + require a version bump for
//                                                 every extension changed vs <ref> (R8)
//   node scripts/check.mjs --dist                 + verify dist/ matches the
//                                                 manifests after `npm run pack` (R9)
//
// Every violation is collected and printed; the exit code is 1 if any rule
// failed, so one run reports the whole picture instead of the first problem.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(repoRoot, "dist");

// Mirrors server/src/extensions.ts's isSafeId — extension ids are URL path
// segments (/api/ext/<id>), so anything outside this charset is unroutable.
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
// The four scalar kinds the host renders; array/object properties are silently
// dropped from the Settings UI (see docs/EXTENSION_API.md).
const SCALAR_TYPES = new Set(["boolean", "number", "integer", "string"]);

const problems = [];
function fail(extension, rule, message) {
  problems.push({ extension, rule, message });
}

// Same discovery rule as scripts/pack.mjs: a top-level folder with a
// package.json is an extension, so a new folder is picked up automatically.
function findExtensions() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(repoRoot, e.name, "package.json")))
    .map((e) => e.name)
    .sort();
}

function parseArgs(argv) {
  const opts = { changedSince: null, dist: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dist") opts.dist = true;
    else if (argv[i] === "--changed-since") {
      opts.changedSince = argv[++i];
      if (!opts.changedSince) throw new Error("--changed-since requires a git ref");
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return opts;
}

function readManifest(name) {
  const file = path.join(repoRoot, name, "package.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(name, "R0", `package.json is not valid JSON: ${err.message}`);
    return null;
  }
}

// R1/R2 — identity the registry and installer depend on.
function checkIdentity(name, manifest) {
  if (typeof manifest.name !== "string" || !manifest.name) {
    fail(name, "R1", "manifest has no `name` (registry entries without one are dropped)");
  }
  if (typeof manifest.publisher !== "string" || !manifest.publisher) {
    fail(name, "R1", "manifest has no `publisher` (the id would fall back to the bare name)");
  }
  if (manifest.name && manifest.publisher) {
    const id = `${manifest.publisher}.${manifest.name}`;
    if (!SAFE_ID.test(id)) fail(name, "R1", `id "${id}" is not a safe URL path segment`);
  }
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    fail(name, "R2", `version ${JSON.stringify(manifest.version)} is not <major>.<minor>.<patch>`);
  }
}

// R3/R4/R5 — the files pack.mjs copies into the catalog beside the .tsix.
function checkFiles(name, manifest) {
  if (typeof manifest.icon === "string") {
    if (!existsSync(path.join(repoRoot, name, manifest.icon))) {
      fail(name, "R3", `manifest declares icon "${manifest.icon}" but the file is missing`);
    }
  }
  if (!existsSync(path.join(repoRoot, name, "README.md"))) {
    fail(name, "R4", "no README.md (the catalog links one per extension)");
  }
  if (!existsSync(path.join(repoRoot, name, "LICENSE.txt"))) {
    fail(name, "R5", "no LICENSE.txt (repo convention: every extension carries its attribution)");
  }
}

// R6 — contributes.configuration, which the host renders directly. An array of
// { title, properties } sections is accepted and flattened, same as the host.
function checkConfiguration(name, manifest) {
  const raw = manifest.contributes?.configuration;
  if (raw === undefined) return;
  const sections = Array.isArray(raw) ? raw : [raw];
  const prefixes = new Set();
  for (const section of sections) {
    const properties = section?.properties;
    if (!properties || typeof properties !== "object") {
      fail(name, "R6", "contributes.configuration section has no `properties` object");
      continue;
    }
    for (const [key, prop] of Object.entries(properties)) {
      if (!key.includes(".")) {
        fail(name, "R6", `setting "${key}" has no dotted prefix (keys are global; declare your own)`);
      } else {
        prefixes.add(key.slice(0, key.indexOf(".")));
      }
      if (!SCALAR_TYPES.has(prop?.type)) {
        fail(name, "R6", `setting "${key}" has type ${JSON.stringify(prop?.type)}; the host only renders ${[...SCALAR_TYPES].join("/")}`);
      }
      if (prop?.default === undefined) fail(name, "R6", `setting "${key}" has no \`default\``);
      if (typeof prop?.description !== "string" || !prop.description) {
        fail(name, "R6", `setting "${key}" has no \`description\``);
      }
      if (prop?.enum !== undefined) {
        if (!Array.isArray(prop.enum)) {
          fail(name, "R6", `setting "${key}" has a non-array \`enum\``);
        } else if (prop.enumItemLabels !== undefined && prop.enumItemLabels.length !== prop.enum.length) {
          fail(name, "R6", `setting "${key}" has ${prop.enum.length} enum values but ${prop.enumItemLabels.length} enumItemLabels`);
        }
      }
    }
  }
  if (prefixes.size > 1) {
    fail(name, "R6", `settings mix prefixes (${[...prefixes].sort().join(", ")}); one extension should own one prefix`);
  }
}

// R7 — the entry points the host imports. dist/client.js is build output and
// may legitimately be absent before `npm run build`, so for a folder with a
// src/client.tsx the path is checked by convention rather than existence.
function checkEntries(name, manifest) {
  const entry = manifest.tmuxServer;
  if (!entry) return;
  if (typeof entry.client === "string") {
    if (existsSync(path.join(repoRoot, name, "src/client.tsx"))) {
      if (entry.client !== "./dist/client.js") {
        fail(name, "R7", `has src/client.tsx, so tmuxServer.client must be "./dist/client.js" (found ${JSON.stringify(entry.client)})`);
      }
    } else if (!existsSync(path.join(repoRoot, name, entry.client))) {
      fail(name, "R7", `tmuxServer.client "${entry.client}" does not exist and there is no src/client.tsx to build it from`);
    }
  }
  if (typeof entry.server === "string" && !existsSync(path.join(repoRoot, name, entry.server))) {
    fail(name, "R7", `tmuxServer.server "${entry.server}" does not exist`);
  }
  if (entry.required === true) {
    fail(name, "R7", 'tmuxServer.required is bundled-only; the host ignores it on installed extensions');
  }
}

// R8 — a changed extension whose version didn't move republishes under its old
// version, and every client caches by version, so the update never lands.
function checkVersionBumps(names, ref) {
  let changed;
  try {
    changed = execFileSync("git", ["diff", "--name-only", ref, "--", "."], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (err) {
    fail("(repo)", "R8", `cannot diff against "${ref}": ${err.message.trim().split("\n")[0]}`);
    return;
  }
  const touched = new Set(
    changed
      .split("\n")
      .map((line) => line.trim().split("/")[0])
      .filter((folder) => names.includes(folder)),
  );
  for (const name of [...touched].sort()) {
    const current = readManifest(name)?.version;
    let previous;
    try {
      previous = JSON.parse(
        // stderr silenced: a folder that doesn't exist at <ref> is the normal
        // "new extension" case handled below, not something to print.
        execFileSync("git", ["show", `${ref}:${name}/package.json`], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ).version;
    } catch {
      continue; // new extension at this ref — nothing to bump from
    }
    if (current === previous) {
      fail(name, "R8", `changed since ${ref} but version is still ${current} — bump it or the update never reaches installed clients`);
    }
  }
}

// R9 — what `npm run pack` actually produced, checked against the manifests.
function checkDist(names) {
  const indexPath = path.join(distDir, "index.json");
  if (!existsSync(indexPath)) {
    fail("(dist)", "R9", "dist/index.json is missing — run `npm run pack` first");
    return;
  }
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (err) {
    fail("(dist)", "R9", `dist/index.json is not valid JSON: ${err.message}`);
    return;
  }
  const entries = Array.isArray(catalog.extensions) ? catalog.extensions : [];
  if (entries.length !== names.length) {
    fail("(dist)", "R9", `catalog lists ${entries.length} extensions but the repo has ${names.length}`);
  }
  for (const name of names) {
    const entry = entries.find((e) => e.name === name);
    if (!entry) {
      fail(name, "R9", "missing from dist/index.json");
      continue;
    }
    const manifest = readManifest(name);
    if (manifest && entry.version !== manifest.version) {
      fail(name, "R9", `catalog version ${entry.version} != manifest version ${manifest.version}`);
    }
    for (const field of ["file", "readme", "icon"]) {
      const value = entry[field];
      if (value === undefined) continue;
      const target = path.join(distDir, value);
      if (!existsSync(target)) fail(name, "R9", `catalog ${field} "${value}" is not in dist/`);
      else if (field === "file" && statSync(target).size === 0) fail(name, "R9", `${value} is empty`);
    }
  }
}

const opts = parseArgs(process.argv.slice(2));
const names = findExtensions();
if (names.length === 0) {
  console.error("no extensions found (a top-level folder with a package.json)");
  process.exit(1);
}

for (const name of names) {
  const manifest = readManifest(name);
  if (!manifest) continue;
  checkIdentity(name, manifest);
  checkFiles(name, manifest);
  checkConfiguration(name, manifest);
  checkEntries(name, manifest);
}
if (opts.changedSince) checkVersionBumps(names, opts.changedSince);
if (opts.dist) checkDist(names);

if (problems.length === 0) {
  const extras = [opts.changedSince && `bumps vs ${opts.changedSince}`, opts.dist && "dist/"].filter(Boolean);
  console.log(`check: ${names.length} extensions OK${extras.length ? ` (+ ${extras.join(", ")})` : ""}`);
  process.exit(0);
}

console.error(`check: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
for (const name of [...new Set(problems.map((p) => p.extension))]) {
  console.error(`  ${name}`);
  for (const p of problems.filter((x) => x.extension === name)) {
    console.error(`    [${p.rule}] ${p.message}`);
  }
}
process.exit(1);
