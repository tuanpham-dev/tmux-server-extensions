// agent-monitor: every tmux pane running one of the agents in the app's own
// registry (Settings → Agents), classified working/waiting/done and shown
// as a status dot on that window's own PROJECTS-pane row. Host hooks arrive
// via module-level bridge variables set once in activate(), same pattern as
// every other bundled-style extension (search, git-scm, worktrees).
//
// No settings section of its own any more: the hook snippet, the install
// button and the "have any events arrived" readout all live in core's
// Settings → Agents now, for every agent at once rather than for Claude
// Code alone (plans/agent-platform-core.md).
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let removeStylesheet: (() => void) | null = null;

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
  const permission = row.stateDetail === "permission";
  const label = permission
    ? "Waiting for you - permission"
    : row.state === "waiting"
      ? "Waiting for you"
      : "Working";
  return {
    // Shape first, color second. A pane that is blocking on YOU right now
    // gets a question mark, not a third shade of dot — it reads before the
    // color does, and it can't be mistaken for the working dot at a glance
    // (the same reason Orca draws that state as an icon rather than a hue).
    badge: permission ? "?" : "●",
    tooltip: row.taskLabel ? `${label} - ${row.taskLabel}` : label,
    className: `agent-monitor-badge-${row.stateDetail ?? row.state}`,
  };
}

// ---- Activation ----

interface SessionDecorationContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

interface ExtensionContext {
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
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

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
