// agent-tasks server hook: the orchestration layer behind the AGENT TASKS
// panel. Runs hold dependency-ordered tasks; a task is worked by a dispatch -
// one agent, launched into its own tmux session (and optionally its own
// worktree), tracked by the tmux pane id recorded at launch.
//
//   model.mjs     the state machine, pure and unit-tested
//   store.mjs     the durable JSON document (0600, atomic, serialized writes)
//   control.mjs   the 0600 unix socket workers and automations speak to
//   preamble.mjs  the brief a worker's agent is given
//   this file     HTTP routes for the panel, the socket verbs, worker launch,
//                 the agent-hook subscription and the liveness sweep
//
// A worker finishes one of three ways, in the order they are trusted:
//   1. its agent's own `stop` hook, delivered by core (host.agentHooks) and
//      matched to the dispatch by pane id - needs the agent's hooks installed
//      in Settings -> AI Providers;
//   2. `agent-task done`, run by the agent itself from the pane, as the brief
//      tells it to;
//   3. neither: the sweep marks it lost when its pane is gone or it has been
//      silent for longer than agentTasks.heartbeatTimeoutSeconds, and the task
//      goes back to ready for the coordinator to decide. Never auto-retried.
//
// Every async entry point - routes, socket verbs, the sweep tick, the hook
// callback, the background preamble - catches its own errors. Newer cores
// turn a rejected route into a 500 by themselves, but this extension may run
// on one that exits the whole server instead.
import { copyFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ControlError, createControlServer } from "./control.mjs";
import {
  COORDINATOR,
  activeDispatch,
  allowedActions,
  completeRejection,
  decorateTask,
  diffTransitions,
  dispatchForPane,
  nextDelivery,
  resolveHandle,
  taskStatus,
  unackedCount,
} from "./model.mjs";
import { buildPreamble, buildPreambleLine } from "./preamble.mjs";
import { createStore, newId } from "./store.mjs";

const SWEEP_INTERVAL_MS = 15_000;
const CHECK_WAIT_MAX_MS = 10 * 60 * 1000;
const PREAMBLE_WAIT_MS = 20_000;
const PREAMBLE_SETTLE_MS = 2_000;
const LAUNCH_SETTLE_MS = 600;
const INBOX_LIMIT = 200;
const TITLE_MAX = 200;
const SPEC_MAX = 20_000;
const BODY_MAX = 20_000;

const HOME = homedir();
const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "tmux-server");
const socketPath = path.join(configDir, "agent-tasks", "control.sock");
const binDir = path.join(configDir, "bin");
const cliPath = path.join(binDir, "agent-task");
const cliSource = path.join(import.meta.dirname, "cli", "agent-task");

// ---- Errors and wrapping ----

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);
const notFound = (message) => new HttpError(404, message);
const conflict = (message) => new HttpError(409, message);

// Turns a rejection into `res.status(...).json({ error })`. Every route below
// goes through it; none is registered as a bare async function.
function wrap(fn, log) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        const status = typeof err?.status === "number" ? err.status : 500;
        if (status >= 500) log?.("route failed:", req.method, req.originalUrl, err?.stack ?? err);
        if (!res.headersSent) res.status(status).json({ error: err?.message ?? String(err) });
      });
  };
}

// ---- Small helpers ----

