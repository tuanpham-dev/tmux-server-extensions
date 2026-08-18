// github: a GITHUB sidebar tab listing the active repo's open pull requests
// and issues via the `gh` CLI, with a "Start work" action per row that
// creates a worktree session for it (optionally priming an agent). Host
// hooks arrive via module-level bridge variables set once in activate() —
// same pattern every bundled-style extension in the main repo uses.
import { useCallback, useEffect, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import Icon from "./Icon";
import { sendToAgent } from "./agentTarget";

// ---- Module-level host bridge ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
let openSessionWindow: ((sessionName: string, opts?: { createCwd?: string }) => void) | null = null;
let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;

// ---- Types (mirror server.js's responses) ----

interface StatusResponse {
  authed: boolean;
  repo: string | null;
}

interface PrRow {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  updatedAt: string;
  isDraft: boolean;
  url: string;
}

interface IssueRow {
  number: number;
  title: string;
  author: { login: string };
  updatedAt: string;
  url: string;
}

interface IssueDetail extends IssueRow {
  body: string;
}

// ---- Fetch helpers ----

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function apiGet<T>(path: string): Promise<T> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(path).then((res) => readJson<T>(res));
}

function apiPost<T>(path: string, body: unknown): Promise<T> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => readJson<T>(res));
}

// ---- Helpers ----

// Byte-identical to the bundled worktrees extension's own sessionNameFor —
// tmux session names can't contain "." or ":".
function sessionNameFor(branch: string): string {
  return branch.replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

function shortSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "untitled";
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

interface AgentPreset {
  name: string;
  command: string;
}

// Same JSON-string setting pattern as the bundled worktrees extension's
// worktrees.agents.
function parseAgentPresets(raw: unknown): AgentPreset[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (p): p is AgentPreset =>
      typeof p === "object" && p !== null && typeof (p as AgentPreset).name === "string" && typeof (p as AgentPreset).command === "string",
  );
}

function readSendAutoSubmit(): boolean {
  return extSettings?.get("github.sendAutoSubmit") === true;
}

// ---- GitHubPanel (registerSidebarPanel component) ----

function GitHubPanel() {
  const [cwd, setCwd] = useState<string | null>(() => getActiveContext?.().cwd ?? null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [prs, setPrs] = useState<PrRow[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!onDidChangeContext) return;
    return onDidChangeContext((ctx) => setCwd(ctx.cwd));
  }, []);

  const refresh = useCallback(() => {
    if (!cwd) {
      setStatus(null);
      setPrs([]);
      setIssues([]);
      return;
    }
    apiGet<StatusResponse>(`/status?cwd=${encodeURIComponent(cwd)}`)
      .then((s) => {
        setStatus(s);
        setError(null);
        if (!s.authed || !s.repo) {
          setPrs([]);
          setIssues([]);
          return;
        }
        Promise.all([
          apiGet<{ prs: PrRow[] }>(`/prs?cwd=${encodeURIComponent(cwd)}`),
          apiGet<{ issues: IssueRow[] }>(`/issues?cwd=${encodeURIComponent(cwd)}`),
        ])
          .then(([prData, issueData]) => {
            setPrs(prData.prs);
            setIssues(issueData.issues);
          })
          .catch((err: Error) => setError(err.message));
      })
      .catch((err: Error) => setError(err.message));
  }, [cwd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startWork = useCallback(
    async (kind: "issue" | "pr", number: number, title: string) => {
      if (!cwd) return;
      const branch = kind === "issue" ? `issue-${number}-${shortSlug(title)}` : `pr-${number}`;
      setBusyBranch(branch);
      setStartError(null);
      try {
        const result = await apiPost<{ path: string; branch: string }>("/worktree", { cwd, branch, kind, number });
        const sessionName = sessionNameFor(branch);
        openSessionWindow?.(sessionName, { createCwd: result.path });

        const presets = parseAgentPresets(extSettings?.get("github.agents"));
        const preset = presets[0];
        if (preset) {
          await sendToAgent(sessionName, preset.command, true, { retries: 12, retryDelayMs: 400 });
          let body: string;
          if (kind === "issue") {
            const detail = await apiGet<IssueDetail>(`/issue?cwd=${encodeURIComponent(cwd)}&number=${number}`);
            body = `Issue #${number}: ${detail.title}\n\n${detail.body || ""}`;
          } else {
            body = `PR #${number}: ${title}`;
          }
          await sendToAgent(sessionName, body, readSendAutoSubmit(), { retries: 6, retryDelayMs: 400 });
        }
      } catch (err) {
        setStartError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyBranch(null);
      }
    },
    [cwd],
  );

  if (error) {
    return <div className="github-error">{error}</div>;
  }

  if (!cwd) {
    return <div className="github-empty">No active window.</div>;
  }

  if (!status) {
    return <div className="github-empty">Loading…</div>;
  }

  if (!status.authed) {
    return (
      <div className="github-empty">
        Not signed in. Run <code>gh auth login</code> on this machine, then reopen this panel.
      </div>
    );
  }

  if (!status.repo) {
    return <div className="github-empty">Not a GitHub repository.</div>;
  }

  return (
    <div className="github-panel">
      {startError && <div className="github-error">{startError}</div>}
      <div className="github-section-header">PULL REQUESTS</div>
      {prs.length === 0 && <div className="github-empty">No open pull requests.</div>}
      <ul className="github-list">
        {prs.map((pr) => {
          const branch = `pr-${pr.number}`;
          return (
            <li key={pr.number} className="github-row">
              <a className="github-row-main" href={pr.url} target="_blank" rel="noopener noreferrer">
                <span className="github-number">#{pr.number}</span>
                <span className="github-title">
                  {pr.isDraft ? "[Draft] " : ""}
                  {pr.title}
                </span>
                <span className="github-meta">
                  {pr.author.login} · {relativeTime(pr.updatedAt)}
                </span>
              </a>
              <button
                className="icon-button"
                title="Start work: create a worktree session for this PR"
                disabled={busyBranch === branch}
                onClick={() => void startWork("pr", pr.number, pr.title)}
              >
                <Icon name={busyBranch === branch ? "loading" : "git-branch"} />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="github-section-header">ISSUES</div>
      {issues.length === 0 && <div className="github-empty">No open issues.</div>}
      <ul className="github-list">
        {issues.map((issue) => {
          const branch = `issue-${issue.number}-${shortSlug(issue.title)}`;
          return (
            <li key={issue.number} className="github-row">
              <a className="github-row-main" href={issue.url} target="_blank" rel="noopener noreferrer">
                <span className="github-number">#{issue.number}</span>
                <span className="github-title">{issue.title}</span>
                <span className="github-meta">
                  {issue.author.login} · {relativeTime(issue.updatedAt)}
                </span>
              </a>
              <button
                className="icon-button"
                title="Start work: create a worktree session for this issue"
                disabled={busyBranch === branch}
                onClick={() => void startWork("issue", issue.number, issue.title)}
              >
                <Icon name={busyBranch === branch ? "loading" : "git-branch"} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    focusBinding?: string;
    component: () => ReturnType<typeof GitHubPanel>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
  };
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  getActiveContext = ctx.app.getActiveContext;
  onDidChangeContext = ctx.app.onDidChangeContext;
  openSessionWindow = ctx.app.openSessionWindow;
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: "github",
    title: "GitHub",
    icon: "github",
    component: GitHubPanel,
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
}
