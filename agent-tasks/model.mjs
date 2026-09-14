// agent-tasks' state machine, as pure functions over one store document. No
// tmux, no filesystem, no clock of its own (every "now" is a parameter), so
// every rule here is pinned by calling it - see src/model.test.ts, laid out
// the way agent-monitor's src/hookStatus.test.ts tests hookStatus.mjs.
//
// The document (store.mjs owns reading and writing it):
//
//   { version: 1, runs, tasks, dispatches, gates, messages }
//
// each an object keyed by id ("run_" / "task_" / "dsp_" / "gate_" / "msg_" +
// 12 hex). A task's status is never stored. It is computed here from the
// task's own outcome, its dependencies, its gates and its dispatches, so
// there is no second copy of it that could disagree - and the client only
// ever renders what the server computed (plans/agent-orchestration-and-
// automations.md, decision 4).
//
// Dispatches are keyed on the tmux pane id recorded at launch, never on a
// session or window name: a pane id survives renames, and it is the one
// identifier every agent's hook event carries.

export const TASK_STATUSES = ["pending", "ready", "dispatched", "blocked", "completed", "failed"];
export const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);
export const DISPATCH_STATES = ["active", "succeeded", "failed", "lost", "stopped"];
export const MESSAGE_TYPES = ["note", "status", "question", "answer", "escalation", "done"];
export const ACTIONS = ["start-worker", "stop-worker", "retry", "complete", "fail", "open-gate", "delete"];

// Where coordinator-bound messages are addressed. Everything else a message
// can be addressed to is a dispatch id, resolved from a handle at send time.
export const COORDINATOR = "coordinator";

export const MAX_MESSAGES_PER_RUN = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyDocument() {
  return { version: 1, runs: {}, tasks: {}, dispatches: {}, gates: {}, messages: {} };
}

// Tolerant: a hand-edited or partially written document still loads, with
// any missing collection defaulted rather than the whole file thrown away.
export function normalizeDocument(raw) {
  const doc = emptyDocument();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return doc;
  for (const key of ["runs", "tasks", "dispatches", "gates", "messages"]) {
    const value = raw[key];
    if (value && typeof value === "object" && !Array.isArray(value)) doc[key] = value;
  }
  return doc;
}

// ---- Lookups ----

function values(collection) {
  return Object.values(collection ?? {});
}

