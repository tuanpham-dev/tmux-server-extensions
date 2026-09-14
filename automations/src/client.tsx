// automations: the AUTOMATIONS section of the Run tab - every automation with
// its trigger, next run and last result, an enable toggle, Run now, and a
// create/edit form for every trigger and action kind. The scheduler itself is
// server-side and runs with no browser open; this only reads and edits it.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import Icon from "./Icon";

interface SidebarPanelHostProps {
  actionsTarget?: HTMLDivElement | null;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

interface ActiveContext {
  cwd: string | null;
}

const POLL_MS = 10_000;
const EVENT_KINDS = ["task-completed", "task-failed", "task-blocked", "gate-opened", "worker-lost"] as const;
const EVENT_LABELS: Record<(typeof EVENT_KINDS)[number], string> = {
  "task-completed": "A task completes",
  "task-failed": "A task fails",
  "task-blocked": "A task is blocked",
  "gate-opened": "A worker asks for a decision",
  "worker-lost": "A worker is lost",
};

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let removeStylesheet: (() => void) | null = null;

// ---- Types (mirror server.js) ----

type Trigger =
  | { kind: "daily"; time: string }
  | { kind: "interval"; minutes: number }
  | { kind: "cron"; expr: string }
  | { kind: "event"; event: (typeof EVENT_KINDS)[number]; runId?: string; repo?: string };

type ActionKind = "headless" | "create-task" | "start-worker";

interface Action {
  kind: ActionKind;
  prompt: string;
  title?: string;
  agentId?: string;
  worktree?: string;
}

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
  repo: string;
  lastRunAt: number | null;
  lastResult: string;
  lastStatus: "ok" | "error" | "unavailable" | "missed" | null;
  lastReason?: string;
  nextRunAt: number | null;
  runCount: number;
  triggerSummary: string;
  running: boolean;
  needsAgentTasks: boolean;
}

interface ListResponse {
  automations: Automation[];
  agentTasks: { connected: boolean; error: string | null };
  tickSeconds: number;
}

