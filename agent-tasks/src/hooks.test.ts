// agent-tasks' server hook against a fake host: the agent-hook half of worker
// supervision (T12), driven by synthetic events rather than a real agent's
// hooks. A real hook-driven stop needs the agent's hooks installed into a
// HOME, which a unit test has no business writing - so this pins the rule
// that matters: a `stop` for a worker's own pane completes its task, and a
// `stop` for any other pane changes nothing.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { after, before, test } from "node:test";

// server.js resolves its config dir at import time.
const configHome = await mkdtemp(path.join(tmpdir(), "at-hooks-"));
process.env.XDG_CONFIG_HOME = configHome;
const server = await import("../server.js");

type Handler = (req: unknown, res: unknown) => void;
type HookEvent = { event: string | null; paneId: string; payload?: unknown };

const routes = new Map<string, Handler>();
const router = {
  get: (p: string, h: Handler) => routes.set(`GET ${p}`, h),
  post: (p: string, h: Handler) => routes.set(`POST ${p}`, h),
};

let hookSubscription: { events: string[]; onEvent: (e: HookEvent) => void } | null = null;
const typed: { session: string; text: string; submit: boolean }[] = [];
const sessions = new Map<string, { id: string; command: string }[]>();
let paneCounter = 40;

const host = {
  agents: {
    list: async () => [{ id: "t.agents.claude", label: "Claude Code", program: "claude", command: "claude", hooks: true }],
    launchCommand: async (id: string) => (id === "t.agents.claude" ? "claude" : null),
  },
  agentHooks: {
    subscribe(sub: { events: string[]; onEvent: (e: HookEvent) => void }) {
      hookSubscription = sub;
      return () => {
        if (hookSubscription === sub) hookSubscription = null;
      };
    },
  },
  sessions: {
    list: async () => [...sessions.keys()].map((name) => ({ name })),
    create: async (name: string) => {
      sessions.set(name, [{ id: `%${++paneCounter}`, command: "claude" }]);
      return { name };
    },
    listPanes: async (name: string) => {
      const panes = sessions.get(name);
      if (!panes) throw new Error(`no session ${name}`);
      return panes.map((p) => ({ ...p, windowIndex: 0, paneIndex: 0, active: true, paneActive: true, pid: 1, title: "" }));
    },
    sendText: async (session: string, text: string, submit: boolean) => {
      typed.push({ session, text, submit });
    },
  },
  worktrees: {
    create: async ({ branch }: { branch: string }) => {
      const target = path.join(configHome, "worktrees", branch);
      await mkdir(target, { recursive: true });
      return { path: target, branch };
    },
    remove: async ({ path: target, force }: { path: string; force?: boolean }) => {
      removed.push({ path: target, force: force === true });
      if (dirtyWorktrees.has(target) && !force) {
        throw new Error(`fatal: '${target}' contains modified or untracked files, use --force to delete it`);
      }
      return { removed: target };
    },
  },
};
const removed: { path: string; force: boolean }[] = [];
const dirtyWorktrees = new Set<string>();

// A worker verb over the control socket, exactly as cli/agent-task sends one.
function verb(name: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const socketPath = path.join(configHome, "tmux-server", "agent-tasks", "control.sock");
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method: "POST", path: `/${name}`, headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const json = String(res.headers["content-type"] ?? "").includes("json");
          resolve({ status: res.statusCode ?? 0, body: json && data ? JSON.parse(data) : data });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function call(method: string, route: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  const handler = routes.get(`${method} ${route}`);
  if (!handler) throw new Error(`no route ${method} ${route}`);
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      headersSent: false,
      status(code: number) {
        status = code;
        return res;
      },
      json(value: unknown) {
        res.headersSent = true;
        resolve({ status, body: value });
      },
    };
    handler({ method, originalUrl: route, body }, res);
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting");
}

async function stateOf(taskId: string) {
  const { body } = await call("GET", "/state");
  return {
    task: body.tasks.find((t: { id: string }) => t.id === taskId),
    dispatch: body.dispatches.find((d: { taskId: string }) => d.taskId === taskId),
    inbox: body.inbox,
  };
}

