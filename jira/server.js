// jira server hook: issue listing and "Start work" worktree creation against
// the Jira Cloud REST API v3.
//
// Unlike the sibling github extension - which shells out to `gh` and so holds
// no credentials of its own - Jira has no ubiquitous CLI to inherit an
// authenticated session from, so this extension owns the credential. It is
// NOT a manifest setting: configuration values live in the settings document
// the client GETs, merges and PUTs back whole, which is the wrong home for an
// API token. It lives in the host's per-extension secret store instead
// (activate({ secrets }) - see docs/EXTENSION_API.md in the main tmux-server
// repo), which no client can read and no document write can reach. Only the
// site URL and email are ordinary settings.
//
// Every error that can reach a response body is passed through scrub() first,
// so a token echoed back by Atlassian in a message can't leak that way either.
//
// The worktree-creation helpers (repoRoot/gitCommonDir/ensureExcluded/
// resolveLocation) reimplement what core does in server/src/gitWorktrees.ts
// (in the main tmux-server repo) - an extension can't import core, and this
// registry repo can't import across extensions either, so they're copied with
// this comment naming the source rather than silently duplicated. Note the
// bundled "worktrees" extension has no server hook at all: it's a thin client
// that calls ctx.app.newWorktree, and core owns the git work. The sibling
// github extension carries an older copy of these helpers whose header still
// credits a nonexistent extensions/worktrees/server.js, and whose repoRoot
// still has the nesting bug fixed below.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_TIMEOUT = 15000;
const GIT_TIMEOUT = 15000;
const FETCH_TIMEOUT = 60000; // a cold `git fetch` on a large repo outlasts 15s
const TOKEN_NAME = "apiToken";
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

