// automations server hook: agent work that starts itself. An automation is a
// trigger plus an action:
//
//   triggers  daily / interval / cron schedules (schedule.mjs), checked by a
//             15s tick that runs with no browser connected; or an agent-tasks
//             lifecycle event (task-completed, task-failed, task-blocked,
//             gate-opened, worker-lost) from its control socket's `subscribe`
//             stream.
//   actions   headless     one prompt through the app's AI (host.ai.run), the
//                          reply kept as the automation's last result;
//             create-task  a task in agent-tasks (a run is made for it);
//             start-worker the same, then a worker started on it.
//
// The two agent-tasks actions and every event trigger go through agent-tasks'
// 0600 unix socket - the same door its CLI uses - so this extension never
// imports it and works without it: schedule + headless needs nothing else,
// and the rest say "Agent Tasks is not installed" instead of failing.
//
// A server that was down when a schedule came due fires it once on startup
// only if it is within automations.missedRunGraceMinutes; older misses are
// rescheduled without running.
//
// Every route, the tick, the stream handler and each action run catch their
// own errors: this may run on a core that exits the whole server on an
// unhandled rejection.
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { describeTrigger, dueAction, isSchedule, nextRun, normalizeTrigger } from "./schedule.mjs";
import { createAutomationStore, newAutomationId } from "./store.mjs";

const TICK_MS = 15_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const RESULT_MAX = 8_000;
const PROMPT_MAX = 20_000;
const NOT_INSTALLED = "Agent Tasks is not installed";
const ACTION_KINDS = ["headless", "create-task", "start-worker"];

const HOME = homedir();
const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "tmux-server");
const agentTasksSocket = path.join(configDir, "agent-tasks", "control.sock");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

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

