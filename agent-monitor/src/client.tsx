// agent-monitor: every tmux pane running an agent program (default: claude),
// classified working/waiting/done and shown as a status dot on that
// window's own PROJECTS-pane row — plus a Settings section for the optional
// Claude Code hooks upgrade. Host hooks arrive via module-level bridge
// variables set once in activate(), same pattern as every other
// bundled-style extension (search, git-scm, worktrees).
import { useCallback, useEffect, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
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

// ---- Window-row decoration (PROJECTS pane) ----
//
// This app is designed 1 window per tab, so a (sessionName, windowIndex)
// pair identifies at most one agent pane in practice — no merge rule needed
// for multiple agents sharing a row. "done" gets no badge: it's the steady
// state a claude pane sits in most of the time (finished responding, idle
// for new input) — a permanent dot on every idle claude window would be
// more noise than signal.
let agentsByWindowKey = new Map<string, AgentRow>();
let refreshDecorations: (() => void) | null = null;

function decorationFor(row: AgentRow | undefined): { badge: string; tooltip: string; className: string } | undefined {
  if (!row || row.state === "done") return undefined;
  const label = row.state === "waiting" ? "Waiting for you" : "Working";
  return {
    badge: "●",
    tooltip: row.taskLabel ? `${label} — ${row.taskLabel}` : label,
    className: `agent-monitor-badge-${row.stateDetail ?? row.state}`,
  };
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

interface SessionDecorationContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

interface ExtensionContext {
  registerSettingsComponent(component: { id: string; component: () => ReturnType<typeof AgentHooksSettings> }): void;
  registerSessionDecorationProvider(provider: {
    id: string;
    provideWindowDecoration: (
      ctx: SessionDecorationContext,
    ) => { badge: string; tooltip?: string; className?: string } | undefined;
  }): { refresh(): void };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

const POLL_MS = 10_000;
let pollTimer: number | null = null;

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  const match = ctx.assetUrl("x").match(/^(\/api\/extensions\/[^/]+)\/file\//);
  hookBase = match ? match[1].replace("/extensions/", "/ext/") : "";
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSettingsComponent({
    id: "agentHooks",
    component: AgentHooksSettings,
  });

  refreshDecorations = ctx.registerSessionDecorationProvider({
    id: "agents",
    provideWindowDecoration(win) {
      return decorationFor(agentsByWindowKey.get(`${win.sessionName}:${win.windowIndex}`));
    },
  }).refresh;

  const poll = () => {
    fetchAgents()
      .then((rows) => {
        agentsByWindowKey = new Map(rows.map((r) => [rowKey(r), r]));
        refreshDecorations?.();
      })
      .catch(() => {
        // Transient — next poll retries.
      });
  };
  poll();
  pollTimer = window.setInterval(poll, POLL_MS);
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  refreshDecorations = null;
  agentsByWindowKey = new Map();
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}
