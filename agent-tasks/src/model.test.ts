// agent-tasks' state machine and store, pinned. Laid out like agent-monitor's
// src/hookStatus.test.ts: the subject is the plain .mjs beside server.js, and
// each case names the situation it protects rather than the mapping it
// asserts.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  allowedActions,
  canComplete,
  completeRejection,
  diffTransitions,
  dispatchForPane,
  emptyDocument,
  isArchivable,
  nextDelivery,
  pruneMessages,
  resolveHandle,
  taskStatus,
} from "../model.mjs";
import { createStore } from "../store.mjs";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

// ---- Fixtures ----

type Doc = ReturnType<typeof emptyDocument>;

function doc(): Doc {
  const d = emptyDocument();
  d.runs.run_a = { id: "run_a", objective: "ship it", repo: "/repo", createdAt: T0, updatedAt: T0 };
  return d;
}

function addTask(d: Doc, id: string, extra: Record<string, unknown> = {}) {
  d.tasks[id] = { id, runId: "run_a", title: id, spec: "", deps: [], outcome: null, createdAt: T0, updatedAt: T0, ...extra };
  return d.tasks[id];
}

function addDispatch(d: Doc, id: string, taskId: string, extra: Record<string, unknown> = {}) {
  d.dispatches[id] = {
    id,
    taskId,
    runId: "run_a",
    agentId: "tmux-server.agents.claude",
    program: "claude",
    paneId: "%1",
    sessionName: "s",
    worktreePath: "/repo",
    state: "active",
    startedAt: T0,
    endedAt: null,
    lastHeartbeatAt: T0,
    ...extra,
  };
  return d.dispatches[id];
}

function addGate(d: Doc, id: string, taskId: string, extra: Record<string, unknown> = {}) {
  d.gates[id] = { id, taskId, runId: "run_a", question: "which way?", options: ["a", "b"], state: "open", createdAt: T0, ...extra };
  return d.gates[id];
}

function addMessage(d: Doc, id: string, extra: Record<string, unknown> = {}) {
  d.messages[id] = { id, runId: "run_a", to: "coordinator", type: "note", body: id, createdAt: T0, ackedAt: null, ...extra };
  return d.messages[id];
}

// ---- taskStatus ----

test("a task waits pending until every dependency completes, then becomes ready", () => {
  const d = doc();
  addTask(d, "task_dep1");
  addTask(d, "task_dep2");
  addTask(d, "task_main", { deps: ["task_dep1", "task_dep2"] });
  assert.equal(taskStatus(d, "task_main"), "pending");
  d.tasks.task_dep1.outcome = "completed";
  assert.equal(taskStatus(d, "task_main"), "pending", "one dependency is not all of them");
  d.tasks.task_dep2.outcome = "completed";
  assert.equal(taskStatus(d, "task_main"), "ready");
});

test("a task with no dependencies is ready from the start", () => {
  const d = doc();
  addTask(d, "task_x");
  assert.equal(taskStatus(d, "task_x"), "ready");
});

test("a failed dependency blocks the task instead of leaving it pending forever", () => {
  const d = doc();
  addTask(d, "task_dep", { outcome: "failed" });
  addTask(d, "task_main", { deps: ["task_dep"] });
  assert.equal(taskStatus(d, "task_main"), "blocked");
});

test("an active dispatch makes the task dispatched", () => {
  const d = doc();
  addTask(d, "task_x");
  addDispatch(d, "dsp_1", "task_x");
  assert.equal(taskStatus(d, "task_x"), "dispatched");
  d.dispatches.dsp_1.state = "lost";
  assert.equal(taskStatus(d, "task_x"), "ready", "a lost worker returns the task to ready");
});

test("an open gate forces blocked, and resolving it restores whatever the task was before", () => {
  const d = doc();
  addTask(d, "task_x");
  addDispatch(d, "dsp_1", "task_x");
  assert.equal(taskStatus(d, "task_x"), "dispatched");
  addGate(d, "gate_1", "task_x");
  assert.equal(taskStatus(d, "task_x"), "blocked");
  d.gates.gate_1.state = "resolved";
  assert.equal(taskStatus(d, "task_x"), "dispatched");

  addTask(d, "task_dep");
  addTask(d, "task_pending", { deps: ["task_dep"] });
  addGate(d, "gate_2", "task_pending");
  assert.equal(taskStatus(d, "task_pending"), "blocked");
  d.gates.gate_2.state = "resolved";
  assert.equal(taskStatus(d, "task_pending"), "pending");
});

test("a recorded outcome wins over gates, dependencies and dispatches", () => {
  const d = doc();
  addTask(d, "task_dep", { outcome: "failed" });
  addTask(d, "task_x", { deps: ["task_dep"], outcome: "completed" });
  addGate(d, "gate_1", "task_x");
  addDispatch(d, "dsp_1", "task_x");
  assert.equal(taskStatus(d, "task_x"), "completed");
});