export function tasksOfRun(doc, runId) {
  return values(doc.tasks)
    .filter((t) => t.runId === runId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// The one dispatch that may act for a task, if any. At most one is active at
// a time (start-worker is not offered while one is), but should a document
// ever hold two, the newest wins - the older one is by definition stale.
export function activeDispatch(doc, taskId) {
  let best = null;
  for (const d of values(doc.dispatches)) {
    if (d.taskId !== taskId || d.state !== "active") continue;
    if (!best || d.startedAt > best.startedAt) best = d;
  }
  return best;
}

export function openGates(doc, taskId) {
  return values(doc.gates).filter((g) => g.taskId === taskId && g.state === "open");
}

// ---- Task status ----

// In priority order:
//   1. a recorded outcome (completed / failed) - terminal wins over everything;
//   2. an open gate, or a dependency that failed -> blocked;
//   3. an active dispatch -> dispatched;
//   4. every dependency completed (or none at all) -> ready;
//   5. otherwise pending.
// A dependency id that no longer exists (its task was deleted) counts as
// satisfied: holding a task pending forever on something nobody can finish is
// worse than letting the coordinator see it as ready.
export function taskStatus(doc, id) {
  const task = doc.tasks[id];
  if (!task) return null;
  if (task.outcome === "completed" || task.outcome === "failed") return task.outcome;
  const deps = (task.deps ?? []).map((depId) => doc.tasks[depId]).filter(Boolean);
  if (openGates(doc, id).length > 0) return "blocked";
  if (deps.some((dep) => dep.outcome === "failed")) return "blocked";
  if (activeDispatch(doc, id)) return "dispatched";
  if (deps.every((dep) => dep.outcome === "completed")) return "ready";
  return "pending";
}

// Why a task is blocked, for the panel - null when it is not.
export function blockedReason(doc, id) {
  if (taskStatus(doc, id) !== "blocked") return null;
  const gates = openGates(doc, id);
  if (gates.length > 0) return `Waiting on a decision: ${gates[0].question}`;
  const failed = (doc.tasks[id].deps ?? []).map((d) => doc.tasks[d]).filter((d) => d?.outcome === "failed");
  return failed.length > 0 ? `Dependency failed: ${failed.map((d) => d.title).join(", ")}` : null;
}

// Which buttons a task offers, computed here so the client never re-derives
// the state machine. A subset of ACTIONS, in that order.
export function allowedActions(doc, id) {
  const status = taskStatus(doc, id);
  if (!status) return [];
  const active = activeDispatch(doc, id);
  const allowed = new Set();
  switch (status) {
    case "ready":
      allowed.add("start-worker");
      break;
    case "dispatched":
      allowed.add("stop-worker");
      break;
    case "blocked":
      if (active) allowed.add("stop-worker");
      break;
    case "completed":
    case "failed":
      allowed.add("retry");
      break;
  }
  if (!TERMINAL_TASK_STATUSES.has(status)) {
    allowed.add("complete");
    allowed.add("fail");
    allowed.add("open-gate");
  }
  // Deleting a task with a live worker would orphan the worker's pane with
  // nothing tracking it: stop it first.
  if (!active) allowed.add("delete");
  return ACTIONS.filter((action) => allowed.has(action));
}

// Why `dispatchId` may not complete `taskId`, or null when it may. Only the
// task's active dispatch completes it: a dispatch that was lost, stopped or
// already finished is stale, and a stale worker's late `done` must never
// overwrite the outcome of whichever worker replaced it.
export function completeRejection(doc, taskId, dispatchId) {
  const task = doc.tasks[taskId];
  if (!task) return `no task ${taskId}`;
  if (task.outcome) return `task ${taskId} is already ${task.outcome}`;
  const dispatch = doc.dispatches[dispatchId];
  if (!dispatch) return `no dispatch ${dispatchId}`;
  if (dispatch.taskId !== taskId) return `dispatch ${dispatchId} does not belong to task ${taskId}`;
  if (dispatch.state !== "active") return `dispatch ${dispatchId} is ${dispatch.state}, not active`;
  const active = activeDispatch(doc, taskId);
  if (!active || active.id !== dispatchId) return `dispatch ${dispatchId} is not the task's active dispatch`;
  return null;
}

export function canComplete(doc, taskId, dispatchId) {
  return completeRejection(doc, taskId, dispatchId) === null;
}

// ---- Handles ----

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);

function normalizePath(p) {
  return typeof p === "string" ? p.replace(/\/+$/, "") : "";
}

// The active dispatches a message handle addresses, optionally within one run.
//
//   @all             every active dispatch
//   @idle            active dispatches whose agent is not busy: its pane is
//                    missing from `panes`, is back at a shell, or the agent
//                    is waiting on a question or a permission prompt
//   @<program>       active dispatches running that agent program (@claude)
//   @worktree:<path> active dispatches working in that worktree
//   @task:<id>       the task's active dispatch
//   dsp_...          that dispatch, when active
//
// `panes` is [{ id, command }] - host.sessions.listPanes rows, flattened.
export function resolveHandle(doc, handle, panes = [], runId) {
  if (typeof handle !== "string") return [];
  const h = handle.trim();
  let active = values(doc.dispatches).filter((d) => d.state === "active");
  if (runId) active = active.filter((d) => d.runId === runId);
  const sortByStart = (list) => list.sort((a, b) => a.startedAt - b.startedAt);
  if (h === "@all") return sortByStart(active);
  if (h === "@idle") {
    const byId = new Map(panes.map((p) => [p.id, p]));
    return sortByStart(
      active.filter((d) => {
        if (d.awaiting) return true;
        const pane = byId.get(d.paneId);
        if (!pane) return true;
        return SHELLS.has(String(pane.command ?? "").replace(/^-/, ""));
      }),
    );
  }
  if (h.startsWith("@worktree:")) {
    const target = normalizePath(h.slice("@worktree:".length));
    return sortByStart(active.filter((d) => normalizePath(d.worktreePath) === target));
  }
  if (h.startsWith("@task:")) {
    const taskId = h.slice("@task:".length);
    return active.filter((d) => d.taskId === taskId);
  }
  if (h.startsWith("dsp_")) return active.filter((d) => d.id === h);
  if (h.startsWith("@") && h.length > 1) {
    const program = h.slice(1);
    return sortByStart(active.filter((d) => d.program === program));
  }
  return [];
}

// ---- Messages ----

// The oldest unacknowledged message for `recipient` (the coordinator, or a
// dispatch id) in a run, optionally restricted to some message types. "Oldest
// first" is what makes `agent-task check` a queue rather than a feed.
export function nextDelivery(doc, runId, types, recipient = COORDINATOR) {
  const wanted = Array.isArray(types) && types.length > 0 ? new Set(types) : null;
  let best = null;
  for (const m of values(doc.messages)) {
    if (runId && m.runId !== runId) continue;
    if (m.to !== recipient || m.ackedAt) continue;
    if (wanted && !wanted.has(m.type)) continue;
    if (!best || m.createdAt < best.createdAt || (m.createdAt === best.createdAt && m.id < best.id)) best = m;
  }
  return best;
}

export function unackedCount(doc, recipient = COORDINATOR) {
  return values(doc.messages).filter((m) => m.to === recipient && !m.ackedAt).length;
}

// ---- Hooks ----

// The active dispatch recorded for a pane, if any - how a hook event (which
// knows only its $TMUX_PANE) finds the work it belongs to.
export function dispatchForPane(doc, paneId) {
  if (typeof paneId !== "string" || !paneId) return null;
  let best = null;
  for (const d of values(doc.dispatches)) {
    if (d.paneId !== paneId || d.state !== "active") continue;
    if (!best || d.startedAt > best.startedAt) best = d;
  }
  return best;
}

// ---- Transitions (what `subscribe` streams) ----

// What changed between two documents, in lifecycle terms. automations
// subscribes to exactly these:
//   task-completed / task-failed / task-blocked   a task entered that status
//   gate-opened                                    a gate appeared open
//   worker-lost                                    a dispatch became lost
// plus task-status for every other status change, so a subscriber can follow
// a task end to end without reading the whole store.
export function diffTransitions(before, after) {
  const out = [];
  for (const task of values(after.tasks)) {
    const was = before.tasks[task.id] ? taskStatus(before, task.id) : null;
    const now = taskStatus(after, task.id);
    if (was === now) continue;
    const base = { taskId: task.id, runId: task.runId, title: task.title, from: was, to: now };
    if (now === "completed") out.push({ type: "task-completed", ...base });
    else if (now === "failed") out.push({ type: "task-failed", ...base });
    else if (now === "blocked") out.push({ type: "task-blocked", ...base });
    else out.push({ type: "task-status", ...base });
  }
  for (const gate of values(after.gates)) {
    if (gate.state === "open" && before.gates[gate.id]?.state !== "open") {
      out.push({ type: "gate-opened", gateId: gate.id, taskId: gate.taskId, runId: gate.runId, question: gate.question });
    }
  }
  for (const d of values(after.dispatches)) {
    const was = before.dispatches[d.id]?.state ?? null;
    if (d.state === was) continue;
    out.push({ type: "dispatch-state", dispatchId: d.id, taskId: d.taskId, runId: d.runId, from: was, to: d.state });
    if (d.state === "lost") out.push({ type: "worker-lost", dispatchId: d.id, taskId: d.taskId, runId: d.runId });
  }
  return out;
}

// ---- Growth control (applied by store.mjs on every save) ----

// Keeps the newest MAX_MESSAGES_PER_RUN messages of each run, dropping the
// oldest. Mutates and returns `doc`.
export function pruneMessages(doc, max = MAX_MESSAGES_PER_RUN) {
  const byRun = new Map();
  for (const m of values(doc.messages)) {
    const list = byRun.get(m.runId) ?? [];
    list.push(m);
    byRun.set(m.runId, list);
  }
  for (const list of byRun.values()) {
    if (list.length <= max) continue;
    list.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    for (const m of list.slice(max)) delete doc.messages[m.id];
  }
  return doc;
}

// The newest timestamp anything in a run carries.
export function runLastActivity(doc, runId) {
  const run = doc.runs[runId];
  let newest = Math.max(run?.createdAt ?? 0, run?.updatedAt ?? 0);
  const bump = (n) => {
    if (typeof n === "number" && n > newest) newest = n;
  };
  for (const t of values(doc.tasks)) if (t.runId === runId) (bump(t.createdAt), bump(t.updatedAt));
  for (const d of values(doc.dispatches)) {
    if (d.runId === runId) (bump(d.startedAt), bump(d.endedAt), bump(d.lastHeartbeatAt));
  }
  for (const g of values(doc.gates)) if (g.runId === runId) (bump(g.createdAt), bump(g.resolvedAt));
  for (const m of values(doc.messages)) if (m.runId === runId) (bump(m.createdAt), bump(m.ackedAt));
  return newest;
}

// A run may be archived when every task in it is terminal, nothing in it is
// still live (an active dispatch, an open gate), and its newest activity is
// older than `archiveAfterDays`. A run with no tasks at all qualifies on age
// alone.
export function isArchivable(doc, runId, now, archiveAfterDays) {
  if (!doc.runs[runId]) return false;
  const days = Number(archiveAfterDays);
  if (!Number.isFinite(days) || days <= 0) return false;
  for (const t of values(doc.tasks)) {
    if (t.runId === runId && !TERMINAL_TASK_STATUSES.has(taskStatus(doc, t.id))) return false;
  }
  if (values(doc.dispatches).some((d) => d.runId === runId && d.state === "active")) return false;
  if (values(doc.gates).some((g) => g.runId === runId && g.state === "open")) return false;
  return now - runLastActivity(doc, runId) > days * DAY_MS;
}

// Removes one run and everything belonging to it from `doc`, returning the
// removed records as an archive entry. Mutates `doc`.
export function extractRun(doc, runId) {
  const entry = { run: doc.runs[runId], tasks: {}, dispatches: {}, gates: {}, messages: {} };
  delete doc.runs[runId];
  for (const key of ["tasks", "dispatches", "gates", "messages"]) {
    for (const record of values(doc[key])) {
      if (record.runId !== runId) continue;
      entry[key][record.id] = record;
      delete doc[key][record.id];
    }
  }
  return entry;
}

// Moves every archivable run out of `doc`. Mutates `doc`; returns the
// extracted entries keyed by run id.
export function splitArchivable(doc, now, archiveAfterDays) {
  const archived = {};
  for (const runId of Object.keys(doc.runs)) {
    if (isArchivable(doc, runId, now, archiveAfterDays)) archived[runId] = extractRun(doc, runId);
  }
  return archived;
}

// Puts an archive entry back. Mutates `doc`.
export function insertRun(doc, entry) {
  doc.runs[entry.run.id] = entry.run;
  for (const key of ["tasks", "dispatches", "gates", "messages"]) Object.assign(doc[key], entry[key] ?? {});
  return doc;
}

// ---- Decoration (what GET /state ships) ----

export function decorateTask(doc, id) {
  const task = doc.tasks[id];
  const active = activeDispatch(doc, id);
  return {
    ...task,
    status: taskStatus(doc, id),
    allowedActions: allowedActions(doc, id),
    blockedReason: blockedReason(doc, id),
    activeDispatchId: active?.id ?? null,
  };
}