function expandHome(p) {
  if (p === "~") return HOME;
  if (typeof p === "string" && p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

function text(value, name, { required = false, max = 200 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`${name} is required`);
    return "";
  }
  if (typeof value !== "string") throw bad(`${name} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw bad(`${name} is required`);
  if (trimmed.length > max) throw bad(`${name} is longer than ${max} characters`);
  return trimmed;
}

// ---- agent-tasks' socket ----

class SocketUnavailable extends Error {}

function socketPost(verb, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      {
        socketPath: agentTasksSocket,
        path: `/${verb}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: 60_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // not JSON
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(parsed?.error ?? `agent-tasks answered ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("agent-tasks did not answer in time")));
    req.on("error", (err) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") reject(new SocketUnavailable(NOT_INSTALLED));
      else reject(err);
    });
    req.end(payload);
  });
}

// ---- Normalization ----

function normalizeAction(raw) {
  const kind = raw?.kind;
  if (!ACTION_KINDS.includes(kind)) throw bad(`action kind must be one of: ${ACTION_KINDS.join(", ")}`);
  const prompt = text(raw.prompt, "prompt", { required: true, max: PROMPT_MAX });
  const action = { kind, prompt };
  if (kind !== "headless") action.title = text(raw.title, "title") || "";
  if (kind === "start-worker") {
    action.agentId = text(raw.agentId, "agentId", { required: true });
    const worktree = text(raw.worktree, "worktree", { max: 4096 }) || "new";
    action.worktree = worktree;
  }
  return action;
}

// ---- Module state ----
// Resident across a disable -> enable cycle; see agent-tasks/server.js for
// the same pattern. The previous activation is torn down before the next
// one starts its tick and its stream.

let store = null;
let current = null;

function teardown(instance) {
  if (!instance) return;
  instance.stopped = true;
  clearInterval(instance.tickTimer);
  clearTimeout(instance.reconnectTimer);
  instance.stream?.destroy();
  instance.stream = null;
}

export function deactivate() {
  teardown(current);
  current = null;
}

export function activate({ router, log = console.log, getSettings, host, ai }) {
  if (!store) store = createAutomationStore(configDir);
  const s = store;
  const instance = {
    stopped: false,
    tickTimer: null,
    reconnectTimer: null,
    stream: null,
    connected: false,
    lastError: null,
    running: new Set(),
  };
  teardown(current);
  current = instance;
  const runAi = ai?.run ?? host?.ai?.run;

  async function settings() {
    const raw = await getSettings().catch(() => ({}));
    const grace = Number(raw["automations.missedRunGraceMinutes"]);
    return {
      graceMinutes: Number.isFinite(grace) ? Math.min(1440, Math.max(0, grace)) : 60,
      aiProfile: typeof raw["automations.aiProfile"] === "string" ? raw["automations.aiProfile"].trim() : "",
    };
  }

  // ---- Running an action ----

  function eventContext(event) {
    if (!event) return "";
    const lines = [`Triggered by agent-tasks event: ${event.type}`];
    if (event.title) lines.push(`Task: ${event.title} (${event.taskId})`);
    if (event.question) lines.push(`Question: ${event.question}`);
    if (event.runId) lines.push(`Run: ${event.runId}`);
    if (event.repo) lines.push(`Repository: ${event.repo}`);
    return `\n\n${lines.join("\n")}`;
  }

  async function perform(automation, event) {
    const { action } = automation;
    const repo = automation.repo ? expandHome(automation.repo) : "";
    const prompt = `${action.prompt}${eventContext(event)}`;
    if (action.kind === "headless") {
      if (typeof runAi !== "function") throw new Error("this tmux-server has no AI backend for extensions - update it");
      const { aiProfile } = await settings();
      const reply = await runAi(prompt, { profileId: aiProfile || undefined, cwd: repo || undefined });
      return reply;
    }
    const title = action.title || automation.name;
    const created = await socketPost("task-create", {
      objective: `${automation.name} (automation)`,
      repo,
      title,
      spec: prompt,
    });
    if (action.kind === "create-task") return `Created task ${created.taskId} in run ${created.runId}.`;
    const started = await socketPost("worker-start", {
      taskId: created.taskId,
      agentId: action.agentId,
      worktree: action.worktree,
    });
    return `Started a worker (${started.dispatchId}) in session ${started.dispatch?.sessionName ?? "?"} on task ${created.taskId}.`;
  }

  // Runs one automation now and records the outcome. Never rejects. An
  // automation already running is not started a second time on top of
  // itself; the skipped run is recorded so nobody wonders where it went.
  async function runAutomation(id, reason, event) {
    const automation = await s.get(id);
    if (!automation) return null;
    if (instance.running.has(id)) {
      log(`automation ${automation.name}: still running, ${reason} run skipped`);
      return { skipped: true };
    }
    instance.running.add(id);
    const startedAt = Date.now();
    let status = "ok";
    let result;
    try {
      result = await perform(automation, event);
    } catch (err) {
      status = err instanceof SocketUnavailable ? "unavailable" : "error";
      result = err?.message ?? String(err);
    } finally {
      instance.running.delete(id);
    }
    const resultText = String(result ?? "").slice(0, RESULT_MAX);
    try {
      await s.update((doc) => {
        const entry = doc.automations[id];
        if (!entry) return;
        entry.lastRunAt = startedAt;
        entry.lastResult = resultText;
        entry.lastStatus = status;
        entry.lastReason = reason;
        entry.runCount = (entry.runCount ?? 0) + 1;
        if (isSchedule(entry.trigger)) entry.nextRunAt = nextRun(entry.trigger, entry.trigger.kind === "interval" ? startedAt : Date.now());
      });
    } catch (err) {
      log(`automation ${automation.name}: could not record its result:`, err?.message ?? err);
    }
    log(`automation ${automation.name} (${reason}): ${status}`);
    return { status, result: resultText };
  }

  // ---- Scheduler ----

  async function tick({ startup = false } = {}) {
    const { graceMinutes } = await settings();
    const now = Date.now();
    const toFire = [];
    await s.update((doc) => {
      for (const entry of Object.values(doc.automations)) {
        if (!isSchedule(entry.trigger)) continue;
        if (typeof entry.nextRunAt !== "number") entry.nextRunAt = nextRun(entry.trigger, now);
        const decision = dueAction(entry, now, { startup, graceMinutes });
        if (decision === "skip") {
          entry.lastStatus = "missed";
          entry.lastResult = `Missed the run due ${new Date(entry.nextRunAt).toLocaleString()} while the server was down (outside the ${graceMinutes} minute grace window).`;
          entry.nextRunAt = nextRun(entry.trigger, now);
        } else if (decision === "fire" && !instance.running.has(entry.id)) {
          toFire.push(entry.id);
          // Moved on now, so the next tick cannot fire it again while this
          // run is still in flight.
          entry.nextRunAt = nextRun(entry.trigger, now);
        }
      }
    });
    for (const id of toFire) {
      if (instance.stopped) return;
      void runAutomation(id, startup ? "missed" : "schedule");
    }
  }

  // ---- Event stream ----

  function matches(trigger, event) {
    if (trigger.event !== event.type) return false;
    if (trigger.runId && trigger.runId !== event.runId) return false;
    if (trigger.repo) {
      const want = expandHome(trigger.repo).replace(/\/+$/, "");
      if (want !== String(event.repo ?? "").replace(/\/+$/, "")) return false;
    }
    return true;
  }

  async function onEvent(event) {
    if (!event?.type || event.type === "hello" || event.type === "ping") return;
    const automations = await s.list();
    for (const a of automations) {
      if (a.enabled && a.trigger?.kind === "event" && matches(a.trigger, event)) {
        void runAutomation(a.id, "event", event);
      }
    }
  }

  function scheduleReconnect(delay) {
    if (instance.stopped) return;
    clearTimeout(instance.reconnectTimer);
    instance.reconnectTimer = setTimeout(() => connect(Math.min(RECONNECT_MAX_MS, delay * 2)), delay);
    instance.reconnectTimer.unref?.();
  }

  // Holds agent-tasks' `subscribe` stream open, reconnecting with a backoff
  // that doubles to a 60s cap. `connected` is what the panel's "Requires the
  // Agent Tasks extension" note follows.
  function connect(nextDelay = RECONNECT_MIN_MS) {
    if (instance.stopped) return;
    let buffer = "";
    let settled = false;
    const down = (err) => {
      if (settled) return;
      settled = true;
      instance.connected = false;
      instance.stream = null;
      instance.lastError = err ? (err.code === "ENOENT" || err.code === "ECONNREFUSED" ? NOT_INSTALLED : err.message) : "stream closed";
      scheduleReconnect(nextDelay);
    };
    const req = http.request(
      { socketPath: agentTasksSocket, path: "/subscribe", method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          down(new Error(`subscribe answered ${res.statusCode}`));
          return;
        }
        instance.connected = true;
        instance.lastError = null;
        nextDelay = RECONNECT_MIN_MS;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            onEvent(event).catch((err) => log("event handling failed:", err?.stack ?? err));
          }
        });
        res.on("end", () => down(null));
        res.on("error", (err) => down(err));
      },
    );
    req.on("error", (err) => down(err));
    req.end("{}");
    instance.stream = req;
  }

  // ---- Routes ----

  async function decorate(list) {
    return list.map((a) => ({
      ...a,
      triggerSummary: describeTrigger(a.trigger),
      running: instance.running.has(a.id),
      needsAgentTasks: (a.trigger?.kind === "event" || a.action?.kind !== "headless") && !instance.connected,
    }));
  }

  function buildEntry(body, existing) {
    const name = text(body.name ?? existing?.name, "name", { required: true });
    let trigger;
    try {
      trigger = normalizeTrigger(body.trigger ?? existing?.trigger);
    } catch (err) {
      throw bad(err.message);
    }
    const action = normalizeAction(body.action ?? existing?.action);
    const repo = text(body.repo ?? existing?.repo ?? "", "repo", { max: 4096 });
    if (action.kind === "start-worker" && action.worktree !== "path" && !repo) {
      throw bad("a start-worker automation needs a repository");
    }
    const enabled = body.enabled === undefined ? (existing?.enabled ?? true) : body.enabled === true;
    return { name, trigger, action, repo, enabled };
  }

  const route = (fn) => wrap(fn, log);

  router.get(
    "/list",
    route(async (_req, res) => {
      res.json({
        automations: await decorate(await s.list()),
        agentTasks: { connected: instance.connected, error: instance.lastError },
        tickSeconds: TICK_MS / 1000,
      });
    }),
  );

  router.post(
    "/create",
    route(async (req, res) => {
      const fields = buildEntry(req.body ?? {});
      const now = Date.now();
      const entry = {
        id: newAutomationId(),
        ...fields,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastResult: "",
        lastStatus: null,
        runCount: 0,
        nextRunAt: nextRun(fields.trigger, now),
      };
      await s.update((doc) => {
        doc.automations[entry.id] = entry;
      });
      res.json({ automation: (await decorate([entry]))[0] });
    }),
  );

  router.post(
    "/update",
    route(async (req, res) => {
      const id = text(req.body?.id, "id", { required: true });
      const updated = await s.update((doc) => {
        const existing = doc.automations[id];
        if (!existing) throw new HttpError(404, `no automation ${id}`);
        const fields = buildEntry(req.body ?? {}, existing);
        const triggerChanged = JSON.stringify(fields.trigger) !== JSON.stringify(existing.trigger);
        const reenabled = fields.enabled && !existing.enabled;
        Object.assign(existing, fields, { updatedAt: Date.now() });
        // A new schedule, or one switched back on, counts from now - a job
        // disabled last week must not fire the moment it is re-enabled.
        if (triggerChanged || reenabled) existing.nextRunAt = nextRun(existing.trigger, Date.now());
        return existing;
      });
      res.json({ automation: (await decorate([updated]))[0] });
    }),
  );

  router.post(
    "/delete",
    route(async (req, res) => {
      const id = text(req.body?.id, "id", { required: true });
      await s.update((doc) => {
        if (!doc.automations[id]) throw new HttpError(404, `no automation ${id}`);
        delete doc.automations[id];
      });
      res.json({ deleted: id });
    }),
  );

  router.post(
    "/run/:id",
    route(async (req, res) => {
      const automation = await s.get(req.params.id);
      if (!automation) throw new HttpError(404, `no automation ${req.params.id}`);
      if (instance.running.has(automation.id)) throw new HttpError(409, "already running");
      // Answered at once; a headless prompt can take a minute. The panel
      // polls for the result.
      void runAutomation(automation.id, "manual");
      res.json({ started: true });
    }),
  );

  // ---- Start ----

  (async () => {
    if (instance.stopped) return;
    await tick({ startup: true }).catch((err) => log("startup schedule pass failed:", err?.stack ?? err));
    if (instance.stopped) return;
    instance.tickTimer = setInterval(() => {
      if (instance.stopped) return;
      tick().catch((err) => log("scheduler tick failed:", err?.stack ?? err));
    }, TICK_MS);
    instance.tickTimer.unref?.();
    connect();
  })().catch((err) => log("activation failed:", err?.stack ?? err));
}
