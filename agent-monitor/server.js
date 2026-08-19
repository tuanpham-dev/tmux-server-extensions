// agent-monitor server hook: lists every tmux pane running a configured
// agent program and classifies each as working/waiting/done — the source
// for the PROJECTS-pane window-row status dot. Detection is Orca-style
// dual-signal:
//
//   1. an opt-in Claude Code hooks event (POST /event, see the bottom of this
//      file) for the pane's resolved Claude session id, when fresher than
//      that session's last transcript write — the high-fidelity signal.
//   2. else the pane's tmux title: Claude Code sets an OSC title of
//      "<glyph> <task>" — a rotating quarter-circle glyph (◐◑◓◒) while
//      working, a fixed "✳" once idle — captured live against a real
//      session on this machine (2026-08-18): working looked like
//      "◐ Review onorca.dev and suggest new features" / "◑ Hello", idle
//      looked like "✳ Claude Code" / "✳ Hello". An unrecognized title
//      shape (a non-Claude agent, or a title format this hasn't seen) is
//      *no signal* — falls through to step 3, never invented as a state.
//   3. else the cwd's most-recent Claude session transcript's mtime (ported
//      from core's subagentWatcher.ts / this repo's own claude-auto-retry
//      convention): written within the threshold -> working, else waiting.
//      No transcript at all (a non-Claude agent) -> waiting.
//
// Never writes into a pane — read-only tmux/filesystem queries only.
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const TMUX_TIMEOUT = 5000;
const CLAUDE_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");
const WINDOW_TAB_PREFIX = "tmuxserver-view-";

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8", timeout: TMUX_TIMEOUT }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

function emptyIfNoServer(err) {
  if (/no server running|error connecting|no current target/i.test(err.message)) return "";
  throw err;
}

// ---- Pane listing (claude-auto-retry's listClaudePanes pattern: list-panes
// -a returns the same real pane once per grouped tmuxserver-view-* session
// it also belongs to — dedup by pane id, preferring the non-view name) ----

async function listAgentPanes(programsCsv) {
  const programs = programsCsv
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  let raw;
  try {
    raw = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}",
    ]).catch(emptyIfNoServer);
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, sessionName, windowIndexStr, windowName, command, cwd, title] = line.split("\t");
    if (!programs.includes(command)) continue;
    const isGroupedView = sessionName.startsWith(WINDOW_TAB_PREFIX);
    const existing = byId.get(paneId);
    if (!existing || (existing.isGroupedView && !isGroupedView)) {
      byId.set(paneId, {
        paneId,
        sessionName,
        windowIndex: Number(windowIndexStr),
        windowName,
        command,
        cwd,
        title,
        isGroupedView,
      });
    }
  }
  return [...byId.values()].map(({ isGroupedView: _isGroupedView, ...rest }) => rest);
}

// ---- Claude project-dir / session-id resolution (ported from core's
// subagentWatcher.ts / extensions/subagent-viewer/server.js — extensions
// can't import each other) ----

function cwdToProjectDirName(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

async function mostRecentSessionId(projectDir) {
  let entries;
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }
  const jsonlNames = entries.filter((e) => e.endsWith(".jsonl") && !e.includes("/"));
  let best = null;
  for (const name of jsonlNames) {
    try {
      const s = await stat(path.join(projectDir, name));
      const id = name.slice(0, -".jsonl".length);
      if (!best || s.mtimeMs > best.mtimeMs) best = { id, mtimeMs: s.mtimeMs };
    } catch {
      // Skip — vanished mid-scan.
    }
  }
  return best;
}

const SESSION_ID_TTL_MS = 15_000;
const sessionIdCache = new Map();

// Returns { id, mtimeMs } of the cwd's most recently active Claude session,
// or null — cached per project dir like subagent-viewer's own resolver.
async function mostRecentSessionCached(projectDir) {
  const cached = sessionIdCache.get(projectDir);
  if (cached && Date.now() - cached.at < SESSION_ID_TTL_MS) return cached.value;
  const value = await mostRecentSessionId(projectDir);
  sessionIdCache.set(projectDir, { at: Date.now(), value });
  return value;
}

// ---- Pane-title classification (see this file's header for the captured
// evidence) ----

const WORKING_GLYPHS = new Set(["◐", "◑", "◓", "◒"]);
const IDLE_GLYPH = "✳";

// Splits "<glyph> <rest>" into { glyph, label }, or null if the title
// doesn't have that shape at all (a non-Claude agent, or a blank/default
// terminal title like "code-server").
function parseAgentTitle(title) {
  if (!title) return null;
  const m = /^(\S+)\s+(.*)$/.exec(title.trim());
  if (!m) return null;
  return { glyph: m[1], label: m[2] };
}

// ---- Hook events (T18) — keyed by Claude session_id so two agent panes
// sharing a cwd can't cross-contaminate each other's permission/done state ----

const MAX_HOOK_EVENTS = 200;
const hookEvents = new Map(); // sessionId -> { state: "permission" | "done", at }
let hookEventsReceived = 0;
let hookEventsLastAt = null;

