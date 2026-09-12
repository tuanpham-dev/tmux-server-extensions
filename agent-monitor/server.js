// agent-monitor server hook: lists every tmux pane running one of the
// agents in core's registry and classifies each as working/waiting/done —
// the source for the PROJECTS-pane window-row status dot. Detection is
// Orca-style dual-signal:
//
//   1. an agent hook event from core's pipeline
//      (host.agentHooks.subscribe), keyed by the pane it fired in and used
//      when fresher than that pane's last transcript write — the
//      high-fidelity signal.
//   2. else the pane's tmux title, but only when it actually says something:
//      Claude Code sets an OSC title of "<glyph> <task>". A rotating
//      quarter-circle glyph (◐◑◓◒) means working. "✳" does NOT mean idle —
//      re-checked live on 2026-09-10 against a pane that was busy running
//      tools for minutes, where the title sat at "✳ Status bar additions"
//      the whole time (12 samples over 5s, never once a quarter-circle). It
//      is Claude's own mark, not a spinner, so it yields only the task
//      LABEL and the state falls through to step 3. Same for any other
//      glyph — a title's shape is never invented into a state.
//   3. else the cwd's most-recent Claude session transcript's mtime (ported
//      from core's subagentWatcher.ts / this repo's own claude-auto-retry
//      convention): written within the threshold -> working, else waiting.
//      No transcript at all (a non-Claude agent) -> waiting.
//
// Never writes into a pane — read-only tmux/filesystem queries only.
//
// Both halves used to be this extension's own: a duplicated "what is an
// agent" setting, and a pasted hooks snippet curling a route of its own
// (which carried no auth header and only worked because a request with no
// Origin passes the gate). Core owns both now — the registry in Settings →
// Agents, and the hook pipeline that installs, receives and normalizes
// events — so this file consumes them instead
// (plans/agent-platform-core.md). Keying on the pane rather than on
// Claude's own session_id is what makes the hook path work for Codex and
// Antigravity at all: neither sends a session id.
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

async function listAgentPanes(programs) {
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

// Which session file to watch is worth caching — a readdir + a stat per
// entry, and the answer only changes when a new session starts. Its MTIME is
// not: that number IS the working/waiting signal, and a cached one made the
// state up to SESSION_ID_TTL_MS stale on top of the threshold, so a pane
// that had just written its transcript still read as "waiting for you" for
// the rest of the TTL. The id comes from the cache; the mtime is re-stat'd
// every call, which is one stat on a known path.
async function mostRecentSessionCached(projectDir) {
  const cached = sessionIdCache.get(projectDir);
  let value = cached && Date.now() - cached.at < SESSION_ID_TTL_MS ? cached.value : undefined;
  if (value === undefined) {
    value = await mostRecentSessionId(projectDir);
    sessionIdCache.set(projectDir, { at: Date.now(), value });
  }
  if (!value) return value;
  try {
    const fresh = await stat(path.join(projectDir, `${value.id}.jsonl`));
    return { id: value.id, mtimeMs: fresh.mtimeMs };
  } catch {
    // Vanished (a cleared session) — drop the cache entry so the next call
    // re-resolves rather than reporting a file that is gone.
    sessionIdCache.delete(projectDir);
    return null;
  }
}

// ---- Pane-title classification (see this file's header for the captured
// evidence) ----

const WORKING_GLYPHS = new Set(["◐", "◑", "◓", "◒"]);
// Claude Code's own mark in the title. Present whether it's working or
// waiting (see classifyPane's step 2), so it identifies the agent and the
// task text — never the state.
const CLAUDE_GLYPH = "✳";

// Splits "<glyph> <rest>" into { glyph, label }, or null if the title
// doesn't have that shape at all (a non-Claude agent, or a blank/default
// terminal title like "code-server").
function parseAgentTitle(title) {
  if (!title) return null;
  const m = /^(\S+)\s+(.*)$/.exec(title.trim());
  if (!m) return null;
  return { glyph: m[1], label: m[2] };
}

// ---- Hook events — keyed by tmux pane id, so two agent panes sharing a cwd
// can't cross-contaminate each other's state, and so an agent that sends no
// session id of its own (Codex, Antigravity) is served just as well as
// Claude Code ----

const MAX_HOOK_EVENTS = 200;
const hookEvents = new Map(); // paneId -> { state: "permission" | "working" | "done", at }

// How much later than a hook event a transcript write can be while still
// counting as part of the same turn rather than as the agent moving on —
// see classifyPane's step 1 for the measurement this exists for.
const HOOK_TRANSCRIPT_GRACE_MS = 2_000;

function recordHookEvent(paneId, state) {
  if (!paneId) return;
  if (hookEvents.size >= MAX_HOOK_EVENTS && !hookEvents.has(paneId)) {
    const oldestKey = hookEvents.keys().next().value;
    if (oldestKey !== undefined) hookEvents.delete(oldestKey);
  }
  hookEvents.set(paneId, { state, at: Date.now() });
}

// Core's normalized event names -> the state this extension shows. The two
// that nothing else can observe are `permission` (a prompt writes nothing to
// any transcript) and `stop` ("finished, your turn", otherwise a guess from
// how long a file has been quiet). `prompt-submit` and `tool-start` turn the
// other half of the guess into a fact: the pane is working the moment a turn
// begins or a tool starts, rather than once a transcript happens to be
// flushed. `tool-start` only arrives when the user has turned on
// per-tool-call hooks, and never arrives from Antigravity at all, which is
// why the transcript-timing fallback below stays.
const HOOK_STATES = {
  permission: "permission",
  stop: "done",
  "prompt-submit": "working",
  "tool-start": "working",
};

// ---- Classification ----

async function classifyPane(pane, waitingThresholdMs) {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, cwdToProjectDirName(pane.cwd));
  const session = await mostRecentSessionCached(projectDir);
  const transcriptMtime = session?.mtimeMs ?? null;

  // 1. Hook event for this pane, when the transcript has not moved on since.
  // "Moved on" needs the grace window: a transcript write AFTER the event
  // normally means the agent kept going, so the event is spent — but Claude
  // Code flushes its own turn's last entries immediately after firing Stop,
  // measured at 79ms later on 2026-09-11, which made every "done" event
  // look spent the instant it arrived and left the pane reading as working
  // off step 3's transcript recency. Anything inside the window is that same
  // flush; anything outside it is the agent genuinely working again (and a
  // new turn sends its own event anyway, which overwrites this one).
  //
  // A pane with no transcript at all (any agent that is not Claude Code) has
  // nothing to be stale against, so its event always stands — which is the
  // whole reason this became a pane-keyed lookup.
  const hook = hookEvents.get(pane.paneId);
  if (hook && (transcriptMtime === null || hook.at + HOOK_TRANSCRIPT_GRACE_MS >= transcriptMtime)) {
    if (hook.state === "permission") {
      return { state: "waiting", stateDetail: "permission", lastActivityAt: hook.at };
    }
    if (hook.state === "working") {
      return { state: "working", lastActivityAt: hook.at };
    }
    return { state: "done", lastActivityAt: hook.at };
  }

  // 2. Pane-title spinner rule — a quarter-circle is the one glyph that
  // actually reports a state. Everything else (Claude's own "✳" mark
  // included) contributes the task label and nothing more.
  const parsed = parseAgentTitle(pane.title);
  const taskLabel = parsed && (WORKING_GLYPHS.has(parsed.glyph) || parsed.glyph === CLAUDE_GLYPH)
    ? parsed.label
    : undefined;
  if (parsed && WORKING_GLYPHS.has(parsed.glyph)) {
    return { state: "working", taskLabel, lastActivityAt: transcriptMtime };
  }

  // 3. Transcript-mtime fallback — the signal that survives, since Claude
  // Code writes its transcript continuously while it works.
  if (transcriptMtime === null) {
    return { state: "waiting", taskLabel, lastActivityAt: null };
  }
  const working = Date.now() - transcriptMtime < waitingThresholdMs;
  return { state: working ? "working" : "waiting", taskLabel, lastActivityAt: transcriptMtime };
}