interface Agent {
  id: string;
  label: string;
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
  return (await res.json()) as T;
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

// The agent list lives in agent-tasks' own route; when it is absent the
// start-worker form falls back to core's registry.
async function loadAgents(): Promise<Agent[]> {
  try {
    const res = await fetch("/api/ext/tmux-server.agent-tasks/agents");
    if (res.ok) return ((await res.json()) as { agents: Agent[] }).agents;
  } catch {
    // fall through
  }
  const res = await fetch("/api/agents");
  if (!res.ok) return [];
  return ((await res.json()) as { agents: Agent[] }).agents;
}

function when(ms: number | null): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

// ---- Form ----

interface FormValue {
  name: string;
  repo: string;
  triggerKind: Trigger["kind"];
  time: string;
  minutes: string;
  expr: string;
  event: (typeof EVENT_KINDS)[number];
  runId: string;
  eventRepo: string;
  actionKind: ActionKind;
  prompt: string;
  title: string;
  agentId: string;
  worktree: string;
}

function toForm(a?: Automation): FormValue {
  const t = a?.trigger;
  return {
    name: a?.name ?? "",
    repo: a?.repo ?? getActiveContext?.().cwd ?? "",
    triggerKind: t?.kind ?? "daily",
    time: t?.kind === "daily" ? t.time : "09:00",
    minutes: t?.kind === "interval" ? String(t.minutes) : "60",
    expr: t?.kind === "cron" ? t.expr : "0 9 * * 1-5",
    event: t?.kind === "event" ? t.event : "task-failed",
    runId: t?.kind === "event" ? (t.runId ?? "") : "",
    eventRepo: t?.kind === "event" ? (t.repo ?? "") : "",
    actionKind: a?.action.kind ?? "headless",
    prompt: a?.action.prompt ?? "",
    title: a?.action.title ?? "",
    agentId: a?.action.agentId ?? "",
    worktree: a?.action.worktree ?? "new",
  };
}

function fromForm(f: FormValue) {
  const trigger =
    f.triggerKind === "daily"
      ? { kind: "daily", time: f.time }
      : f.triggerKind === "interval"
        ? { kind: "interval", minutes: Number(f.minutes) }
        : f.triggerKind === "cron"
          ? { kind: "cron", expr: f.expr }
          : { kind: "event", event: f.event, runId: f.runId || undefined, repo: f.eventRepo || undefined };
  const action: Record<string, unknown> = { kind: f.actionKind, prompt: f.prompt };
  if (f.actionKind !== "headless") action.title = f.title;
  if (f.actionKind === "start-worker") Object.assign(action, { agentId: f.agentId, worktree: f.worktree });
  return { name: f.name, repo: f.repo, trigger, action };
}

function AutomationForm({ existing, onDone }: { existing?: Automation; onDone: (saved: boolean) => void }) {
  const [f, setF] = useState<FormValue>(() => toForm(existing));
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormValue>(key: K, value: FormValue[K]) => setF((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (f.actionKind !== "start-worker" || agents.length > 0) return;
    loadAgents()
      .then((list) => {
        setAgents(list);
        setF((prev) => (prev.agentId || !list[0] ? prev : { ...prev, agentId: list[0].id }));
      })
      .catch(() => {});
  }, [f.actionKind, agents.length]);

  return (
    <form
      className="au-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const body = fromForm(f);
        (existing ? apiPost("/update", { id: existing.id, ...body }) : apiPost("/create", body))
          .then(() => onDone(true))
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <label className="au-field">
        <span>Name</span>
        <input className="dialog-input" autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} />
      </label>

      <label className="au-field">
        <span>When</span>
        <select className="dialog-input" value={f.triggerKind} onChange={(e) => set("triggerKind", e.target.value as Trigger["kind"])}>
          <option value="daily">Every day at a time</option>
          <option value="interval">Every few minutes</option>
          <option value="cron">On a cron schedule</option>
          <option value="event">When something happens in Agent Tasks</option>
        </select>
      </label>
      {f.triggerKind === "daily" && (
        <label className="au-field">
          <span>Time (server clock)</span>
          <input className="dialog-input" type="time" value={f.time} onChange={(e) => set("time", e.target.value)} />
        </label>
      )}
      {f.triggerKind === "interval" && (
        <label className="au-field">
          <span>Minutes</span>
          <input className="dialog-input" type="number" min={1} value={f.minutes} onChange={(e) => set("minutes", e.target.value)} />
        </label>
      )}
      {f.triggerKind === "cron" && (
        <label className="au-field">
          <span>Cron (minute hour day month weekday)</span>
          <input className="dialog-input au-mono" value={f.expr} onChange={(e) => set("expr", e.target.value)} />
        </label>
      )}
      {f.triggerKind === "event" && (
        <>
          <label className="au-field">
            <span>Event</span>
            <select className="dialog-input" value={f.event} onChange={(e) => set("event", e.target.value as FormValue["event"])}>
              {EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {EVENT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="au-field">
            <span>Only for run id (optional)</span>
            <input className="dialog-input au-mono" value={f.runId} placeholder="run_..." onChange={(e) => set("runId", e.target.value)} />
          </label>
          <label className="au-field">
            <span>Only for repository (optional)</span>
            <input className="dialog-input" value={f.eventRepo} onChange={(e) => set("eventRepo", e.target.value)} />
          </label>
        </>
      )}
      {f.triggerKind !== "event" && <div className="au-hint">Checked every 15 seconds, so a run can start up to 15s late.</div>}

      <label className="au-field">
        <span>Do</span>
        <select className="dialog-input" value={f.actionKind} onChange={(e) => set("actionKind", e.target.value as ActionKind)}>
          <option value="headless">Ask the AI and keep the answer</option>
          <option value="create-task">Create an Agent Tasks task</option>
          <option value="start-worker">Create a task and start a worker on it</option>
        </select>
      </label>
      {f.actionKind !== "headless" && (
        <label className="au-field">
          <span>Task title (defaults to the name)</span>
          <input className="dialog-input" value={f.title} onChange={(e) => set("title", e.target.value)} />
        </label>
      )}
      <label className="au-field">
        <span>{f.actionKind === "headless" ? "Prompt" : "Task spec"}</span>
        <textarea className="dialog-input au-textarea" rows={4} value={f.prompt} onChange={(e) => set("prompt", e.target.value)} />
      </label>
      {f.actionKind === "start-worker" && (
        <>
          <label className="au-field">
            <span>Agent</span>
            <select className="dialog-input" value={f.agentId} onChange={(e) => set("agentId", e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="au-field">
            <span>Worktree</span>
            <select className="dialog-input" value={f.worktree} onChange={(e) => set("worktree", e.target.value)}>
              <option value="new">New worktree per run</option>
              <option value="current">The repository itself</option>
            </select>
          </label>
        </>
      )}
      <label className="au-field">
        <span>Repository{f.actionKind === "headless" ? " (working directory, optional)" : ""}</span>
        <input className="dialog-input" value={f.repo} placeholder="~/code/project" onChange={(e) => set("repo", e.target.value)} />
      </label>

      {error && <div className="au-error">{error}</div>}
      <div className="au-form-buttons">
        <button type="button" className="dialog-button secondary" onClick={() => onDone(false)}>
          Cancel
        </button>
        <button type="submit" className="dialog-button primary" disabled={busy || !f.name.trim() || !f.prompt.trim()}>
          {existing ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}

// ---- Panel ----

function AutomationsPanel({ actionsTarget, confirmDialog }: SidebarPanelHostProps) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    apiGet<ListResponse>("/list")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      const el = rootRef.current;
      if (document.visibilityState !== "visible" || !el || el.offsetParent === null) return;
      refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const post = (path: string, body: unknown) =>
    apiPost(path, body)
      .then(refresh)
      .catch((err: Error) => setError(err.message));

  const header = (
    <>
      <button type="button" className="icon-button" title="New automation" onClick={() => setEditing("new")}>
        <Icon name="add" />
      </button>
      <button type="button" className="icon-button" title="Refresh" onClick={refresh}>
        <Icon name="refresh" />
      </button>
    </>
  );

  return (
    <div className="au-panel" ref={rootRef}>
      {actionsTarget && createPortal(header, actionsTarget)}
      {error && <div className="au-error">{error}</div>}
      {editing === "new" && (
        <AutomationForm
          onDone={(saved) => {
            setEditing(null);
            if (saved) refresh();
          }}
        />
      )}
      {!data && !error && <div className="au-empty">Loading...</div>}
      {data?.automations.length === 0 && editing !== "new" && (
        <div className="au-empty">
          No automations yet.{" "}
          <button type="button" className="au-link" onClick={() => setEditing("new")}>
            Create one
          </button>
        </div>
      )}
      <ul className="au-list">
        {data?.automations.map((a) =>
          editing === a.id ? (
            <li key={a.id}>
              <AutomationForm
                existing={a}
                onDone={(saved) => {
                  setEditing(null);
                  if (saved) refresh();
                }}
              />
            </li>
          ) : (
            <li key={a.id} className={`au-row${a.enabled ? "" : " au-disabled"}`}>
              <div className="au-row-head">
                <input
                  type="checkbox"
                  className="au-toggle"
                  checked={a.enabled}
                  title={a.enabled ? "Enabled - click to disable" : "Disabled - click to enable"}
                  aria-label={`Enable ${a.name}`}
                  onChange={(e) => void post("/update", { id: a.id, enabled: e.target.checked })}
                />
                <button type="button" className="au-name" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                  {a.name}
                </button>
                <span className="au-actions">
                  <button
                    type="button"
                    className="icon-button"
                    title="Run now"
                    disabled={a.running}
                    onClick={() => void post(`/run/${encodeURIComponent(a.id)}`, {})}
                  >
                    <Icon name={a.running ? "loading" : "play"} className={a.running ? "codicon-modifier-spin" : ""} />
                  </button>
                  <button type="button" className="icon-button" title="Edit" onClick={() => setEditing(a.id)}>
                    <Icon name="edit" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="Delete"
                    onClick={async () => {
                      const ok = confirmDialog
                        ? await confirmDialog(`Delete the automation "${a.name}"?`, "Delete")
                        : window.confirm(`Delete the automation "${a.name}"?`);
                      if (ok) void post("/delete", { id: a.id });
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </span>
              </div>
              <div className="au-meta">
                {a.triggerSummary}
                {a.nextRunAt && a.enabled ? ` - next ${when(a.nextRunAt)}` : ""}
              </div>
              {a.needsAgentTasks && (
                <div className="au-note">Requires the Agent Tasks extension{data.agentTasks.error ? ` (${data.agentTasks.error})` : ""}.</div>
              )}
              {a.lastRunAt || a.lastStatus ? (
                <button
                  type="button"
                  className={`au-result au-status-${a.lastStatus ?? "none"}${expanded === a.id ? " au-expanded" : ""}`}
                  title="Show the whole result"
                  onClick={() => setExpanded(expanded === a.id ? null : a.id)}
                >
                  <span className="au-result-when">
                    {a.lastStatus ?? ""} {a.lastRunAt ? when(a.lastRunAt) : ""}
                    {a.runCount ? ` - ${a.runCount} run${a.runCount === 1 ? "" : "s"}` : ""}
                  </span>
                  {a.lastResult && <span className="au-result-text">{a.lastResult}</span>}
                </button>
              ) : (
                <div className="au-meta">Never run.</div>
              )}
            </li>
          ),
        )}
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
    component: (props: SidebarPanelHostProps) => ReturnType<typeof AutomationsPanel>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  app: { getActiveContext(): ActiveContext };
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  getActiveContext = ctx.app.getActiveContext;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerSidebarPanel({
    id: "list",
    title: "AUTOMATIONS",
    location: "run",
    icon: "watch",
    component: AutomationsPanel,
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  getActiveContext = null;
}