async function startedTask(title: string, worktree = "current", runId?: string) {
  const run = runId ? { body: { runId } } : await call("POST", "/run-create", { objective: "hooks", repo: configHome });
  const task = await call("POST", "/task-create", { runId: run.body.runId, title });
  const started = await call("POST", "/worker-start", { taskId: task.body.taskId, agentId: "t.agents.claude", worktree });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return { taskId: task.body.taskId as string, runId: run.body.runId as string, dispatch: started.body.dispatch };
}

before(async () => {
  server.activate({
    router,
    log: () => {},
    getSettings: async () => ({}),
    host,
  });
  await waitFor(() => hookSubscription !== null);
});

after(async () => {
  await server.deactivate();
});

test("the extension subscribes to exactly stop and permission", () => {
  assert.deepEqual([...(hookSubscription?.events ?? [])].sort(), ["permission", "stop"]);
});

test("the socket and the store it creates are private to the user", async () => {
  const sock = path.join(configHome, "tmux-server", "agent-tasks", "control.sock");
  await waitFor(async () => stat(sock).then(() => true, () => false));
  assert.equal((await stat(sock)).mode & 0o777, 0o600);
});

test("a worker launch records a %-prefixed pane id and types the launch line with the ids", async () => {
  const { dispatch } = await startedTask("launch line");
  assert.match(dispatch.paneId, /^%\d+$/);
  const line = typed.find((t) => t.session === dispatch.sessionName);
  assert.ok(line?.submit, "the launch line is submitted");
  assert.match(line.text, new RegExp(`TS_DISPATCH_ID=${dispatch.id}`));
  assert.match(line.text, /export PATH='.*\/tmux-server\/bin':"\$PATH"; claude '/);
});

test("the brief is the agent's first prompt on the launch line, not typed in afterwards", async () => {
  const { dispatch } = await startedTask("brief on launch");
  const forSession = typed.filter((t) => t.session === dispatch.sessionName);
  assert.equal(forSession.length, 1, "only the launch line is typed into the worker's pane");
  const m = forSession[0].text.match(/; claude '(.*)'$/s);
  assert.ok(m, `launch line ends with the quoted brief: ${forSession[0].text}`);
  const brief = m[1].replace(/'\\''/g, "'");
  assert.match(brief, new RegExp(`task ${dispatch.taskId}`));
  assert.match(brief, new RegExp(`dispatch ${dispatch.id}`));
  assert.match(brief, /Task: brief on launch\./);
  assert.doesNotMatch(forSession[0].text, /\n/, "one line - a newline would stall the shell mid-command");
});

test("an unknown agent is a 400 that names it, not a launch of nothing", async () => {
  const run = await call("POST", "/run-create", { objective: "x", repo: configHome });
  const task = await call("POST", "/task-create", { runId: run.body.runId, title: "no agent" });
  const res = await call("POST", "/worker-start", { taskId: task.body.taskId, agentId: "t.agents.missing" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /t\.agents\.missing/);
});

test("a stop for another pane changes nothing", async () => {
  const { taskId } = await startedTask("unrelated stop");
  hookSubscription!.onEvent({ event: "stop", paneId: "%9999", payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { task, dispatch } = await stateOf(taskId);
  assert.equal(task.status, "dispatched");
  assert.equal(dispatch.state, "active");
});

test("an interrupted turn is not the task finishing", async () => {
  const { taskId, dispatch: started } = await startedTask("interrupted");
  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: { is_interrupt: true } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await stateOf(taskId)).task.status, "dispatched");
});

test("a stop for the worker's own pane completes its task, credited to the hook", async () => {
  const { taskId, dispatch: started } = await startedTask("own stop");
  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: {} });
  await waitFor(async () => (await stateOf(taskId)).task.status === "completed");
  const { task, dispatch, inbox } = await stateOf(taskId);
  assert.equal(task.status, "completed");
  assert.equal(dispatch.state, "succeeded");
  assert.equal(dispatch.completedBy, "hook");
  assert.ok(inbox.some((m: { type: string; taskId: string }) => m.type === "done" && m.taskId === taskId));

  // A second stop (the next turn) for a pane whose dispatch has finished is
  // no longer anyone's business.
  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await stateOf(taskId)).dispatch.state, "succeeded");
});