function expandHome(p) {
  if (p === "~") return HOME;
  if (typeof p === "string" && p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

function shortenHome(p) {
  if (typeof p === "string" && HOME && (p === HOME || p.startsWith(`${HOME}/`))) return `~${p.slice(HOME.length)}`;
  return p;
}

function str(value, name, { required = false, max = TITLE_MAX } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw bad(`${name} is required`);
    return "";
  }
  if (typeof value !== "string") throw bad(`${name} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw bad(`${name} is required`);
  if (trimmed.length > max) throw bad(`${name} is longer than ${max} characters`);
  return trimmed;
}

function idList(value, name) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  const ids = list.map((v) => String(v).trim()).filter(Boolean);
  for (const id of ids) if (!/^[a-z]+_[0-9a-f]{12}$/.test(id)) throw bad(`${name}: "${id}" is not an id`);
  return [...new Set(ids)];
}

function optionList(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((v) => String(v).trim()).filter(Boolean).slice(0, 10);
}

function bool(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Lowercased, non-alphanumerics to "-", capped at 48, suffixed with the short
// task id so two tasks with the same title never collide on a branch.
function branchNameFor(task) {
  const slug =
    String(task.title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "task";
  return `${slug}-${task.id.slice(-6)}`;
}

async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// ---- Module state ----
// The module stays resident across a disable -> enable cycle, and activate()
// runs again on it. Everything started per activation lives in `current` and
// is torn down before the next one starts, so a second activate() never
// double-binds the socket or double-schedules the sweep.

let store = null;
let current = null;

function getStore(getSettings) {
  if (!store) {
    store = createStore(configDir, {
      archiveAfterDays: async () => {
        const settings = await getSettings().catch(() => ({}));
        return settings["agentTasks.archiveAfterDays"];
      },
    });
  }
  return store;
}

async function teardown(instance) {
  if (!instance) return;
  instance.stopped = true;
  clearInterval(instance.sweepTimer);
  for (const off of [...instance.cleanups]) {
    try {
      off();
    } catch {
      // best effort
    }
  }
  instance.cleanups.clear();
  await instance.control.stop().catch((err) => instance.log("control socket stop failed:", err));
}

// Called by a core that tears server hooks down on unmount. On a core that
// does not, the next activate() does the same teardown first.
export async function deactivate() {
  const instance = current;
  current = null;
  await teardown(instance);
}

export function activate({ router, log = console.log, getSettings, host }) {
  const s = getStore(getSettings);
  const instance = { stopped: false, sweepTimer: null, cleanups: new Set(), control: null, log };
  const previous = current;
  current = instance;

  async function settings() {
    const raw = await getSettings().catch(() => ({}));
    const timeout = Number(raw["agentTasks.heartbeatTimeoutSeconds"]);
    return {
      worktreeLocation:
        typeof raw["agentTasks.worktreeLocation"] === "string" && raw["agentTasks.worktreeLocation"].trim()
          ? raw["agentTasks.worktreeLocation"].trim()
          : "{repo}/.worktrees/{branch}",
      heartbeatTimeoutMs: (Number.isFinite(timeout) ? Math.min(3600, Math.max(60, timeout)) : 600) * 1000,
      autoSubmitPreamble: raw["agentTasks.autoSubmitPreamble"] === true,
    };
  }

  // ---- Operations, shared by the HTTP routes and the socket verbs ----

  async function createRun(body) {
    const objective = str(body.objective, "objective", { required: true, max: SPEC_MAX });
    const repoRaw = str(body.repo, "repo", { max: 4096 });
    const repo = repoRaw ? expandHome(repoRaw) : "";
    if (repo && !(await isDirectory(repo))) throw bad(`repo ${repoRaw} is not a directory`);
    const now = Date.now();
    const run = { id: newId("run"), objective, repo, createdAt: now, updatedAt: now };
    await s.update((doc) => {
      doc.runs[run.id] = run;
    });
    return { runId: run.id, run };
  }

  async function createTask(body) {
    let runId = str(body.runId, "runId");
    if (!runId && body.objective) runId = (await createRun({ objective: body.objective, repo: body.repo })).runId;
    if (!runId) throw bad("runId is required (or objective, to create a run for this task)");
    const title = str(body.title, "title", { required: true });
    const spec = str(body.spec, "spec", { max: SPEC_MAX });
    const deps = idList(body.deps, "deps");
    const now = Date.now();
    const task = { id: newId("task"), runId, title, spec, deps, outcome: null, outcomeBody: "", createdAt: now, updatedAt: now };
    await s.update((doc) => {
      if (!doc.runs[runId]) throw notFound(`no run ${runId}`);
      for (const dep of deps) {
        if (doc.tasks[dep]?.runId !== runId) throw bad(`dependency ${dep} is not a task in run ${runId}`);
      }
      doc.tasks[task.id] = task;
      doc.runs[runId].updatedAt = now;
    });
    return { taskId: task.id, runId, task };
  }

  function dependsOn(doc, from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (doc.tasks[from]?.deps ?? []).some((dep) => dependsOn(doc, dep, target, seen));
  }

  function requireAction(doc, taskId, action) {
    if (!doc.tasks[taskId]) throw notFound(`no task ${taskId}`);
    if (!allowedActions(doc, taskId).includes(action)) {
      throw conflict(`"${action}" is not allowed while task ${taskId} is ${taskStatus(doc, taskId)}`);
    }
  }

  function fileMessage(doc, fields) {
    const message = {
      id: newId("msg"),
      from: "system",
      to: COORDINATOR,
      type: "note",
      body: "",
      createdAt: Date.now(),
      ackedAt: null,
      ...fields,
    };
    doc.messages[message.id] = message;
    return message;
  }

  function endDispatch(doc, dispatch, state, extra = {}) {
    const now = Date.now();
    Object.assign(dispatch, { state, endedAt: now, awaiting: null, ...extra });
    if (doc.runs[dispatch.runId]) doc.runs[dispatch.runId].updatedAt = now;
  }

  // Manual transitions from the panel. A coordinator completing or failing a
  // task ends any live dispatch for it as "stopped": the worker did not
  // finish it, the coordinator did.
  async function updateTask(body) {
    const taskId = str(body.taskId, "taskId", { required: true });
    const action = str(body.action, "action");
    return s.update((doc) => {
      const task = doc.tasks[taskId];
      if (!task) throw notFound(`no task ${taskId}`);
      const now = Date.now();
      if (action) {
        if (!["complete", "fail", "retry"].includes(action)) throw bad(`action must be complete, fail or retry`);
        requireAction(doc, taskId, action);
        if (action === "retry") {
          task.outcome = null;
          task.outcomeBody = "";
        } else {
          const active = activeDispatch(doc, taskId);
          if (active) endDispatch(doc, active, "stopped");
          task.outcome = action === "complete" ? "completed" : "failed";
          task.outcomeBody = str(body.body, "body", { max: BODY_MAX }) || `Marked ${task.outcome} from the panel.`;
        }
      }
      if (body.title !== undefined) task.title = str(body.title, "title", { required: true });
      if (body.spec !== undefined) task.spec = str(body.spec, "spec", { max: SPEC_MAX });
      if (body.deps !== undefined) {
        const deps = idList(body.deps, "deps");
        for (const dep of deps) {
          if (doc.tasks[dep]?.runId !== task.runId) throw bad(`dependency ${dep} is not a task in this run`);
          if (dependsOn(doc, dep, taskId)) throw bad(`depending on ${dep} would create a cycle`);
        }
        task.deps = deps;
      }
      task.updatedAt = now;
      if (doc.runs[task.runId]) doc.runs[task.runId].updatedAt = now;
      return { task: decorateTask(doc, taskId) };
    });
  }

  async function deleteTask(body) {
    const taskId = str(body.taskId, "taskId", { required: true });
    return s.update((doc) => {
      requireAction(doc, taskId, "delete");
      const { runId } = doc.tasks[taskId];
      delete doc.tasks[taskId];
      for (const other of Object.values(doc.tasks)) {
        if (other.deps?.includes(taskId)) other.deps = other.deps.filter((d) => d !== taskId);
      }
      for (const gate of Object.values(doc.gates)) if (gate.taskId === taskId) delete doc.gates[gate.id];
      if (doc.runs[runId]) doc.runs[runId].updatedAt = Date.now();
      return { deleted: taskId };
    });
  }

  async function deleteRun(body) {
    const runId = str(body.runId, "runId", { required: true });
    return s.update((doc) => {
      if (!doc.runs[runId]) throw notFound(`no run ${runId}`);
      if (Object.values(doc.dispatches).some((d) => d.runId === runId && d.state === "active")) {
        throw conflict("stop this run's workers before deleting it");
      }
      for (const key of ["tasks", "dispatches", "gates", "messages"]) {
        for (const record of Object.values(doc[key])) if (record.runId === runId) delete doc[key][record.id];
      }
      delete doc.runs[runId];
      return { deleted: runId };
    });
  }

  async function createGate(body, { fromDispatch = null } = {}) {
    const question = str(body.question, "question", { required: true, max: BODY_MAX });
    const options = optionList(body.options);
    return s.update((doc) => {
      const taskId = fromDispatch ? fromDispatch.taskId : str(body.taskId, "taskId", { required: true });
      const task = doc.tasks[taskId];
      if (!task) throw notFound(`no task ${taskId}`);
      if (!fromDispatch) requireAction(doc, taskId, "open-gate");
      const now = Date.now();
      const gate = {
        id: newId("gate"),
        runId: task.runId,
        taskId,
        dispatchId: fromDispatch?.id ?? null,
        question,
        options,
        state: "open",
        resolution: null,
        createdAt: now,
        resolvedAt: null,
      };
      doc.gates[gate.id] = gate;
      if (fromDispatch) {
        doc.dispatches[fromDispatch.id].awaiting = "question";
        doc.dispatches[fromDispatch.id].lastHeartbeatAt = now;
        fileMessage(doc, {
          runId: task.runId,
          taskId,
          dispatchId: fromDispatch.id,
          from: fromDispatch.id,
          type: "question",
          gateId: gate.id,
          body: question,
        });
      }
      doc.runs[task.runId].updatedAt = now;
      return { gateId: gate.id, gate };
    });
  }

  // Resolving a gate a worker opened answers that worker: the resolution is
  // queued for its `agent-task check`, and the question in the inbox is
  // acknowledged, since it has been dealt with.
  async function resolveGate(body) {
    const gateId = str(body.gateId, "gateId", { required: true });
    const resolution = str(body.resolution, "resolution", { required: true, max: BODY_MAX });
    return s.update((doc) => {
      const gate = doc.gates[gateId];
      if (!gate) throw notFound(`no gate ${gateId}`);
      if (gate.state !== "open") throw conflict(`gate ${gateId} is already resolved`);
      const now = Date.now();
      Object.assign(gate, { state: "resolved", resolution, resolvedAt: now });
      const dispatch = gate.dispatchId ? doc.dispatches[gate.dispatchId] : null;
      if (dispatch?.state === "active") {
        dispatch.awaiting = null;
        fileMessage(doc, {
          runId: gate.runId,
          taskId: gate.taskId,
          dispatchId: dispatch.id,
          from: COORDINATOR,
          to: dispatch.id,
          type: "answer",
          gateId,
          body: `Q: ${gate.question}\nA: ${resolution}`,
        });
      }
      for (const m of Object.values(doc.messages)) {
        if (m.gateId === gateId && m.to === COORDINATOR && !m.ackedAt) m.ackedAt = now;
      }
      if (doc.runs[gate.runId]) doc.runs[gate.runId].updatedAt = now;
      return { gate };
    });
  }

  async function ackMessages(body) {
    const ids = idList(body.messageIds ?? body.messageId, "messageIds");
    const all = bool(body.all);
    if (!all && ids.length === 0) throw bad("messageId (or all: true) is required");
    return s.update((doc) => {
      const now = Date.now();
      let acked = 0;
      for (const m of Object.values(doc.messages)) {
        if (m.to !== COORDINATOR || m.ackedAt) continue;
        if (all ? !body.runId || m.runId === body.runId : ids.includes(m.id)) {
          m.ackedAt = now;
          acked++;
        }
      }
      return { acked, unacked: unackedCount(doc) };
    });
  }

  // Every pane tmux knows, by id. `certain` is false when some session could
  // not be listed - a session renamed between the two calls looks exactly
  // like one that died, and the sweep must not mark a live worker lost over
  // that race.
  async function allPanes() {
    const sessions = await host.sessions.list();
    const panes = new Map();
    let certain = true;
    await Promise.all(
      sessions.map(async (session) => {
        try {
          for (const pane of await host.sessions.listPanes(session.name)) {
            panes.set(pane.id, { ...pane, sessionName: session.name });
          }
        } catch {
          certain = false;
        }
      }),
    );
    return { panes, certain };
  }

  async function listAgents() {
    const agents = (await host.agents?.list?.()) ?? [];
    return agents.filter((a) => a.command).map(({ id, label, program, command, hooks }) => ({ id, label, program, command, hooks }));
  }

  // ---- Worker launch ----

  async function uniqueSessionName(base) {
    const taken = new Set((await host.sessions.list()).map((x) => x.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    throw conflict(`no free session name near ${base}`);
  }

  async function startWorker(body) {
    if (!host.sessions || !host.worktrees || !host.agents?.launchCommand) {
      throw new HttpError(501, "this tmux-server is too old to launch workers - update it (needs host.sessions)");
    }
    const taskId = str(body.taskId, "taskId", { required: true });
    const agentId = str(body.agentId, "agentId", { required: true });
    const worktree = str(body.worktree, "worktree", { max: 4096 }) || "current";

    const snapshot = await s.get();
    requireAction(snapshot, taskId, "start-worker");
    const task = snapshot.tasks[taskId];
    const run = snapshot.runs[task.runId];

    const launch = await host.agents.launchCommand(agentId);
    if (!launch) throw bad(`agent "${agentId}" is unknown, disabled or has no launch command (Settings -> AI Providers)`);
    const agent = (await host.agents.list()).find((a) => a.id === agentId);
    const cfg = await settings();

    let cwd;
    let worktreeMode = worktree;
    if (worktree === "current" || worktree === "new") {
      if (!run?.repo) throw bad(`run ${task.runId} has no repo - give the run a repo, or a worktree path`);
      cwd = run.repo;
      if (worktree === "new") {
        const branch = branchNameFor(task);
        try {
          cwd = (await host.worktrees.create({ cwd: run.repo, branch, mode: "new", location: cfg.worktreeLocation })).path;
        } catch (err) {
          throw new HttpError(typeof err?.status === "number" ? err.status : 500, err?.message ?? String(err));
        }
      }
    } else {
      cwd = expandHome(worktree);
      worktreeMode = "path";
      if (!(await isDirectory(cwd))) throw bad(`${worktree} is not a directory`);
    }

    const dispatchId = newId("dsp");
    const sessionName = await uniqueSessionName(`agent-${branchNameFor(task).slice(0, 40)}`);
    const session = await host.sessions.create(sessionName, cwd, true);
    const panes = await host.sessions.listPanes(session.name);
    const pane = panes.find((p) => p.active) ?? panes[0];
    if (!pane) throw new HttpError(500, `session ${session.name} has no pane`);

    const now = Date.now();
    const dispatch = {
      id: dispatchId,
      taskId,
      runId: task.runId,
      agentId,
      agentLabel: agent?.label ?? agentId,
      program: agent?.program ?? "",
      command: launch,
      sessionName: session.name,
      windowIndex: pane.windowIndex,
      paneId: pane.id,
      worktreePath: cwd,
      worktreeMode,
      state: "active",
      awaiting: null,
      startedAt: now,
      endedAt: null,
      lastHeartbeatAt: now,
      lastStatus: "",
      completedBy: null,
    };
    // Recorded before anything is typed, so even an agent that finishes
    // instantly finds its dispatch.
    await s.update((doc) => {
      requireAction(doc, taskId, "start-worker");
      doc.dispatches[dispatchId] = dispatch;
      if (doc.runs[task.runId]) doc.runs[task.runId].updatedAt = now;
    });

    // Keys typed into a shell that is still starting are at the mercy of
    // its startup files; give it a beat first. (A shell that stops to ask
    // something at startup - zsh's first-run menu for a user with no
    // .zshrc - will still eat the first key; seen live in a scratch HOME.)
    await sleep(LAUNCH_SETTLE_MS);
    const line =
      `export TS_AGENT_SOCK=${shellQuote(socketPath)} TS_RUN_ID=${task.runId} TS_TASK_ID=${taskId} TS_DISPATCH_ID=${dispatchId}; ` +
      `export PATH=${shellQuote(binDir)}:"$PATH"; ${launch}`;
    try {
      await host.sessions.sendText(session.name, line, true, pane.windowIndex);
    } catch (err) {
      await s.update((doc) => {
        const d = doc.dispatches[dispatchId];
        if (d?.state === "active") endDispatch(doc, d, "lost", { error: `launch failed: ${err.message}` });
      });
      throw err;
    }

    void primeWorker(dispatchId, cfg.autoSubmitPreamble);
    return { dispatchId, dispatch: { ...dispatch, worktreePath: shortenHome(cwd) } };
  }

  // Types the one-line brief once the agent is actually running in the pane:
  // text sent while the shell is still starting the CLI is at the mercy of
  // however that CLI treats input that arrived before it did. Background,
  // after the route has answered, and it catches everything.
  async function primeWorker(dispatchId, submit) {
    try {
      const deadline = Date.now() + PREAMBLE_WAIT_MS;
      let dispatch;
      for (;;) {
        const doc = await s.get();
        dispatch = doc.dispatches[dispatchId];
        if (!dispatch || dispatch.state !== "active" || instance.stopped) return;
        const { panes } = await allPanes().catch(() => ({ panes: new Map() }));
        const pane = panes.get(dispatch.paneId);
        if (pane && dispatch.program && pane.command === dispatch.program) break;
        if (Date.now() > deadline) break;
        await sleep(500);
      }
      await sleep(PREAMBLE_SETTLE_MS);
      const doc = await s.get();
      dispatch = doc.dispatches[dispatchId];
      if (!dispatch || dispatch.state !== "active") return;
      const { panes } = await allPanes();
      const pane = panes.get(dispatch.paneId);
      if (!pane) return;
      const text = buildPreambleLine({ run: doc.runs[dispatch.runId], task: doc.tasks[dispatch.taskId], dispatch });
      await host.sessions.sendText(pane.sessionName, text, submit, pane.windowIndex);
    } catch (err) {
      log("could not type the brief for", dispatchId, err?.message ?? err);
    }
  }

  async function stopWorker(body) {
    const taskId = str(body.taskId, "taskId");
    const dispatchId = str(body.dispatchId, "dispatchId");
    return s.update((doc) => {
      const dispatch = dispatchId ? doc.dispatches[dispatchId] : taskId ? activeDispatch(doc, taskId) : null;
      if (!dispatch) throw notFound("no active dispatch for that task");
      if (dispatch.state !== "active") throw conflict(`dispatch ${dispatch.id} is already ${dispatch.state}`);
      endDispatch(doc, dispatch, "stopped");
      return { dispatch, sessionName: dispatch.sessionName };
    });
  }

  // ---- Worker verbs (socket) ----

  async function requireDispatch(body) {
    const dispatchId = str(body.dispatchId, "dispatchId");
    if (!dispatchId) throw new ControlError(400, "no dispatch id - run this from a worker pane (TS_DISPATCH_ID is unset)");
    const doc = await s.get();
    const dispatch = doc.dispatches[dispatchId];
    if (!dispatch) throw new ControlError(404, `no dispatch ${dispatchId}`);
    return { doc, dispatch };
  }

  async function touch(dispatchId, fields = {}) {
    await s.update((doc) => {
      const d = doc.dispatches[dispatchId];
      if (d?.state === "active") Object.assign(d, { lastHeartbeatAt: Date.now() }, fields);
    });
  }

  async function verbCheck(body, { req }) {
    const { dispatch } = await requireDispatch(body);
    const wait = bool(body.wait);
    const timeoutMs = Math.min(CHECK_WAIT_MAX_MS, Math.max(0, Number(body.timeoutMs) || (wait ? 60_000 : 0)));
    const ack = bool(body.ack);
    const types = optionList(body.types);
    if (dispatch.state === "active") await touch(dispatch.id);

    // Read first and write only to acknowledge: a worker polling an empty
    // queue must not rewrite the store on every poll.
    const take = async () => {
      const found = nextDelivery(await s.get(), dispatch.runId, types, dispatch.id);
      if (!found || !ack) return found;
      return s.update((doc) => {
        const message = nextDelivery(doc, dispatch.runId, types, dispatch.id);
        if (message) message.ackedAt = Date.now();
        return message ?? null;
      });
    };

    let message = await take();
    if (!message && wait && timeoutMs > 0) {
      message = await new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          off();
          instance.cleanups.delete(cancel);
          resolve(value);
        };
        const cancel = () => finish(null);
        const timer = setTimeout(() => finish(null), timeoutMs);
        const off = s.onChange((_before, after) => {
          if (nextDelivery(after, dispatch.runId, types, dispatch.id)) {
            take().then(finish, () => finish(null));
          }
        });
        instance.cleanups.add(cancel);
        req.on("close", cancel);
      });
    }
    return { message, dispatchState: dispatch.state };
  }

  async function verbSend(body) {
    const text = str(body.body, "body", { required: true, max: BODY_MAX });
    const type = ["note", "status", "question", "escalation"].includes(body.type) ? body.type : "note";
    const to = str(body.to, "to") || "@coordinator";
    let from = COORDINATOR;
    let runId = str(body.runId, "runId");
    let taskId = null;
    let dispatchId = null;
    if (body.dispatchId) {
      const { dispatch } = await requireDispatch(body);
      from = dispatch.id;
      runId = dispatch.runId;
      taskId = dispatch.taskId;
      dispatchId = dispatch.id;
    }
    const { panes } = await allPanes().catch(() => ({ panes: new Map() }));
    const paneRows = [...panes.values()].map((p) => ({ id: p.id, command: p.command }));
    return s.update((doc) => {
      if (runId && !doc.runs[runId]) throw new ControlError(404, `no run ${runId}`);
      if (dispatchId && doc.dispatches[dispatchId]?.state === "active") doc.dispatches[dispatchId].lastHeartbeatAt = Date.now();
      if (to === "@coordinator" || to === COORDINATOR) {
        if (!runId) throw new ControlError(400, "runId is required outside a worker pane");
        const message = fileMessage(doc, { runId, taskId, dispatchId, from, type, body: text });
        return { sent: [message.id] };
      }
      const recipients = resolveHandle(doc, to, paneRows, runId || undefined).filter((d) => d.id !== dispatchId);
      if (recipients.length === 0) throw new ControlError(404, `no active worker matches ${to}`);
      const sent = recipients.map(
        (d) => fileMessage(doc, { runId: d.runId, taskId: d.taskId, dispatchId, from, to: d.id, type, body: text }).id,
      );
      return { sent };
    });
  }

  async function verbAsk(body) {
    const { dispatch } = await requireDispatch(body);
    if (dispatch.state !== "active") throw new ControlError(409, `dispatch ${dispatch.id} is ${dispatch.state}`);
    const result = await createGate(body, { fromDispatch: dispatch });
    return { gateId: result.gateId, hint: "run `agent-task check --wait` for the answer" };
  }

  async function verbHeartbeat(body) {
    const { dispatch } = await requireDispatch(body);
    if (dispatch.state !== "active") throw new ControlError(409, `dispatch ${dispatch.id} is ${dispatch.state}`);
    const status = str(body.status, "status", { max: 500 });
    await touch(dispatch.id, status ? { lastStatus: status } : {});
    return { ok: true, dispatchId: dispatch.id };
  }

  // Ends the task through its dispatch, whoever reports it: the worker's own
  // `done`, or the agent's stop hook. Rejected unless this dispatch is the
  // task's active one (model.mjs's completeRejection).
  async function completeThroughDispatch({ dispatchId, taskId, outcome, body, completedBy }) {
    return s.update((doc) => {
      const dispatch = doc.dispatches[dispatchId];
      const forTask = taskId || dispatch?.taskId;
      const rejection = completeRejection(doc, forTask, dispatchId);
      if (rejection) throw new ControlError(409, rejection);
      const task = doc.tasks[forTask];
      const succeeded = outcome === "succeeded";
      const now = Date.now();
      task.outcome = succeeded ? "completed" : "failed";
      task.outcomeBody = body;
      task.updatedAt = now;
      endDispatch(doc, dispatch, succeeded ? "succeeded" : "failed", { completedBy });
      fileMessage(doc, {
        runId: task.runId,
        taskId: task.id,
        dispatchId,
        from: dispatchId,
        type: "done",
        body: `${task.title}: ${succeeded ? "succeeded" : "failed"}${body ? ` - ${body}` : ""}`,
      });
      return { task: decorateTask(doc, task.id), dispatch };
    });
  }

  async function verbDone(body) {
    const { dispatch } = await requireDispatch(body);
    const outcome = str(body.outcome, "outcome", { required: true });
    if (outcome !== "succeeded" && outcome !== "failed") throw new ControlError(400, "outcome must be succeeded or failed");
    const text = str(body.body, "body", { max: BODY_MAX });
    return completeThroughDispatch({
      dispatchId: dispatch.id,
      taskId: str(body.taskId, "taskId"),
      outcome,
      body: text,
      completedBy: "cli",
    });
  }

  async function verbStatus(body) {
    const doc = await s.get();
    const out = {
      ok: true,
      socket: socketPath,
      runs: Object.keys(doc.runs).length,
      tasks: Object.keys(doc.tasks).length,
      activeDispatches: Object.values(doc.dispatches).filter((d) => d.state === "active").length,
      unacked: unackedCount(doc),
    };
    const dispatchId = typeof body.dispatchId === "string" ? body.dispatchId : "";
    if (dispatchId && doc.dispatches[dispatchId]) {
      const dispatch = doc.dispatches[dispatchId];
      out.dispatch = dispatch;
      if (doc.tasks[dispatch.taskId]) out.task = decorateTask(doc, dispatch.taskId);
      out.run = doc.runs[dispatch.runId] ?? null;
      out.pendingMessages = Object.values(doc.messages).filter((m) => m.to === dispatchId && !m.ackedAt).length;
    }
    return out;
  }

  async function verbDispatchShow(body) {
    const { doc, dispatch } = await requireDispatch(body);
    const task = doc.tasks[dispatch.taskId];
    if (!task) throw new ControlError(404, `task ${dispatch.taskId} no longer exists`);
    const depsSummary = (task.deps ?? [])
      .map((id) => doc.tasks[id])
      .filter(Boolean)
      .map((dep) => ({ title: dep.title, status: taskStatus(doc, dep.id) }));
    return { text: buildPreamble({ run: doc.runs[dispatch.runId], task, dispatch, depsSummary }) };
  }

  // Newline-delimited JSON, one transition per line, until the client hangs
  // up or this activation is torn down. The first line is a hello so a client
  // knows the stream is live before anything happens.
  function verbSubscribe(_body, { req, res }) {
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
    res.write(`${JSON.stringify({ type: "hello", at: Date.now() })}\n`);
    const off = s.onChange((before, after) => {
      try {
        for (const transition of diffTransitions(before, after)) {
          const run = after.runs[transition.runId] ?? before.runs[transition.runId];
          res.write(`${JSON.stringify({ ...transition, repo: run?.repo ?? "", at: Date.now() })}\n`);
        }
      } catch (err) {
        log("subscribe stream write failed:", err?.message ?? err);
      }
    });
    const ping = setInterval(() => {
      try {
        res.write(`${JSON.stringify({ type: "ping", at: Date.now() })}\n`);
      } catch {
        // closed; the close handler cleans up
      }
    }, 30_000);
    const close = () => {
      off();
      clearInterval(ping);
      instance.cleanups.delete(close);
      try {
        res.end();
      } catch {
        // already closed
      }
    };
    req.on("close", close);
    instance.cleanups.add(close);
    return undefined;
  }

  // ---- Hooks ----

  // `stop` is the authoritative "the turn is over" from the agent itself. It
  // carries no failure reason for Claude Code or Codex, so it completes as
  // succeeded; a turn the user interrupted (Esc) is not the task finishing and
  // is ignored. `permission` files a question in the inbox, since a worker
  // waiting on a prompt is waiting on the coordinator.
  async function onHookEvent(event) {
    const doc = await s.get();
    const dispatch = dispatchForPane(doc, event.paneId);
    if (!dispatch) return;
    if (event.event === "stop") {
      if (event.payload?.is_interrupt === true) {
        await touch(dispatch.id);
        return;
      }
      if (completeRejection(doc, dispatch.taskId, dispatch.id)) return;
      await completeThroughDispatch({
        dispatchId: dispatch.id,
        taskId: dispatch.taskId,
        outcome: "succeeded",
        body: "The agent's turn ended (stop hook).",
        completedBy: "hook",
      }).catch((err) => {
        if (!(err instanceof ControlError)) throw err;
      });
    } else if (event.event === "permission") {
      const tool = typeof event.payload?.tool_name === "string" ? event.payload.tool_name : "";
      await s.update((d) => {
        const live = d.dispatches[dispatch.id];
        if (live?.state !== "active") return;
        live.awaiting = "permission";
        live.lastHeartbeatAt = Date.now();
        fileMessage(d, {
          runId: live.runId,
          taskId: live.taskId,
          dispatchId: live.id,
          from: live.id,
          type: "question",
          body: tool ? `Waiting on a permission prompt for ${tool}.` : "Waiting on a permission prompt.",
        });
      });
    }
  }

  // ---- Liveness sweep ----

  async function sweep() {
    const doc = await s.get();
    const active = Object.values(doc.dispatches).filter((d) => d.state === "active");
    if (active.length === 0) return;
    const { heartbeatTimeoutMs } = await settings();
    const { panes, certain } = await allPanes();
    const now = Date.now();
    await s.update((draft) => {
      for (const snapshot of active) {
        const d = draft.dispatches[snapshot.id];
        if (!d || d.state !== "active") continue;
        const pane = panes.get(d.paneId);
        let reason = null;
        if (!pane) {
          if (certain) reason = `its pane ${d.paneId} is gone`;
        } else {
          // A renamed session changes nothing but the name shown.
          if (pane.sessionName !== d.sessionName) d.sessionName = pane.sessionName;
          if (now - (d.lastHeartbeatAt ?? d.startedAt) > heartbeatTimeoutMs) {
            reason = `no sign of life for ${Math.round((now - (d.lastHeartbeatAt ?? d.startedAt)) / 1000)}s`;
          }
        }
        if (!reason) continue;
        endDispatch(draft, d, "lost", { lostReason: reason });
        const task = draft.tasks[d.taskId];
        fileMessage(draft, {
          runId: d.runId,
          taskId: d.taskId,
          dispatchId: d.id,
          type: "escalation",
          body: `Worker for "${task?.title ?? d.taskId}" was lost: ${reason}. The task is back to ${task ? taskStatus(draft, task.id) : "ready"}; start a new worker or mark it failed.`,
        });
      }
    });
  }

  // ---- State for the panel ----

  async function state() {
    const doc = await s.get();
    const runs = Object.values(doc.runs)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((run) => ({ ...run, repo: shortenHome(run.repo) }));
    const tasks = Object.values(doc.tasks)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => decorateTask(doc, t.id));
    const dispatches = Object.values(doc.dispatches)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((d) => ({ ...d, worktreePath: shortenHome(d.worktreePath) }));
    const gates = Object.values(doc.gates).sort((a, b) => b.createdAt - a.createdAt);
    const inbox = Object.values(doc.messages)
      .filter((m) => m.to === COORDINATOR)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, INBOX_LIMIT);
    return {
      runs,
      tasks,
      dispatches,
      gates,
      inbox,
      unacked: unackedCount(doc),
      socket: current === instance && instance.control?.isListening() ? socketPath : null,
      cli: cliPath,
      now: Date.now(),
    };
  }

  // ---- HTTP routes (the panel) ----

  const route = (fn) => wrap(fn, log);
  router.get("/state", route(async (_req, res) => res.json(await state())));
  router.post("/run-create", route(async (req, res) => res.json(await createRun(req.body ?? {}))));
  router.post("/run-delete", route(async (req, res) => res.json(await deleteRun(req.body ?? {}))));
  router.post("/task-create", route(async (req, res) => res.json(await createTask(req.body ?? {}))));
  router.post("/task-update", route(async (req, res) => res.json(await updateTask(req.body ?? {}))));
  router.post("/task-delete", route(async (req, res) => res.json(await deleteTask(req.body ?? {}))));
  router.post("/gate-create", route(async (req, res) => res.json(await createGate(req.body ?? {}))));
  router.post("/gate-resolve", route(async (req, res) => res.json(await resolveGate(req.body ?? {}))));
  router.post("/message-ack", route(async (req, res) => res.json(await ackMessages(req.body ?? {}))));
  router.post("/worker-start", route(async (req, res) => res.json(await startWorker(req.body ?? {}))));
  router.post("/worker-stop", route(async (req, res) => res.json(await stopWorker(req.body ?? {}))));
  router.post(
    "/reset",
    route(async (req, res) => {
      if (req.body?.confirm !== true) throw bad("reset needs { confirm: true }");
      const doc = await s.get();
      if (Object.values(doc.dispatches).some((d) => d.state === "active")) throw conflict("stop every worker before resetting");
      await s.reset();
      res.json({ ok: true });
    }),
  );
  router.get(
    "/archive",
    route(async (_req, res) => {
      const archive = await s.loadArchive();
      const runs = Object.values(archive.runs)
        .map((entry) => ({
          ...entry.run,
          repo: shortenHome(entry.run?.repo ?? ""),
          archivedAt: entry.archivedAt,
          taskCount: Object.keys(entry.tasks ?? {}).length,
        }))
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
      res.json({ runs });
    }),
  );
  router.post(
    "/archive-restore",
    route(async (req, res) => {
      const runId = str(req.body?.runId, "runId", { required: true });
      const run = await s.restoreRun(runId);
      if (!run) throw notFound(`no archived run ${runId}`);
      res.json({ run });
    }),
  );
  router.get("/agents", route(async (_req, res) => res.json({ agents: await listAgents() })));
  // The badge's own poll, cheap enough to run while the panel is hidden.
  router.get("/unacked", route(async (_req, res) => res.json({ unacked: unackedCount(await s.get()) })));

  // ---- Socket verbs ----

  const verbs = {
    check: verbCheck,
    send: verbSend,
    ask: verbAsk,
    heartbeat: verbHeartbeat,
    done: verbDone,
    status: verbStatus,
    "dispatch-show": verbDispatchShow,
    subscribe: verbSubscribe,
    // Coordinator verbs: what automations drives, and what a script or a
    // coordinating agent can drive from a shell.
    "run-create": createRun,
    "task-create": createTask,
    "worker-start": startWorker,
  };
  // The socket speaks ControlError; HttpError carries the same status field,
  // which control.mjs reads.
  instance.control = createControlServer({ socketPath, handlers: verbs, log });

  // ---- Start (after tearing the previous activation down) ----

  (async () => {
    await teardown(previous);
    if (instance.stopped) return;
    await installCli(log);
    await instance.control.start();
    if (instance.stopped) {
      await instance.control.stop();
      return;
    }
    log(`control socket listening at ${socketPath}`);

    if (host.agentHooks?.subscribe) {
      const unsubscribe = host.agentHooks.subscribe({
        events: ["stop", "permission"],
        onEvent(event) {
          if (instance.stopped) return;
          onHookEvent(event).catch((err) => log("hook event failed:", err?.stack ?? err));
        },
      });
      instance.cleanups.add(unsubscribe);
    }

    if (host.sessions) {
      let sweeping = false;
      instance.sweepTimer = setInterval(() => {
        if (sweeping || instance.stopped) return;
        sweeping = true;
        sweep()
          .catch((err) => log("liveness sweep failed:", err?.stack ?? err))
          .finally(() => {
            sweeping = false;
          });
      }, SWEEP_INTERVAL_MS);
      instance.sweepTimer.unref?.();
    } else {
      log("this tmux-server has no host.sessions: workers cannot be launched or swept - update it");
    }
  })().catch((err) => log("activation failed:", err?.stack ?? err));
}

// The CLI a worker runs, copied to <config>/tmux-server/bin/agent-task (the
// directory the launch line puts on PATH). Temp-then-rename, so a pane that
// runs it mid-install gets the old copy or the new one, never half of one.
async function installCli(log) {
  try {
    await mkdir(binDir, { recursive: true });
    const tmp = `${cliPath}.${process.pid}.tmp`;
    await copyFile(cliSource, tmp);
    await chmod(tmp, 0o755);
    await rename(tmp, cliPath);
  } catch (err) {
    log("could not install the agent-task CLI:", err?.message ?? err);
  }
}