function run(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

const git = (args, cwd, timeout = GIT_TIMEOUT) => run("git", args, cwd, timeout);

// ---- Atlassian Document Format ----

// v3 returns `description` as an ADF tree rather than text. Flattened here so
// the agent gets something readable; calling /rest/api/2/ purely to get a
// plain-text description would mean keeping a deprecated API surface alive
// for one field.
function adfToText(node) {
  if (!node || typeof node !== "object") return "";

  // A text node's URL lives in its `marks`, not in the text — so collecting
  // only `node.text` silently drops every hyperlink. That cost real context:
  // a comment reading "Preview: <link>  MR: <link>" flattened to
  // "Preview:  MR:" and the agent never saw either URL. Emitted as markdown
  // so the label and the target both survive.
  if (node.type === "text") {
    const text = typeof node.text === "string" ? node.text : "";
    const href = Array.isArray(node.marks)
      ? node.marks.find((m) => m?.type === "link")?.attrs?.href
      : undefined;
    if (!href) return text;
    if (!text || text === href) return href;
    return `[${text}](${href})`;
  }

  if (node.type === "hardBreak") return "\n";

  // Nodes that carry their whole meaning in attrs and have no `content` at
  // all, so the recursion below would render them as nothing:
  //   inlineCard/blockCard/embedCard  a "smart link" — a bare pasted URL
  //   mention                         "@Someone", the cc: in a comment
  //   emoji / status / date           inline chips
  //   media                           an attached file or screenshot
  if (node.type === "inlineCard" || node.type === "blockCard" || node.type === "embedCard") {
    const url = node.attrs?.url ?? node.attrs?.data?.url ?? "";
    return url ? `${url}\n` : "";
  }
  if (node.type === "mention") return node.attrs?.text ?? "";
  if (node.type === "emoji") return node.attrs?.text ?? node.attrs?.shortName ?? "";
  if (node.type === "status") return node.attrs?.text ? `[${node.attrs.text}]` : "";
  if (node.type === "date") return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
  if (node.type === "media") {
    const name = node.attrs?.alt || node.attrs?.id || "file";
    return `(attachment: ${name})\n`;
  }

  const joiner = node.type === "tableRow" ? " | " : "";
  const children = Array.isArray(node.content) ? node.content.map(adfToText).join(joiner) : "";

  switch (node.type) {
    case "paragraph":
    case "heading":
    case "blockquote":
      return `${children}\n`;
    case "codeBlock":
      // Fenced, so the agent can tell code from prose.
      return `\`\`\`\n${children.replace(/\n+$/, "")}\n\`\`\`\n`;
    case "listItem":
      return `- ${children.replace(/\n+$/, "")}\n`;
    case "tableRow":
      return `${children.replace(/\n+$/g, "")}\n`;
    case "tableCell":
    case "tableHeader":
      return children.replace(/\n+$/, "");
    case "rule":
      return "---\n";
    default:
      return children;
  }
}

export function activate({ router, getSettings, secrets }) {
  // ---- Config ----

  async function readConfig() {
    const settings = await getSettings();
    const rawSite = typeof settings["jira.siteUrl"] === "string" ? settings["jira.siteUrl"].trim() : "";
    const email = typeof settings["jira.email"] === "string" ? settings["jira.email"].trim() : "";
    const apiToken = await secrets.get(TOKEN_NAME);
    let siteUrl = "";
    if (rawSite) {
      try {
        const url = new URL(rawSite);
        if (url.protocol === "https:") siteUrl = rawSite.replace(/\/+$/, "");
      } catch {
        // Not a URL at all — treated the same as "not configured yet".
      }
    }
    return { settings, siteUrl, email, apiToken };
  }

  // A token echoed back inside an Atlassian error message must not reach a
  // response body, so every message that can be surfaced goes through here.
  function scrub(message, apiToken) {
    const text = String(message ?? "");
    return apiToken ? text.split(apiToken).join("***") : text;
  }

  async function jiraFetch(cfg, pathAndQuery, init = {}) {
    const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
    const res = await fetch(`${cfg.siteUrl}${pathAndQuery}`, {
      ...init,
      headers: {
        authorization: `Basic ${auth}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    if (!res.ok) {
      // Atlassian puts the useful part in errorMessages/errors; fall back to
      // the status line when the body isn't its usual JSON. statusText is
      // empty over HTTP/2, so it is only appended when there is one — a bare
      // "404 " with a dangling space reads like a bug in the panel.
      let detail = res.statusText ? `${res.status} ${res.statusText}` : `HTTP ${res.status}`;
      try {
        const body = await res.json();
        const messages = [
          ...(Array.isArray(body?.errorMessages) ? body.errorMessages : []),
          ...(body?.errors && typeof body.errors === "object" ? Object.values(body.errors) : []),
        ].filter((m) => typeof m === "string");
        if (messages.length > 0) detail = messages.join("; ");
      } catch {
        // non-JSON error body; keep the status line
      }
      const err = new Error(scrub(detail, cfg.apiToken));
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const myself = (cfg) => jiraFetch(cfg, "/rest/api/3/myself");

  async function search(cfg, jql, maxResults) {
    const body = await jiraFetch(cfg, "/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults,
        fields: ["summary", "status", "issuetype", "assignee", "updated"],
      }),
    });
    const issues = Array.isArray(body?.issues) ? body.issues : [];
    return issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields?.summary ?? "",
      status: issue.fields?.status?.name ?? "",
      // "new" | "indeterminate" | "done" — the only part of a status that is
      // stable across projects, since status NAMES are per-workflow. The
      // panel colours its status chip from this.
      statusCategory: issue.fields?.status?.statusCategory?.key ?? null,
      type: issue.fields?.issuetype?.name ?? "",
      assignee: issue.fields?.assignee?.displayName ?? null,
      updated: issue.fields?.updated ?? null,
      url: `${cfg.siteUrl}/browse/${issue.key}`,
    }));
  }

  function commentLimitOf(settings) {
    const raw = settings["jira.commentLimit"];
    return Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : 20;
  }

  function maxResultsOf(settings) {
    const raw = settings["jira.maxResults"];
    return Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 30;
  }

  // ---- Worktree helpers (copied from extensions/worktrees/server.js — see
  // this file's header) ----

  // The MAIN worktree, not `--show-toplevel`. --show-toplevel returns
  // whichever worktree cwd happens to be in, so starting work on a second
  // ticket from inside the first ticket's session would create the new
  // worktree *under* that one — and nest one level deeper every time after.
  // `git worktree list --porcelain` always emits the main worktree first.
  // Mirrors core's mainRepoRoot (server/src/gitWorktrees.ts in the main
  // tmux-server repo), whose comment describes the same trap.
  async function repoRoot(cwd) {
    let inside;
    try {
      inside = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
    } catch {
      return null;
    }
    if (!inside) return null;
    try {
      const out = await git(["worktree", "list", "--porcelain"], inside);
      const first = out.split("\n").find((line) => line.startsWith("worktree "));
      if (first) return first.slice("worktree ".length).trim();
    } catch {
      // Unusual layout — the containing worktree is still a usable answer.
    }
    return inside;
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

  // ---- Project key ----

  // Four sources, most local first — the in-repo file wins the way
  // .editorconfig and .nvmrc beat user-level config. Returns which source
  // answered so the panel can show it. A candidate that doesn't look like a
  // project key doesn't stop the chain; the next source gets a turn.
  async function resolveProjectKey(settings, cwd) {
    const repo = await repoRoot(cwd);

    const fileName = typeof settings["jira.projectKeyFile"] === "string" ? settings["jira.projectKeyFile"].trim() : "";
    if (repo && fileName) {
      try {
        const first = fs.readFileSync(path.join(repo, fileName), "utf8").split("\n")[0].trim();
        if (PROJECT_KEY.test(first)) return { key: first.toUpperCase(), source: "file" };
      } catch {
        // No such file in this repo — the common case, not an error.
      }
    }

    if (repo) {
      try {
        const parsed = JSON.parse(typeof settings["jira.projectMap"] === "string" ? settings["jira.projectMap"] : "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const want = repo.replace(/\/+$/, "");
          for (const [dir, key] of Object.entries(parsed)) {
            if (typeof dir === "string" && typeof key === "string" && dir.replace(/\/+$/, "") === want) {
              if (PROJECT_KEY.test(key.trim())) return { key: key.trim().toUpperCase(), source: "projectMap" };
            }
          }
        }
      } catch {
        // Malformed JSON in the setting — skipped, not thrown.
      }
    }

    const envName = typeof settings["jira.projectKeyEnv"] === "string" ? settings["jira.projectKeyEnv"].trim() : "";
    if (envName) {
      const fromEnv = (process.env[envName] ?? "").trim();
      if (PROJECT_KEY.test(fromEnv)) return { key: fromEnv.toUpperCase(), source: "env" };
    }

    const flat = typeof settings["jira.projectKey"] === "string" ? settings["jira.projectKey"].trim() : "";
    if (PROJECT_KEY.test(flat)) return { key: flat.toUpperCase(), source: "setting" };

    return { key: null, source: null };
  }

  // ---- Request guards ----

  function requireCwd(req, res) {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return null;
    }
    return cwd;
  }

  function fail(res, err, apiToken) {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? 400 : 500;
    res.status(status).json({ error: scrub(err?.message, apiToken) });
  }

  // ---- Read endpoints ----

  // Always 200 (never 500) once cwd is valid — the panel's "not set up" states
  // read this, and an unconfigured extension is the expected first run, not an
  // error. Mirrors the github extension's /status contract.
  router.get("/status", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const cfg = await readConfig();
    const hasToken = !!cfg.apiToken;
    const configured = !!(cfg.siteUrl && cfg.email && hasToken);
    const { key, source } = await resolveProjectKey(cfg.settings, cwd);
    if (!configured) {
      res.json({ configured, hasToken, authed: false, user: null, projectKey: key, projectSource: source, error: null });
      return;
    }
    try {
      const me = await myself(cfg);
      res.json({
        configured,
        hasToken,
        authed: true,
        user: { accountId: me?.accountId ?? null, displayName: me?.displayName ?? null },
        projectKey: key,
        projectSource: source,
        error: null,
      });
    } catch (err) {
      // 404 from /myself means the URL isn't a Jira site at all, which reads
      // as a baffling "not found" unless we say which of the three settings
      // is the likely culprit. 401/403 is the token or the email.
      let message = scrub(err.message, cfg.apiToken);
      if (err.status === 404) message = `${message} - is jira.siteUrl (${cfg.siteUrl}) a Jira site?`;
      else if (err.status === 401 || err.status === 403) message = `${message} - check jira.email and your API token.`;
      res.json({
        configured,
        hasToken,
        authed: false,
        user: null,
        projectKey: key,
        projectSource: source,
        error: message,
      });
    }
  });

  router.get("/issues", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const scope = req.query.scope;
    if (scope !== "mine" && scope !== "project") {
      res.status(400).json({ error: 'scope must be "mine" or "project"' });
      return;
    }
    const cfg = await readConfig();
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) {
      res.status(400).json({ error: "jira is not configured" });
      return;
    }
    const limit = maxResultsOf(cfg.settings);
    const override = (name) => (typeof cfg.settings[name] === "string" ? cfg.settings[name].trim() : "");

    try {
      if (scope === "mine") {
        const jql = override("jira.jql") || DEFAULT_JQL;
        res.json({ issues: await search(cfg, jql, limit), projectKey: null, projectSource: null });
        return;
      }
      const projectJql = override("jira.projectJql");
      if (projectJql) {
        res.json({ issues: await search(cfg, projectJql, limit), projectKey: null, projectSource: "projectJql" });
        return;
      }
      const { key, source } = await resolveProjectKey(cfg.settings, cwd);
      if (!key) {
        res.json({ issues: [], projectKey: null, projectSource: null });
        return;
      }
      const jql = `project = "${key}" AND statusCategory != Done ORDER BY updated DESC`;
      res.json({ issues: await search(cfg, jql, limit), projectKey: key, projectSource: source });
    } catch (err) {
      fail(res, err, cfg.apiToken);
    }
  });

  router.get("/issue", async (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    if (!ISSUE_KEY.test(key)) {
      res.status(400).json({ error: "key must be an issue key like CAP-123" });
      return;
    }
    const cfg = await readConfig();
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) {
      res.status(400).json({ error: "jira is not configured" });
      return;
    }
    try {
      const issue = await jiraFetch(
        cfg,
        `/rest/api/3/issue/${key}?fields=summary,description,status,issuetype,priority,labels`,
      );

      // Comments are where the actual decisions usually live - the
      // description is often a one-liner and everything that matters was
      // hashed out in the thread. Fetched separately because the issue
      // endpoint's own `comment` field is paginated and capped independently.
      // 0 disables; failure is non-fatal, since a usable description beats no
      // context at all.
      const limit = commentLimitOf(cfg.settings);
      let comments = [];
      if (limit > 0) {
        try {
          const body = await jiraFetch(
            cfg,
            `/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${limit}`,
          );
          comments = (Array.isArray(body?.comments) ? body.comments : [])
            .map((c) => ({
              author: c.author?.displayName ?? "Unknown",
              created: c.created ?? null,
              body: adfToText(c.body).trim(),
            }))
            .filter((c) => c.body)
            // orderBy=-created gives newest first; reverse so the agent reads
            // the thread in the order it happened.
            .reverse();
        } catch {
          // Left empty — the description alone is still worth handing over.
        }
      }

      res.json({
        key: issue.key,
        summary: issue.fields?.summary ?? "",
        description: adfToText(issue.fields?.description).trim(),
        status: issue.fields?.status?.name ?? "",
        type: issue.fields?.issuetype?.name ?? "",
        priority: issue.fields?.priority?.name ?? null,
        labels: Array.isArray(issue.fields?.labels) ? issue.fields.labels : [],
        comments,
        url: `${cfg.siteUrl}/browse/${issue.key}`,
      });
    } catch (err) {
      fail(res, err, cfg.apiToken);
    }
  });

  // ---- Token routes ----
  //
  // Presence only, never the value — the same contract core's own
  // GET /api/ai-key uses. Core serves no route for extension secrets by
  // design; this is the extension's own.

  router.get("/token", async (_req, res) => {
    res.json({ set: !!(await secrets.get(TOKEN_NAME)) });
  });

  router.put("/token", async (req, res) => {
    const value = req.body?.value;
    if (typeof value !== "string") {
      res.status(400).json({ error: "value must be a string" });
      return;
    }
    await secrets.set(TOKEN_NAME, value.trim() || null);
    res.status(204).end();
  });

  // ---- Write endpoints ----

  // The repo's default branch, so a worktree starts from it rather than from
  // whatever happened to be checked out. origin/HEAD is often simply absent
  // (a --depth clone, or an origin added by hand), so this falls back through
  // `git remote show` to the current HEAD, reporting which it used.
  async function defaultBranch(repo) {
    try {
      const ref = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo)).trim();
      if (ref) return { base: ref, note: null };
    } catch {
      // Fall through — not set locally.
    }
    try {
      const out = await git(["remote", "show", "origin"], repo, FETCH_TIMEOUT);
      const match = out.match(/HEAD branch:\s*(\S+)/);
      if (match && match[1] !== "(unknown)") return { base: `origin/${match[1]}`, note: null };
    } catch {
      // No origin, or it is unreachable.
    }
    return {
      base: null,
      note: "Could not determine the default branch (no origin/HEAD) - branched from the current HEAD instead. `git remote set-head origin -a` fixes this.",
    };
  }

  router.post("/worktree", async (req, res) => {
    const { cwd, branch } = req.body ?? {};
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof branch !== "string" || !branch.trim()) {
      res.status(400).json({ error: "cwd (absolute path) and branch are required" });
      return;
    }
    const name = branch.trim();
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.status(400).json({ error: `${cwd} is not inside a git repository` });
      return;
    }
    const settings = await getSettings();
    const template =
      typeof settings["jira.worktreeLocation"] === "string" && settings["jira.worktreeLocation"].trim()
        ? settings["jira.worktreeLocation"].trim()
        : "{repo}/.worktrees/{branch}";
    const target = resolveLocation(template, repo, name);
    if (fs.existsSync(target)) {
      res.status(409).json({ error: `${target} already exists` });
      return;
    }

    const { base, note } = await defaultBranch(repo);
    if (base) {
      try {
        await git(["fetch", "origin"], repo, FETCH_TIMEOUT);
      } catch (err) {
        // Branching off a stale base silently is worse than saying so.
        res.status(502).json({ error: `git fetch origin failed: ${err.message}` });
        return;
      }
    }

    await ensureExcluded(repo, target);
    try {
      const args = ["worktree", "add", "-b", name, target];
      if (base) args.push(base);
      await git(args, repo);
      res.json({ path: target, branch: name, base: base ?? "HEAD", note });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Always 200, even when a step fails: the worktree already exists by the
  // time this runs, so a 500 here would read as "Start work failed" for
  // something that only affects the Jira side. The reason travels in `note`.
  router.post("/progress", async (req, res) => {
    const key = req.body?.key;
    if (typeof key !== "string" || !ISSUE_KEY.test(key)) {
      res.status(400).json({ error: "key must be an issue key like CAP-123" });
      return;
    }
    const cfg = await readConfig();
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) {
      res.json({ transitioned: false, assigned: false, note: "Jira is not configured." });
      return;
    }
    const wanted =
      typeof cfg.settings["jira.inProgressStatus"] === "string" && cfg.settings["jira.inProgressStatus"].trim()
        ? cfg.settings["jira.inProgressStatus"].trim()
        : "In Progress";

    let transitioned = false;
    let assigned = false;
    const notes = [];

    try {
      const body = await jiraFetch(cfg, `/rest/api/3/issue/${key}/transitions`);
      const transitions = Array.isArray(body?.transitions) ? body.transitions : [];
      const match =
        transitions.find((t) => typeof t?.to?.name === "string" && t.to.name.toLowerCase() === wanted.toLowerCase()) ??
        transitions.find((t) => t?.to?.statusCategory?.key === "indeterminate");
      if (match) {
        await jiraFetch(cfg, `/rest/api/3/issue/${key}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: match.id } }),
        });
        transitioned = true;
      } else {
        notes.push(`No transition to "${wanted}" is available from this issue's current status.`);
      }
    } catch (err) {
      notes.push(`Could not transition the issue: ${scrub(err.message, cfg.apiToken)}`);
    }

    try {
      const issue = await jiraFetch(cfg, `/rest/api/3/issue/${key}?fields=assignee`);
      if (issue?.fields?.assignee) {
        notes.push(`Already assigned to ${issue.fields.assignee.displayName ?? "someone else"}, left as is.`);
      } else {
        const me = await myself(cfg);
        await jiraFetch(cfg, `/rest/api/3/issue/${key}/assignee`, {
          method: "PUT",
          body: JSON.stringify({ accountId: me.accountId }),
        });
        assigned = true;
      }
    } catch (err) {
      notes.push(`Could not assign the issue: ${scrub(err.message, cfg.apiToken)}`);
    }

    res.json({ transitioned, assigned, note: notes.length > 0 ? notes.join(" ") : null });
  });
}
