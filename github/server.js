// github server hook: PR/issue listing and "Start work" worktree creation,
// all driven through the `gh` CLI (execFile, never a shell string — branch
// names, titles, and numbers are external data). No credentials of its own:
// authorization is whatever `gh auth login` already set up on this machine.
//
// The worktree-creation helpers (repoRoot/gitCommonDir/ensureExcluded/
// resolveLocation) are a verbatim copy of the bundled worktrees extension's
// own (extensions/worktrees/server.js in the main tmux-server repo) — this
// registry repo can't import across extensions, so it's copied with this
// comment naming the source rather than silently duplicated.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GH_TIMEOUT = 15000;
const GIT_TIMEOUT = 15000;

function run(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

const gh = (args, cwd) => run("gh", args, cwd, GH_TIMEOUT);
const git = (args, cwd) => run("git", args, cwd, GIT_TIMEOUT);

async function ghAuthed() {
  try {
    await gh(["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

async function repoNameWithOwner(cwd) {
  try {
    const out = await gh(["repo", "view", "--json", "nameWithOwner"], cwd);
    return JSON.parse(out).nameWithOwner ?? null;
  } catch {
    return null;
  }
}

// ---- Worktree-creation helpers (copied from extensions/worktrees/server.js
// — see this file's header) ----

async function repoRoot(cwd) {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return null;
  }
}

async function gitCommonDir(cwd) {
  const raw = (await git(["rev-parse", "--git-common-dir"], cwd)).trim();
  return path.resolve(cwd, raw);
}

function branchSlug(branch) {
  return branch.replace(/[/\\]/g, "-");
}

function resolveLocation(template, repo, branch) {
  const filled = template.replaceAll("{repo}", repo).replaceAll("{branch}", branchSlug(branch));
  return path.resolve(repo, filled);
}

async function ensureExcluded(repo, target) {
  const rel = path.relative(repo, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const top = rel.split(path.sep)[0];
  const pattern = rel === top ? `/${top}` : `/${top}/`;
  let excludeFile;
  try {
    excludeFile = path.join(await gitCommonDir(repo), "info", "exclude");
  } catch {
    return;
  }
  let current = "";
  try {
    current = fs.readFileSync(excludeFile, "utf8");
  } catch {
    // No info/exclude yet (or unreadable) — created below.
  }
  if (current.split("\n").some((line) => line.trim() === pattern)) return;
  try {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(excludeFile, `${prefix}${pattern}\n`);
  } catch {
    // Best-effort: a read-only .git shouldn't block creating the worktree.
  }
}

export function activate({ router, getSettings }) {
  // authed:false, never a 500 — the panel's own "not set up" state reads
  // this, and a missing/unauthed `gh` is the expected common case, not an
  // error.
  router.get("/status", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return;
    }
    const authed = await ghAuthed();
    if (!authed) {
      res.json({ authed: false, repo: null });
      return;
    }
    res.json({ authed: true, repo: await repoNameWithOwner(cwd) });
  });

  router.get("/prs", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return;
    }
    try {
      const out = await gh(
        ["pr", "list", "--json", "number,title,author,headRefName,updatedAt,isDraft,url", "--limit", "30"],
        cwd,
      );
      res.json({ prs: JSON.parse(out) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/issues", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return;
    }
    try {
      const out = await gh(["issue", "list", "--json", "number,title,author,updatedAt,url", "--limit", "30"], cwd);
      res.json({ issues: JSON.parse(out) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/issue", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    const number = typeof req.query.number === "string" ? req.query.number : "";
    if (!cwd || !path.isAbsolute(cwd) || !number) {
      res.status(400).json({ error: "cwd (absolute path) and number are required" });
      return;
    }
    try {
      const out = await gh(["issue", "view", number, "--json", "number,title,author,updatedAt,url,body"], cwd);
      res.json(JSON.parse(out));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Creates a worktree for an issue (new branch off the default branch) or a
  // PR (fetches its head ref by number, per GitHub's refs/pull/<n>/head
  // convention, then checks that out) — the session itself is created
  // client-side via ctx.app.openSessionWindow, same split of duties as the
  // worktrees extension.
  router.post("/worktree", async (req, res) => {
    const { cwd, branch, kind, number } = req.body ?? {};
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof branch !== "string" || !branch.trim()) {
      res.status(400).json({ error: "cwd (absolute path) and branch are required" });
      return;
    }
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.status(400).json({ error: `${cwd} is not inside a git repository` });
      return;
    }
    const settings = await getSettings();
    const template =
      typeof settings["github.worktreeLocation"] === "string" && settings["github.worktreeLocation"].trim()
        ? settings["github.worktreeLocation"].trim()
        : "{repo}/.worktrees/{branch}";
    const target = resolveLocation(template, repo, branch.trim());
    if (fs.existsSync(target)) {
      res.status(409).json({ error: `${target} already exists` });
      return;
    }
    await ensureExcluded(repo, target);
    try {
      if (kind === "pr") {
        if (!Number.isInteger(number)) {
          res.status(400).json({ error: "number (integer) is required for kind=pr" });
          return;
        }
        await git(["fetch", "origin", `pull/${number}/head:${branch.trim()}`], repo);
        await git(["worktree", "add", target, branch.trim()], repo);
      } else {
        await git(["worktree", "add", "-b", branch.trim(), target], repo);
      }
      res.json({ path: target, branch: branch.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
