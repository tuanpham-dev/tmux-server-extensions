// agent-monitor: the AGENTS sidebar tab — every tmux pane running an agent
// program (default: claude), each with a working/waiting/done state — plus
// the tab badge counting agents waiting on you, and a Settings section for
// the optional Claude Code hooks upgrade. Host hooks arrive via module-level
// bridge variables set once in activate(), same pattern as every other
// bundled-style extension (search, git-scm, worktrees).
import { useCallback, useEffect, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let openSessionWindow: ((sessionName: string, opts?: { createCwd?: string }) => void) | null = null;
let setSidebarBadge: ((panelId: string, badge: number | null) => void) | null = null;
let removeStylesheet: (() => void) | null = null;
// Parsed from ctx.assetUrl() at activate() time — see live-preview's
// client.tsx for why this is how an extension recovers its own hook base.
let hookBase = "";

// ---- Types (mirror server.js's /agents response) ----

interface AgentRow {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  command: string;
  cwd: string;
  state: "working" | "waiting" | "done";
  stateDetail?: "permission";
  taskLabel?: string;
  lastActivityAt: number | null;
}

async function fetchAgents(): Promise<AgentRow[]> {
  if (!serverFetch) return [];
  const res = await serverFetch("/agents");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { agents: AgentRow[] };
  return body.agents;
}

// Same basename convention as core's projectName (client/src/lib/projects.ts)
// — a `~`-shortened path's last segment, or "/" for the root.
function projectName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base || trimmed || "/";
}

function relativeTime(at: number | null): string {
  if (at === null) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function rowKey(row: AgentRow): string {
  return `${row.sessionName}:${row.windowIndex}`;
}

// ---- AGENTS panel ----

const PANEL_POLL_MS = 3000;

function AgentsPanel() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchAgents()
      .then((rows) => {
        setAgents(rows);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, PANEL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (error) {
    return <div className="agent-monitor-error">{error}</div>;
  }

  if (agents.length === 0) {
    return <div className="agent-monitor-empty">No agents running.</div>;
  }

  return (
    <ul className="agent-monitor-list">
      {agents.map((row) => (
        <li key={rowKey(row)}>
          <div
            className={`agent-monitor-row agent-monitor-row-${row.state}${row.stateDetail ? ` agent-monitor-row-${row.stateDetail}` : ""}`}
            role="button"
            tabIndex={0}
            title={row.cwd}
            onClick={() => openSessionWindow?.(row.sessionName)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openSessionWindow?.(row.sessionName);
              }
            }}
          >
            <span className="agent-monitor-dot" aria-hidden="true" />
            <span className="agent-monitor-project">{projectName(row.cwd)}</span>
            <span className="agent-monitor-window">{row.windowName || `#${row.windowIndex}`}</span>
            {row.taskLabel && <span className="agent-monitor-task">{row.taskLabel}</span>}
            <span className="agent-monitor-time">{relativeTime(row.lastActivityAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---- Settings component: the opt-in Claude Code hooks snippet (T18) ----

function hooksSnippet(port: number | string): string {
  const command = `curl -s -X POST http://127.0.0.1:${port}${hookBase}/event --data-binary @- -H 'content-type: application/json'`;
  return JSON.stringify(
    {
      hooks: {
        Notification: [{ matcher: "", hooks: [{ type: "command", command }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function AgentHooksSettings() {
  const [status, setStatus] = useState<{ received: number; lastAt: number | null; port: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    if (!serverFetch) return;
    serverFetch("/event-status")
      .then((res) => res.json())
      .then((body) => setStatus(body))
      .catch(() => {
        // Transient — next poll retries.
      });
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const snippet = hooksSnippet(status ? status.port : "${PORT}");

  return (
    <div className="agent-monitor-hooks-settings">
      <p className="agent-monitor-hooks-description">
        Merge this into <code>~/.claude/settings.json</code>'s <code>hooks</code> section to upgrade
        permission-prompt and done detection from a best-effort title guess to Claude Code's own events.
        This extension never edits that file for you.
      </p>
      <pre className="agent-monitor-hooks-snippet">{snippet}</pre>
      <button
        type="button"
        className="agent-monitor-hooks-copy"
        onClick={() => {
          void navigator.clipboard.writeText(snippet).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <p className="agent-monitor-hooks-status">
        {status && status.received > 0
          ? `${status.received} event${status.received === 1 ? "" : "s"} received (last ${relativeTime(status.lastAt)}).`
          : "No hook events received yet."}
      </p>
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
    component: () => ReturnType<typeof AgentsPanel>;
  }): void;
  registerSettingsComponent(component: { id: string; component: () => ReturnType<typeof AgentHooksSettings> }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  app: {
    openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
    setSidebarBadge(panelId: string, badge: number | null): void;
  };
}

const PANEL_ID = "agents";

// Independent of the panel's own mount lifecycle — the badge stays live even
// while the AGENTS tab isn't the active sidebar tab.
const BADGE_POLL_MS = 10_000;
let badgeTimer: number | null = null;

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  openSessionWindow = ctx.app.openSessionWindow;
  setSidebarBadge = ctx.app.setSidebarBadge;
  const match = ctx.assetUrl("x").match(/^(\/api\/extensions\/[^/]+)\/file\//);
  hookBase = match ? match[1].replace("/extensions/", "/ext/") : "";
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: PANEL_ID,
    title: "Agents",
    icon: "robot",
    component: AgentsPanel,
  });

  ctx.registerSettingsComponent({
    id: "agentHooks",
    component: AgentHooksSettings,
  });

  const updateBadge = () => {
    fetchAgents()
      .then((rows) => {
        const waiting = rows.filter((r) => r.state === "waiting").length;
        setSidebarBadge?.(PANEL_ID, waiting > 0 ? waiting : null);
      })
      .catch(() => {
        // Transient — next poll retries.
      });
  };
  updateBadge();
  badgeTimer = window.setInterval(updateBadge, BADGE_POLL_MS);
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  if (badgeTimer !== null) {
    window.clearInterval(badgeTimer);
    badgeTimer = null;
  }
}