function recordHookEvent(sessionId, state) {
  if (hookEvents.size >= MAX_HOOK_EVENTS && !hookEvents.has(sessionId)) {
    const oldestKey = hookEvents.keys().next().value;
    if (oldestKey !== undefined) hookEvents.delete(oldestKey);
  }
  hookEvents.set(sessionId, { state, at: Date.now() });
  hookEventsReceived++;
  hookEventsLastAt = Date.now();
}

// ---- Classification ----

async function classifyPane(pane, waitingThresholdMs) {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, cwdToProjectDirName(pane.cwd));
  const session = await mostRecentSessionCached(projectDir);
  const transcriptMtime = session?.mtimeMs ?? null;

  // 1. Hook event, when fresher than the last transcript write.
  if (session) {
    const hook = hookEvents.get(session.id);
    if (hook && (transcriptMtime === null || hook.at >= transcriptMtime)) {
      return hook.state === "permission"
        ? { state: "waiting", stateDetail: "permission", lastActivityAt: hook.at }
        : { state: "done", lastActivityAt: hook.at };
    }
  }

  // 2. Pane-title spinner rule.
  const parsed = parseAgentTitle(pane.title);
  if (parsed) {
    if (WORKING_GLYPHS.has(parsed.glyph)) {
      return { state: "working", taskLabel: parsed.label, lastActivityAt: transcriptMtime };
    }
    if (parsed.glyph === IDLE_GLYPH) {
      return { state: "waiting", taskLabel: parsed.label, lastActivityAt: transcriptMtime };
    }
    // Recognized shape but unknown glyph (a future Claude Code build, or a
    // non-Claude agent whose title happens to match) — no signal from the
    // title; fall through to the transcript check below.
  }

  // 3. Transcript-mtime fallback.
  if (transcriptMtime === null) {
    return { state: "waiting", lastActivityAt: null };
  }
  const working = Date.now() - transcriptMtime < waitingThresholdMs;
  return { state: working ? "working" : "waiting", lastActivityAt: transcriptMtime };
}

const CLASSIFY_CACHE_TTL_MS = 2_000;
const classifyCache = new Map(); // cwd -> { at, value }

async function classifyPaneCached(pane, waitingThresholdMs) {
  const cached = classifyCache.get(pane.cwd);
  if (cached && Date.now() - cached.at < CLASSIFY_CACHE_TTL_MS) return cached.value;
  const value = await classifyPane(pane, waitingThresholdMs);
  classifyCache.set(pane.cwd, { at: Date.now(), value });
  return value;
}

export function activate({ router, getSettings }) {
  router.get("/agents", async (_req, res) => {
    try {
      const settings = await getSettings();
      const programs = typeof settings["agentMonitor.programs"] === "string" && settings["agentMonitor.programs"].trim()
        ? settings["agentMonitor.programs"]
        : "claude";
      const thresholdSeconds = Number(settings["agentMonitor.waitingThresholdSeconds"]);
      const waitingThresholdMs = (Number.isFinite(thresholdSeconds) && thresholdSeconds > 0 ? thresholdSeconds : 15) * 1000;

      const panes = await listAgentPanes(programs);
      const rows = await Promise.all(
        panes.map(async (pane) => {
          const classification = await classifyPaneCached(pane, waitingThresholdMs);
          return {
            sessionName: pane.sessionName,
            windowIndex: pane.windowIndex,
            windowName: pane.windowName,
            command: pane.command,
            cwd: pane.cwd,
            ...classification,
          };
        }),
      );
      res.json({ agents: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Claude Code hooks post here (see the settings component's copy-paste
  // snippet in src/client.tsx) — a plain curl with no Origin header, which
  // passes the app's auth/origin gate the same way shell-integration
  // reports do (server/src/security.ts's isOriginExemptPath).
  router.post("/event", (req, res) => {
    const { hook_event_name: hookEventName, session_id: sessionId } = req.body ?? {};
    if (typeof sessionId !== "string" || !sessionId) {
      res.status(400).json({ error: "session_id is required" });
      return;
    }
    if (hookEventName === "Notification") recordHookEvent(sessionId, "permission");
    else if (hookEventName === "Stop") recordHookEvent(sessionId, "done");
    res.status(204).end();
  });

  router.get("/event-status", (_req, res) => {
    // port: same-process as core (server hooks mount into the one Express
    // app), so process.env.PORT is exactly the port core itself listens on
    // (server/src/index.ts's own default) — the settings snippet needs it to
    // build a 127.0.0.1 curl target, mirroring shellIntegration.ts's own
    // convention (a local curl, not a browser-relative URL: the hook runs on
    // whichever host the tmux panes live on, which may differ from whatever
    // host the browser used to load this page over a LAN/tunnel).
    res.json({
      received: hookEventsReceived,
      lastAt: hookEventsLastAt,
      port: Number(process.env.PORT ?? 3001),
    });
  });
}