// Shorter than the client's own poll beat, so two panes resolving in the
// same tick share one filesystem read without a later tick reusing it.
const CLASSIFY_CACHE_TTL_MS = 2_000;
const classifyCache = new Map(); // cwd -> { at, value }

async function classifyPaneCached(pane, waitingThresholdMs) {
  const cached = classifyCache.get(pane.cwd);
  if (cached && Date.now() - cached.at < CLASSIFY_CACHE_TTL_MS) return cached.value;
  const value = await classifyPane(pane, waitingThresholdMs);
  classifyCache.set(pane.cwd, { at: Date.now(), value });
  return value;
}

// What this extension defaulted to before core had a registry, and the floor
// it falls back to on a core that does not have one yet — see the two
// optional-call guards below.
const PRE_REGISTRY_PROGRAMS = ["claude"];

// Which panes count as agents: core's registry (Settings → Agents), with
// this extension's own deprecated setting still winning while it is set, so
// upgrading cannot silently reset a list somebody customized. The old key's
// description points at Settings → Agents and it goes away next version.
async function resolveAgentPrograms(settings, host) {
  const legacy = settings["agentMonitor.programs"];
  if (typeof legacy === "string" && legacy.trim()) {
    return legacy
      .split(",")
      .map((program) => program.trim())
      .filter(Boolean);
  }
  // host.agents arrived with the registry. This extension is installed from
  // a registry repo, so it can land on ANY core version and there is no
  // manifest field to declare a minimum one — on an older core it degrades
  // to what it used to detect rather than throwing and showing no dots at
  // all.
  let agents = null;
  try {
    agents = (await host.agents?.list()) ?? null;
  } catch (err) {
    console.warn("agent-monitor: could not read the agent registry:", err.message);
  }
  if (!agents) return PRE_REGISTRY_PROGRAMS;
  // An entry with no foreground command is a launch preset only and can
  // never match a pane.
  return agents.map((agent) => agent.program).filter(Boolean);
}

export function activate({ router, getSettings, host }) {
  // Core installs the hooks (Settings → Agents), receives every event at one
  // endpoint and normalizes it; all this extension does is remember the last
  // state per pane. The subscription is dropped for us when this server hook
  // unmounts, so there is nothing to tear down here.
  //
  // Optional-called for the same reason as host.agents above: on a core
  // without the pipeline this has to be a no-op, not a throw. An exception
  // here would abort activate() and leave the extension with no routes at
  // all, which would cost the title and transcript signals too — the ones
  // that never needed hooks.
  host.agentHooks?.subscribe({
    events: ["permission", "stop", "prompt-submit", "tool-start"],
    onEvent(event) {
      const state = HOOK_STATES[event.event];
      if (state) recordHookEvent(event.paneId, state);
    },
  });

  router.get("/agents", async (_req, res) => {
    try {
      const settings = await getSettings();
      const programs = await resolveAgentPrograms(settings, host);
      const thresholdSeconds = Number(settings["agentMonitor.waitingThresholdSeconds"]);
      const waitingThresholdMs = (Number.isFinite(thresholdSeconds) && thresholdSeconds > 0 ? thresholdSeconds : 45) * 1000;

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
}
