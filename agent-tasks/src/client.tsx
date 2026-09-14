// agent-tasks: the AGENT TASKS sidebar tab - INBOX (what workers reported),
// GATES (decisions they are waiting on) and TASKS (runs of dependency-ordered
// tasks, each with its worker). The server owns the state machine: every
// status, blocked reason and button here comes from GET /state, and the
// client only renders it and posts the action back
// (plans/agent-orchestration-and-automations.md, decision 4).
//
// Host hooks arrive via module-level bridge variables set once in activate(),
// the pattern every bundled-style extension uses.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import Icon from "./Icon";

// ---- Module-level host bridge ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface AppApi {
  getActiveContext(): ActiveContext;
  openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
  killSession(sessionName: string): void;
  setSidebarBadge(panelId: string, badge: number | null): void;
}

interface SidebarPanelHostProps {
  actionsTarget?: HTMLDivElement | null;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

const PANEL_ID = "board";
const POLL_MS = 3_000;
const BADGE_POLL_MS = 15_000;

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let app: AppApi | null = null;
let removeStylesheet: (() => void) | null = null;
let badgeTimer: ReturnType<typeof setInterval> | null = null;

// ---- Types (mirror server.js's /state) ----

type TaskStatus = "pending" | "ready" | "dispatched" | "blocked" | "completed" | "failed";
type Action = "start-worker" | "stop-worker" | "retry" | "complete" | "fail" | "open-gate" | "delete";

interface Run {
  id: string;
  objective: string;
  repo: string;
  createdAt: number;
}

interface Task {
  id: string;
  runId: string;
  title: string;
  spec: string;
  deps: string[];
  outcome: "completed" | "failed" | null;
  outcomeBody: string;
  status: TaskStatus;
  allowedActions: Action[];
  blockedReason: string | null;
  activeDispatchId: string | null;
}

interface Dispatch {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  agentLabel: string;
  sessionName: string;
  windowIndex: number;
  paneId: string;
  worktreePath: string;
  state: "active" | "succeeded" | "failed" | "lost" | "stopped";
  awaiting: string | null;
  startedAt: number;
  endedAt: number | null;
  lastStatus: string;
  completedBy: string | null;
  lostReason?: string;
}

interface Gate {
  id: string;
  runId: string;
  taskId: string;
  dispatchId: string | null;
  question: string;
  options: string[];
  state: "open" | "resolved";
  resolution: string | null;
  createdAt: number;
}

interface Message {
  id: string;
  runId: string;
  taskId: string | null;
  dispatchId: string | null;
  from: string;
  type: string;
  body: string;
  createdAt: number;
  ackedAt: number | null;
}

interface State {
  runs: Run[];
  tasks: Task[];
  dispatches: Dispatch[];
  gates: Gate[];
  inbox: Message[];
  unacked: number;
  socket: string | null;
  now: number;
}

interface Agent {
  id: string;
  label: string;
  hooks: boolean;
}

interface ArchivedRun extends Run {
  archivedAt: number;
  taskCount: number;
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

function setBadge(n: number) {
  app?.setSidebarBadge(PANEL_ID, n > 0 ? n : null);
}

// ---- Formatting ----

function elapsed(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

const ACTION_LABELS: Record<Action, string> = {
  "start-worker": "Start worker",
  "stop-worker": "Stop worker",
  retry: "Retry",
  complete: "Complete",
  fail: "Fail",
  "open-gate": "Hold for decision",
  delete: "Delete",
};

const ACTION_ICONS: Record<Action, string> = {
  "start-worker": "play",
  "stop-worker": "debug-stop",
  retry: "refresh",
  complete: "check",
  fail: "close",
  "open-gate": "question",
  delete: "trash",
};

// ---- Small pieces ----

function StatusChip({ status }: { status: TaskStatus }) {
  return <span className={`at-chip at-chip-${status}`}>{status}</span>;
}

function Section({
  title,
  count,
  open,
  onToggle,
  children,
  extra,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <div className="at-section">
      <div className="at-section-header">
        <button type="button" className="at-section-toggle" onClick={onToggle} aria-expanded={open}>
          <Icon name={open ? "chevron-down" : "chevron-right"} />
          <span>{title}</span>
          {count !== undefined && count > 0 && <span className="at-count">{count}</span>}
        </button>
        {extra}
      </div>
      {open && <div className="at-section-body">{children}</div>}
    </div>
  );
}

// ---- Forms ----

function RunForm({ onDone }: { onDone: () => void }) {
  const [objective, setObjective] = useState("");
  const [repo, setRepo] = useState(() => app?.getActiveContext().cwd ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="at-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        apiPost("/run-create", { objective, repo })
          .then(onDone)
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <label className="at-field">
        <span>Objective</span>
        <textarea
          className="dialog-input at-textarea"
          rows={2}
          autoFocus
          value={objective}
          placeholder="What this run should achieve"
          onChange={(e) => setObjective(e.target.value)}
        />
      </label>
      <label className="at-field">
        <span>Repository</span>
        <input className="dialog-input" value={repo} placeholder="~/code/project" onChange={(e) => setRepo(e.target.value)} />
      </label>
      {error && <div className="at-error">{error}</div>}
      <div className="at-form-buttons">
        <button type="button" className="dialog-button secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="dialog-button primary" disabled={busy || !objective.trim()}>
          Create run
        </button>
      </div>
    </form>
  );
}

function TaskForm({ run, tasks, onDone }: { run: Run; tasks: Task[]; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="at-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        apiPost("/task-create", { runId: run.id, title, spec, deps })
          .then(onDone)
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <label className="at-field">
        <span>Title</span>
        <input className="dialog-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="at-field">
        <span>Spec</span>
        <textarea
          className="dialog-input at-textarea"
          rows={4}
          value={spec}
          placeholder="What the worker should do, and how to know it is done"
          onChange={(e) => setSpec(e.target.value)}
        />
      </label>
      {tasks.length > 0 && (
        <fieldset className="at-field at-deps">
          <span>Depends on</span>
          {tasks.map((t) => (
            <label key={t.id} className="at-check">
              <input
                type="checkbox"
                checked={deps.includes(t.id)}
                onChange={(e) => setDeps((d) => (e.target.checked ? [...d, t.id] : d.filter((x) => x !== t.id)))}
              />
              <span>{t.title}</span>
            </label>
          ))}
        </fieldset>
      )}
      {error && <div className="at-error">{error}</div>}
      <div className="at-form-buttons">
        <button type="button" className="dialog-button secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="dialog-button primary" disabled={busy || !title.trim()}>
          Add task
        </button>
      </div>
    </form>
  );
}

function WorkerForm({ task, run, onDone }: { task: Task; run: Run | undefined; onDone: () => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentId, setAgentId] = useState("");
  const [mode, setMode] = useState<"current" | "new" | "path">(run?.repo ? "new" : "path");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<{ agents: Agent[] }>("/agents")
      .then((r) => {
        setAgents(r.agents);
        if (r.agents[0]) setAgentId(r.agents[0].id);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const agent = agents?.find((a) => a.id === agentId);
  return (
    <form
      className="at-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        apiPost("/worker-start", { taskId: task.id, agentId, worktree: mode === "path" ? path : mode })
          .then(onDone)
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <label className="at-field">
        <span>Agent</span>
        <select className="dialog-input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {(agents ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      {agents && agents.length === 0 && (
        <div className="at-note">No agents are enabled. Add one in Settings - AI Providers.</div>
      )}
      {agent && !agent.hooks && (
        <div className="at-note">This agent has no hooks: its worker finishes only through agent-task done or the liveness sweep.</div>
      )}
      <label className="at-field">
        <span>Worktree</span>
        <select className="dialog-input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="new" disabled={!run?.repo}>
            New worktree for this task
          </option>
          <option value="current" disabled={!run?.repo}>
            The run's repository
          </option>
          <option value="path">A directory...</option>
        </select>
      </label>
      {mode === "path" && (
        <label className="at-field">
          <span>Directory</span>
          <input className="dialog-input" value={path} placeholder="~/code/project" onChange={(e) => setPath(e.target.value)} />
        </label>
      )}
      {error && <div className="at-error">{error}</div>}
      <div className="at-form-buttons">
        <button type="button" className="dialog-button secondary" onClick={onDone}>
          Cancel
        </button>
        <button
          type="submit"
          className="dialog-button primary"
          disabled={busy || !agentId || (mode === "path" && !path.trim())}
        >
          {busy ? "Starting..." : "Start"}
        </button>
      </div>
    </form>
  );
}

function GateForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="at-form"
      onSubmit={(e) => {
        e.preventDefault();
        apiPost("/gate-create", { taskId: task.id, question, options })
          .then(onDone)
          .catch((err: Error) => setError(err.message));
      }}
    >
      <label className="at-field">
        <span>Question</span>
        <input className="dialog-input" autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <label className="at-field">
        <span>Options (comma separated, optional)</span>
        <input className="dialog-input" value={options} onChange={(e) => setOptions(e.target.value)} />
      </label>
      {error && <div className="at-error">{error}</div>}
      <div className="at-form-buttons">
        <button type="button" className="dialog-button secondary" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="dialog-button primary" disabled={!question.trim()}>
          Hold task
        </button>
      </div>
    </form>
  );
}

// ---- Rows ----

function GateRow({ gate, task, onChanged }: { gate: Gate; task: Task | undefined; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const resolve = (resolution: string) =>
    apiPost("/gate-resolve", { gateId: gate.id, resolution })
      .then(onChanged)
      .catch((err: Error) => setError(err.message));
  return (
    <li className="at-gate">
      <div className="at-gate-question">{gate.question}</div>
      <div className="at-meta">
        {task ? task.title : gate.taskId}
        {gate.dispatchId ? " - asked by its worker" : " - held from the panel"}
      </div>
      {gate.options.length > 0 && (
        <div className="at-gate-options">
          {gate.options.map((option) => (
            <button key={option} type="button" className="dialog-button secondary at-small" onClick={() => void resolve(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
      <form
        className="at-gate-free"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void resolve(text.trim());
        }}
      >
        <input className="dialog-input" value={text} placeholder="Answer" onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="dialog-button primary at-small" disabled={!text.trim()}>
          Resolve
        </button>
      </form>
      {error && <div className="at-error">{error}</div>}
    </li>
  );
}

function TaskRow({
  task,
  tasksById,
  dispatch,
  run,
  now,
  confirm,
  onChanged,
}: {
  task: Task;
  tasksById: Map<string, Task>;
  dispatch: Dispatch | undefined;
  run: Run | undefined;
  now: number;
  confirm: (message: string, label?: string) => Promise<boolean>;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<"worker" | "gate" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: Action) => {
    setError(null);
    try {
      if (action === "start-worker") return setForm("worker");
      if (action === "open-gate") return setForm("gate");
      if (action === "stop-worker") {
        const session = dispatch?.sessionName;
        const ok = await confirm(
          `Stop the worker for "${task.title}"${session ? ` and kill its session ${session}` : ""}? The task goes back to ready.`,
          "Stop worker",
        );
        if (!ok) return;
        const result = await apiPost<{ sessionName: string }>("/worker-stop", { taskId: task.id });
        if (result.sessionName) app?.killSession(result.sessionName);
      } else if (action === "delete") {
        if (!(await confirm(`Delete the task "${task.title}"?`, "Delete"))) return;
        await apiPost("/task-delete", { taskId: task.id });
      } else {
        await apiPost("/task-update", { taskId: task.id, action });
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deps = task.deps.map((id) => tasksById.get(id)).filter((t): t is Task => Boolean(t));
  return (
    <li className={`at-task at-task-${task.status}`}>
      <div className="at-task-head">
        <StatusChip status={task.status} />
        <span className="at-task-title" title={task.spec || task.title}>
          {task.title}
        </span>
      </div>
      {deps.length > 0 && (
        <div className="at-meta">
          after{" "}
          {deps.map((d, i) => (
            <span key={d.id} className={`at-dep at-dep-${d.status}`}>
              {i > 0 ? ", " : ""}
              {d.title}
            </span>
          ))}
        </div>
      )}
      {task.blockedReason && <div className="at-meta at-blocked">{task.blockedReason}</div>}
      {dispatch && dispatch.state === "active" && (
        <div className="at-dispatch">
          <Icon name={dispatch.awaiting ? "bell" : "loading"} className={dispatch.awaiting ? "" : "codicon-modifier-spin"} />
          <span>
            {dispatch.agentLabel} - {elapsed(dispatch.startedAt, now)}
            {dispatch.awaiting ? ` - waiting on a ${dispatch.awaiting}` : ""}
            {dispatch.lastStatus ? ` - ${dispatch.lastStatus}` : ""}
          </span>
          <button
            type="button"
            className="icon-button"
            title={`Open session ${dispatch.sessionName}`}
            onClick={() => app?.openSessionWindow(dispatch.sessionName)}
          >
            <Icon name="terminal" />
          </button>
        </div>
      )}
      {task.outcome && task.outcomeBody && <div className="at-meta at-outcome">{task.outcomeBody}</div>}
      <div className="at-actions">
        {task.allowedActions.map((action) => (
          <button
            key={action}
            type="button"
            className={`at-action at-action-${action}`}
            title={ACTION_LABELS[action]}
            onClick={() => void act(action)}
          >
            <Icon name={ACTION_ICONS[action]} />
            <span className="at-action-label">{ACTION_LABELS[action]}</span>
          </button>
        ))}
      </div>
      {error && <div className="at-error">{error}</div>}
      {form === "worker" && (
        <WorkerForm
          task={task}
          run={run}
          onDone={() => {
            setForm(null);
            onChanged();
          }}
        />
      )}
      {form === "gate" && (
        <GateForm
          task={task}
          onDone={() => {
            setForm(null);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

function ArchivedRuns({ onRestored }: { onRestored: () => void }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<ArchivedRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    apiGet<{ runs: ArchivedRun[] }>("/archive")
      .then((r) => setRuns(r.runs))
      .catch((err: Error) => setError(err.message));
  }, []);
  return (
    <Section
      title="ARCHIVED RUNS"
      open={open}
      onToggle={() => {
        if (!open) load();
        setOpen(!open);
      }}
    >
      {error && <div className="at-error">{error}</div>}
      {runs === null && !error && <div className="at-empty">Loading...</div>}
      {runs?.length === 0 && <div className="at-empty">Nothing archived.</div>}
      <ul className="at-list">
        {runs?.map((run) => (
          <li key={run.id} className="at-row">
            <span className="at-row-main">
              <span className="at-run-objective">{run.objective}</span>
              <span className="at-meta">
                {run.taskCount} tasks - archived {new Date(run.archivedAt).toLocaleDateString()}
              </span>
            </span>
            <button
              type="button"
              className="dialog-button secondary at-small"
              onClick={() =>
                apiPost("/archive-restore", { runId: run.id })
                  .then(() => {
                    load();
                    onRestored();
                  })
                  .catch((err: Error) => setError(err.message))
              }
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---- Panel ----

function AgentTasksPanel({ actionsTarget, confirmDialog }: SidebarPanelHostProps) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState({ inbox: true, gates: true, tasks: true });
  const [newRun, setNewRun] = useState(false);
  const [addingTaskTo, setAddingTaskTo] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const confirm = useCallback(
    (message: string, label?: string) => (confirmDialog ? confirmDialog(message, label) : Promise.resolve(window.confirm(message))),
    [confirmDialog],
  );

  const refresh = useCallback(() => {
    apiGet<State>("/state")
      .then((s) => {
        setState(s);
        setError(null);
        setBadge(s.unacked);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  // Poll only while the panel is actually on screen: a hidden tab stays
  // mounted, and the badge has its own slower poll (see activate).
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      const el = rootRef.current;
      if (document.visibilityState !== "visible" || !el || el.offsetParent === null) return;
      refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const tasksById = useMemo(() => new Map((state?.tasks ?? []).map((t) => [t.id, t])), [state]);
  const dispatchById = useMemo(() => new Map((state?.dispatches ?? []).map((d) => [d.id, d])), [state]);
  const openGates = (state?.gates ?? []).filter((g) => g.state === "open");

  const header = (
    <>
      <button type="button" className="icon-button" title="New run" onClick={() => setNewRun(true)}>
        <Icon name="add" />
      </button>
      <button type="button" className="icon-button" title="Refresh" onClick={refresh}>
        <Icon name="refresh" />
      </button>
    </>
  );

  if (!state) {
    return (
      <div className="at-panel" ref={rootRef}>
        {actionsTarget && createPortal(header, actionsTarget)}
        {error ? <div className="at-error">{error}</div> : <div className="at-empty">Loading...</div>}
      </div>
    );
  }

  const ack = (body: unknown) =>
    apiPost("/message-ack", body)
      .then(refresh)
      .catch((err: Error) => setError(err.message));

  return (
    <div className="at-panel" ref={rootRef}>
      {actionsTarget && createPortal(header, actionsTarget)}
      {error && <div className="at-error">{error}</div>}
      {!state.socket && (
        <div className="at-note">The control socket is not listening yet, so workers cannot report back.</div>
      )}

      <Section
        title="INBOX"
        count={state.unacked}
        open={open.inbox}
        onToggle={() => setOpen((o) => ({ ...o, inbox: !o.inbox }))}
        extra={
          state.unacked > 0 ? (
            <button type="button" className="icon-button" title="Acknowledge all" onClick={() => void ack({ all: true })}>
              <Icon name="check-all" />
            </button>
          ) : undefined
        }
      >
        {state.inbox.length === 0 && <div className="at-empty">Nothing from workers yet.</div>}
        <ul className="at-list">
          {state.inbox.map((m) => {
            const dispatch = m.dispatchId ? dispatchById.get(m.dispatchId) : undefined;
            const task = m.taskId ? tasksById.get(m.taskId) : undefined;
            return (
              <li key={m.id} className={`at-message${m.ackedAt ? " at-acked" : ""}`}>
                <div className="at-message-head">
                  <span className={`at-type at-type-${m.type}`}>{m.type}</span>
                  <span className="at-meta">
                    {task?.title ?? ""} {elapsed(m.createdAt, state.now)} ago
                  </span>
                  <span className="at-message-actions">
                    {dispatch?.state === "active" && (
                      <button
                        type="button"
                        className="icon-button"
                        title={`Open session ${dispatch.sessionName}`}
                        onClick={() => app?.openSessionWindow(dispatch.sessionName)}
                      >
                        <Icon name="terminal" />
                      </button>
                    )}
                    {!m.ackedAt && (
                      <button type="button" className="icon-button" title="Acknowledge" onClick={() => void ack({ messageId: m.id })}>
                        <Icon name="check" />
                      </button>
                    )}
                  </span>
                </div>
                <div className="at-message-body">{m.body}</div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="GATES" count={openGates.length} open={open.gates} onToggle={() => setOpen((o) => ({ ...o, gates: !o.gates }))}>
        {openGates.length === 0 && <div className="at-empty">No decisions waiting.</div>}
        <ul className="at-list">
          {openGates.map((g) => (
            <GateRow key={g.id} gate={g} task={tasksById.get(g.taskId)} onChanged={refresh} />
          ))}
        </ul>
      </Section>

      <Section title="TASKS" open={open.tasks} onToggle={() => setOpen((o) => ({ ...o, tasks: !o.tasks }))}>
        {newRun && (
          <RunForm
            onDone={() => {
              setNewRun(false);
              refresh();
            }}
          />
        )}
        {state.runs.length === 0 && !newRun && (
          <div className="at-empty">
            No runs yet.{" "}
            <button type="button" className="at-link" onClick={() => setNewRun(true)}>
              Create one
            </button>
          </div>
        )}
        {state.runs.map((run) => {
          const tasks = state.tasks.filter((t) => t.runId === run.id);
          return (
            <div key={run.id} className="at-run">
              <div className="at-run-head">
                <span className="at-row-main">
                  <span className="at-run-objective">{run.objective}</span>
                  {run.repo && <span className="at-meta">{run.repo}</span>}
                </span>
                <button type="button" className="icon-button" title="Add task" onClick={() => setAddingTaskTo(run.id)}>
                  <Icon name="add" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Delete run"
                  onClick={async () => {
                    if (!(await confirm(`Delete the run "${run.objective}" and all its tasks?`, "Delete"))) return;
                    apiPost("/run-delete", { runId: run.id })
                      .then(refresh)
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
              {addingTaskTo === run.id && (
                <TaskForm
                  run={run}
                  tasks={tasks}
                  onDone={() => {
                    setAddingTaskTo(null);
                    refresh();
                  }}
                />
              )}
              {tasks.length === 0 && addingTaskTo !== run.id && <div className="at-empty">No tasks in this run.</div>}
              <ul className="at-list">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    tasksById={tasksById}
                    dispatch={task.activeDispatchId ? dispatchById.get(task.activeDispatchId) : undefined}
                    run={run}
                    now={state.now}
                    confirm={confirm}
                    onChanged={refresh}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </Section>

      <ArchivedRuns onRestored={refresh} />
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
    component: (props: SidebarPanelHostProps) => ReturnType<typeof AgentTasksPanel>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  app: AppApi;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  app = ctx.app;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: PANEL_ID,
    title: "AGENT TASKS",
    location: "tab",
    icon: "checklist",
    component: AgentTasksPanel,
  });

  // The badge must stay right while the tab is closed, which is when it
  // matters most.
  const pollBadge = () =>
    apiGet<{ unacked: number }>("/unacked")
      .then((r) => setBadge(r.unacked))
      .catch(() => {});
  void pollBadge();
  badgeTimer = setInterval(pollBadge, BADGE_POLL_MS);
}

export function deactivate(): void {
  if (badgeTimer) clearInterval(badgeTimer);
  badgeTimer = null;
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  app = null;
}
