// agent-tasks' server hook against a fake host: the agent-hook half of worker
// supervision (T12), driven by synthetic events rather than a real agent's
// hooks. A real hook-driven stop needs the agent's hooks installed into a
// HOME, which a unit test has no business writing - so this pins the rule
// that matters: a `stop` for a worker's own pane completes its task, and a
// `stop` for any other pane changes nothing.
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    create: async () => {
      throw new Error("not used");
    },
  },
};

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

async function startedTask(title: string) {
  const run = await call("POST", "/run-create", { objective: "hooks", repo: configHome });
  const task = await call("POST", "/task-create", { runId: run.body.runId, title });
  const started = await call("POST", "/worker-start", { taskId: task.body.taskId, agentId: "t.agents.claude" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  return { taskId: task.body.taskId as string, dispatch: started.body.dispatch };
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

test("a second activate() tears the first down instead of failing to bind", async () => {
  server.activate({ router, log: () => {}, getSettings: async () => ({}), host });
  const sock = path.join(configHome, "tmux-server", "agent-tasks", "control.sock");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitFor(async () => stat(sock).then(() => true, () => false));
  assert.ok(hookSubscription, "the new activation subscribed again");
});