// ---- allowedActions ----

test("the buttons follow the status", () => {
  const d = doc();
  addTask(d, "task_ready");
  assert.deepEqual(allowedActions(d, "task_ready"), ["start-worker", "complete", "fail", "open-gate", "delete"]);
  addTask(d, "task_busy");
  addDispatch(d, "dsp_1", "task_busy");
  assert.deepEqual(allowedActions(d, "task_busy"), ["stop-worker", "complete", "fail", "open-gate"]);
  addTask(d, "task_done", { outcome: "completed" });
  assert.deepEqual(allowedActions(d, "task_done"), ["retry", "delete"]);
  addTask(d, "task_wait", { deps: ["task_busy"] });
  assert.deepEqual(allowedActions(d, "task_wait"), ["complete", "fail", "open-gate", "delete"]);
  assert.deepEqual(allowedActions(d, "task_missing"), []);
});

test("a task with a live worker cannot be deleted out from under it", () => {
  const d = doc();
  addTask(d, "task_x");
  addDispatch(d, "dsp_1", "task_x");
  addGate(d, "gate_1", "task_x");
  assert.equal(taskStatus(d, "task_x"), "blocked");
  assert.ok(allowedActions(d, "task_x").includes("stop-worker"));
  assert.ok(!allowedActions(d, "task_x").includes("delete"));
});

// ---- canComplete ----

test("only the task's active dispatch can complete it", () => {
  const d = doc();
  addTask(d, "task_x");
  addTask(d, "task_other");
  addDispatch(d, "dsp_1", "task_x");
  addDispatch(d, "dsp_2", "task_other", { paneId: "%2" });
  assert.equal(canComplete(d, "task_x", "dsp_1"), true);
  assert.equal(canComplete(d, "task_x", "dsp_2"), false, "another task's worker");
  assert.equal(canComplete(d, "task_x", "dsp_nope"), false);
});

test("a stale dispatch's late done is rejected, and says why", () => {
  const d = doc();
  addTask(d, "task_x");
  addDispatch(d, "dsp_old", "task_x", { state: "lost", startedAt: T0 });
  addDispatch(d, "dsp_new", "task_x", { startedAt: T0 + 1000, paneId: "%9" });
  assert.equal(canComplete(d, "task_x", "dsp_old"), false);
  assert.match(completeRejection(d, "task_x", "dsp_old") ?? "", /lost/);
  assert.equal(canComplete(d, "task_x", "dsp_new"), true);
  d.tasks.task_x.outcome = "completed";
  assert.equal(canComplete(d, "task_x", "dsp_new"), false, "a finished task cannot be finished twice");
});

test("of two active dispatches the older one is stale", () => {
  const d = doc();
  addTask(d, "task_x");
  addDispatch(d, "dsp_old", "task_x", { startedAt: T0 });
  addDispatch(d, "dsp_new", "task_x", { startedAt: T0 + 5 });
  assert.equal(canComplete(d, "task_x", "dsp_old"), false);
  assert.equal(canComplete(d, "task_x", "dsp_new"), true);
});

// ---- resolveHandle ----

test("handles address the right workers", () => {
  const d = doc();
  addTask(d, "task_a");
  addTask(d, "task_b");
  addTask(d, "task_c");
  addDispatch(d, "dsp_a", "task_a", { paneId: "%1", program: "claude", worktreePath: "/repo/.worktrees/a", startedAt: T0 });
  addDispatch(d, "dsp_b", "task_b", { paneId: "%2", program: "codex", worktreePath: "/repo/.worktrees/b", startedAt: T0 + 1 });
  addDispatch(d, "dsp_c", "task_c", { paneId: "%3", program: "claude", state: "succeeded", startedAt: T0 + 2 });
  const ids = (list: { id: string }[]) => list.map((x) => x.id);
  const panes = [
    { id: "%1", command: "claude" },
    { id: "%2", command: "zsh" },
  ];
  assert.deepEqual(ids(resolveHandle(d, "@all", panes)), ["dsp_a", "dsp_b"], "finished dispatches are never addressed");
  assert.deepEqual(ids(resolveHandle(d, "@claude", panes)), ["dsp_a"]);
  assert.deepEqual(ids(resolveHandle(d, "@idle", panes)), ["dsp_b"], "back at a shell means idle");
  assert.deepEqual(ids(resolveHandle(d, "@worktree:/repo/.worktrees/b/", panes)), ["dsp_b"]);
  assert.deepEqual(ids(resolveHandle(d, "@task:task_a", panes)), ["dsp_a"]);
  assert.deepEqual(ids(resolveHandle(d, "dsp_b", panes)), ["dsp_b"]);
  assert.deepEqual(ids(resolveHandle(d, "@nobody", panes)), []);
  assert.deepEqual(ids(resolveHandle(d, "nonsense", panes)), []);
  assert.deepEqual(ids(resolveHandle(d, "@all", panes, "run_other")), [], "scoped to a run");
});