test("a permission prompt files a question naming the tool", async () => {
  const { taskId, dispatch: started } = await startedTask("permission");
  hookSubscription!.onEvent({ event: "permission", paneId: started.paneId, payload: { tool_name: "Bash" } });
  await waitFor(async () => (await stateOf(taskId)).inbox.some((m: { taskId: string }) => m.taskId === taskId));
  const { inbox, dispatch } = await stateOf(taskId);
  const question = inbox.find((m: { taskId: string }) => m.taskId === taskId);
  assert.equal(question.type, "question");
  assert.match(question.body, /Bash/);
  assert.equal(dispatch.awaiting, "permission");
});

test("a worker that used agent-task is not finished by a turn end, and is flagged once", async () => {
  const { taskId, dispatch: started } = await startedTask("stops early");
  assert.equal((await verb("heartbeat", { dispatchId: started.id, status: "working" })).status, 200);

  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: {} });
  const escalations = async () =>
    (await stateOf(taskId)).inbox.filter((m: { type: string; taskId: string }) => m.type === "escalation" && m.taskId === taskId);
  await waitFor(async () => (await escalations()).length === 1);
  let { task, dispatch } = await stateOf(taskId);
  assert.equal(task.status, "dispatched", "unfinished work is not marked succeeded");
  assert.equal(dispatch.state, "active");
  assert.equal(dispatch.awaiting, "turn-ended");
  assert.match((await escalations())[0].body, /without running agent-task done/);

  // The next turn end while still waiting adds nothing to the inbox.
  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await escalations()).length, 1);

  // Back at work: using the CLI again clears the wait.
  await verb("heartbeat", { dispatchId: started.id });
  ({ dispatch } = await stateOf(taskId));
  assert.equal(dispatch.awaiting, null);

  // Only its own done finishes it.
  assert.equal((await verb("done", { dispatchId: started.id, outcome: "succeeded", body: "finished" })).status, 200);
  ({ task, dispatch } = await stateOf(taskId));
  assert.equal(task.status, "completed");
  assert.equal(dispatch.completedBy, "cli");
});

test("reading the brief or status from the pane counts as using agent-task", async () => {
  const { taskId, dispatch: started } = await startedTask("reads brief");
  assert.equal((await verb("dispatch-show", { dispatchId: started.id })).status, 200);
  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: {} });
  await waitFor(async () => (await stateOf(taskId)).dispatch.awaiting === "turn-ended");
  assert.equal((await stateOf(taskId)).task.status, "dispatched");
});

test("cleanup refuses a running worker", async () => {
  const { dispatch } = await startedTask("still running");
  const res = await call("POST", "/worker-cleanup", { dispatchId: dispatch.id, removeWorktree: true });
  assert.equal(res.status, 409);
});

test("a finished worker's own worktree can be removed, keeping the branch; the state shows what is left", async () => {
  const { taskId, dispatch: started } = await startedTask("own worktree", "new");
  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: {} });
  await waitFor(async () => (await stateOf(taskId)).task.status === "completed");
  let { dispatch } = await stateOf(taskId);
  assert.equal(dispatch.sessionAlive, true, "the idle agent's session is still there");
  assert.equal(dispatch.worktreeRemovable, true);

  const res = await call("POST", "/worker-cleanup", { dispatchId: started.id, removeWorktree: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.worktree.removed, true);
  assert.equal(res.body.sessionName, started.sessionName, "the panel is told which session to close");
  assert.ok(removed.some((r) => r.path === path.join(configHome, "worktrees", dispatch.worktreePath.split("/").pop()!) || r.path.endsWith(dispatch.worktreePath.split("/").pop()!)));
  ({ dispatch } = await stateOf(taskId));
  assert.equal(dispatch.worktreeRemovable, false);

  // Closing the session (the panel does it through killSession) shows as gone.
  sessions.delete(started.sessionName);
  ({ dispatch } = await stateOf(taskId));
  assert.equal(dispatch.sessionAlive, false);
});