test("a worker waiting on a question is idle even while its agent is in the foreground", () => {
  const d = doc();
  addTask(d, "task_a");
  addDispatch(d, "dsp_a", "task_a", { paneId: "%1", awaiting: "question" });
  assert.deepEqual(resolveHandle(d, "@idle", [{ id: "%1", command: "claude" }]).map((x: { id: string }) => x.id), ["dsp_a"]);
  delete d.dispatches.dsp_a.awaiting;
  assert.deepEqual(resolveHandle(d, "@idle", [{ id: "%1", command: "claude" }]), []);
  assert.equal(resolveHandle(d, "@idle", []).length, 1, "a pane that is gone is idle");
});

// ---- nextDelivery ----

test("delivery is oldest unacked first, per recipient and type", () => {
  const d = doc();
  addMessage(d, "msg_3", { createdAt: T0 + 3 });
  addMessage(d, "msg_1", { createdAt: T0 + 1, ackedAt: T0 + 2 });
  addMessage(d, "msg_2", { createdAt: T0 + 2, type: "question" });
  addMessage(d, "msg_w", { createdAt: T0, to: "dsp_a", type: "answer" });
  assert.equal(nextDelivery(d, "run_a")?.id, "msg_2", "acked messages are skipped");
  assert.equal(nextDelivery(d, "run_a", ["note"])?.id, "msg_3");
  assert.equal(nextDelivery(d, "run_a", [], "dsp_a")?.id, "msg_w");
  assert.equal(nextDelivery(d, "run_other"), null);
});

// ---- dispatchForPane ----

test("a hook event's pane finds only the active dispatch recorded for it", () => {
  const d = doc();
  addTask(d, "task_a");
  addDispatch(d, "dsp_old", "task_a", { paneId: "%7", state: "lost" });
  assert.equal(dispatchForPane(d, "%7"), null, "a finished dispatch no longer owns its pane");
  addDispatch(d, "dsp_new", "task_a", { paneId: "%7", startedAt: T0 + 1 });
  assert.equal(dispatchForPane(d, "%7")?.id, "dsp_new");
  assert.equal(dispatchForPane(d, "%8"), null);
  assert.equal(dispatchForPane(d, ""), null);
});

// ---- Transitions ----

test("transitions name the lifecycle moments automations fire on", () => {
  const before = doc();
  addTask(before, "task_a");
  addDispatch(before, "dsp_a", "task_a");
  addTask(before, "task_b");
  const after = structuredClone(before);
  after.tasks.task_a.outcome = "failed";
  after.dispatches.dsp_a.state = "lost";
  addGate(after, "gate_1", "task_b");
  const types = diffTransitions(before, after).map((t: { type: string }) => t.type).sort();
  assert.deepEqual(types, ["dispatch-state", "gate-opened", "task-blocked", "task-failed", "worker-lost"]);
  assert.deepEqual(diffTransitions(after, after), [], "nothing changed, nothing streamed");
});

// ---- Growth control ----

test("pruning keeps the newest 500 messages of each run", () => {
  const d = doc();
  for (let i = 0; i < 520; i++) addMessage(d, `msg_a${String(i).padStart(3, "0")}`, { createdAt: T0 + i });
  for (let i = 0; i < 10; i++) addMessage(d, `msg_b${i}`, { runId: "run_b", createdAt: T0 + i });
  pruneMessages(d);
  const runA = Object.values(d.messages).filter((m: { runId: string }) => m.runId === "run_a");
  assert.equal(runA.length, 500);
  assert.equal(d.messages.msg_a019, undefined, "the oldest are the ones dropped");
  assert.ok(d.messages.msg_a020);
  assert.ok(d.messages.msg_a519);
  assert.equal(Object.values(d.messages).filter((m: { runId: string }) => m.runId === "run_b").length, 10);
});

test("a fully terminal run past the threshold archives; an active one does not", () => {
  const d = doc();
  addTask(d, "task_a", { outcome: "completed" });
  addTask(d, "task_b", { outcome: "failed" });
  const now = T0 + 31 * DAY;
  assert.equal(isArchivable(d, "run_a", now, 30), true);
  assert.equal(isArchivable(d, "run_a", T0 + 29 * DAY, 30), false, "not old enough");
  addTask(d, "task_c");
  assert.equal(isArchivable(d, "run_a", now, 30), false, "a task still open keeps the run live");
  d.tasks.task_c.outcome = "completed";
  addGate(d, "gate_1", "task_c", { createdAt: T0 });
  assert.equal(isArchivable(d, "run_a", now, 30), false, "an open gate keeps the run live");
  d.gates.gate_1.state = "resolved";
  addMessage(d, "msg_recent", { createdAt: T0 + 20 * DAY });
  assert.equal(isArchivable(d, "run_a", now, 30), false, "recent activity keeps the run live");
});