test("the run's repo and a path the user gave are never removed", async () => {
  const { taskId, dispatch: started } = await startedTask("in the repo", "current");
  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: {} });
  await waitFor(async () => (await stateOf(taskId)).task.status === "completed");
  assert.equal((await stateOf(taskId)).dispatch.worktreeRemovable, false);
  const before = removed.length;
  const res = await call("POST", "/worker-cleanup", { dispatchId: started.id, removeWorktree: true });
  assert.equal(res.body.worktree.removed, false);
  assert.match(res.body.worktree.reason, /left alone/);
  assert.equal(removed.length, before, "git was never asked");
});

test("a dirty worktree is reported, not forced, until the caller says force", async () => {
  const { taskId, dispatch: started } = await startedTask("dirty", "new");
  hookSubscription!.onEvent({ event: "stop", paneId: started.paneId, payload: {} });
  await waitFor(async () => (await stateOf(taskId)).task.status === "completed");
  const target = removedTargetFor(started);
  dirtyWorktrees.add(target);

  let res = await call("POST", "/worker-cleanup", { dispatchId: started.id, removeWorktree: true });
  assert.equal(res.body.worktree.removed, false);
  assert.equal(res.body.worktree.dirty, true);
  assert.equal((await stateOf(taskId)).dispatch.worktreeRemovable, true, "still offered");

  res = await call("POST", "/worker-cleanup", { dispatchId: started.id, removeWorktree: true, force: true });
  assert.equal(res.body.worktree.removed, true);
  assert.deepEqual(removed.at(-1), { path: target, force: true });
});

test("a worktree an active worker is using is left alone, and run cleanup reports sessions to close", async () => {
  const a = await startedTask("first", "new");
  hookSubscription!.onEvent({ event: "stop", paneId: a.dispatch.paneId, payload: {} });
  await waitFor(async () => (await stateOf(a.taskId)).task.status === "completed");
  const worktreeA = removedTargetFor(a.dispatch);
  // A second worker in the first one's worktree, still running.
  const b = await startedTask("second", worktreeA, a.runId);
  assert.equal((await stateOf(a.taskId)).dispatch.worktreeRemovable, false, "in use by b");

  let res = await call("POST", "/run-cleanup", { runId: a.runId, removeWorktrees: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.sessions, [a.dispatch.sessionName], "only the finished worker's session");
  assert.equal(res.body.worktrees[0].removed, false);
  assert.match(res.body.worktrees[0].reason, /in use/);

  // Once b is done too, run cleanup removes the worktree and lists both sessions.
  assert.equal((await verb("done", { dispatchId: b.dispatch.id, outcome: "succeeded" })).status, 200);
  res = await call("POST", "/run-cleanup", { runId: a.runId, removeWorktrees: true });
  assert.deepEqual([...res.body.sessions].sort(), [a.dispatch.sessionName, b.dispatch.sessionName].sort());
  assert.equal(res.body.worktrees.length, 1);
  assert.equal(res.body.worktrees[0].removed, true);
});

// The absolute path the fake host created for a "new" worker.
function removedTargetFor(dispatch: { worktreePath: string }) {
  return path.join(configHome, "worktrees", dispatch.worktreePath.split("/").pop()!);
}

test("a second activate() tears the first down instead of failing to bind", async () => {
  server.activate({ router, log: () => {}, getSettings: async () => ({}), host });
  const sock = path.join(configHome, "tmux-server", "agent-tasks", "control.sock");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitFor(async () => stat(sock).then(() => true, () => false));
  assert.ok(hookSubscription, "the new activation subscribed again");
});