// ---- Store ----

async function tempConfig() {
  return mkdtemp(path.join(tmpdir(), "agent-tasks-test-"));
}

test("concurrent updates both land", async () => {
  const dir = await tempConfig();
  const store = createStore(dir, { archiveAfterDays: 30 });
  await Promise.all([
    store.update(async (d: Doc) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      d.runs.run_1 = { id: "run_1", objective: "one", createdAt: Date.now(), updatedAt: Date.now() };
    }),
    store.update((d: Doc) => {
      d.runs.run_2 = { id: "run_2", objective: "two", createdAt: Date.now(), updatedAt: Date.now() };
    }),
  ]);
  const onDisk = JSON.parse(await readFile(store.storePath, "utf8"));
  assert.deepEqual(Object.keys(onDisk.runs).sort(), ["run_1", "run_2"]);
  const fresh = createStore(dir, { archiveAfterDays: 30 });
  assert.deepEqual(Object.keys((await fresh.get()).runs).sort(), ["run_1", "run_2"], "and survive a reload");
});

test("the store file is written 0600 and a failed update changes nothing", async () => {
  const dir = await tempConfig();
  const store = createStore(dir, { archiveAfterDays: 30 });
  await store.update((d: Doc) => {
    d.runs.run_1 = { id: "run_1", objective: "one", createdAt: Date.now(), updatedAt: Date.now() };
  });
  assert.equal((await stat(store.storePath)).mode & 0o777, 0o600);
  await assert.rejects(
    store.update((d: Doc) => {
      d.runs.run_bad = { id: "run_bad" };
      throw new Error("validation failed");
    }),
    /validation failed/,
  );
  assert.equal((await store.get()).runs.run_bad, undefined);
  await store.update((d: Doc) => {
    d.runs.run_2 = { id: "run_2", objective: "two", createdAt: Date.now(), updatedAt: Date.now() };
  });
  assert.ok((await store.get()).runs.run_2, "the chain keeps working after a rejection");
  const leftovers = (await readdir(path.dirname(store.storePath))).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp files left behind");
});

test("a corrupt store loads empty and is kept aside", async () => {
  const dir = await tempConfig();
  await mkdir(path.join(dir, "agent-tasks"), { recursive: true });
  await writeFile(path.join(dir, "agent-tasks", "store.json"), "{ not json");
  const store = createStore(dir, { archiveAfterDays: 30 });
  const d = await store.get();
  assert.deepEqual(d.runs, {});
  const files = await readdir(path.join(dir, "agent-tasks"));
  assert.ok(files.some((f) => f.startsWith("store.json.corrupt-")));
});

test("saving archives an old finished run, and restoring brings it back without re-archiving it", async () => {
  const dir = await tempConfig();
  let clock = T0;
  const store = createStore(dir, { archiveAfterDays: () => 30, now: () => clock });
  await store.update((d: Doc) => {
    d.runs.run_old = { id: "run_old", objective: "old", createdAt: T0, updatedAt: T0 };
    d.tasks.task_old = { id: "task_old", runId: "run_old", title: "t", deps: [], outcome: "completed", createdAt: T0, updatedAt: T0 };
    d.runs.run_live = { id: "run_live", objective: "live", createdAt: T0, updatedAt: T0 };
    d.tasks.task_live = { id: "task_live", runId: "run_live", title: "t", deps: [], outcome: null, createdAt: T0, updatedAt: T0 };
  });
  clock = T0 + 40 * DAY;
  await store.update(() => {});
  const live = await store.get();
  assert.equal(live.runs.run_old, undefined);
  assert.equal(live.tasks.task_old, undefined);
  assert.ok(live.runs.run_live, "a run with an open task stays");
  const archive = await store.loadArchive();
  assert.ok(archive.runs.run_old?.tasks.task_old);
  assert.equal((await stat(store.archivePath)).mode & 0o777, 0o600);

  const restored = await store.restoreRun("run_old");
  assert.equal(restored?.id, "run_old");
  await store.update(() => {});
  assert.ok((await store.get()).runs.run_old, "restoring restarts its activity clock");
  assert.equal((await store.loadArchive()).runs.run_old, undefined);
  assert.equal(await store.restoreRun("run_missing"), null);
});
