// claude-auto-retry server hook: polls tmux panes running Claude Code for the
// "limit reached" banner and, per the claudeAutoRetry.mode setting, either
// auto-sends a continue message after the limit resets (plus an offset) or
// waits for the user to confirm via the client's toast. State lives entirely
// in memory (see plans/claude-auto-retry-auto-continue.md for the full design).
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseUsageLines, blocksFor } from "./usageModel.mjs";

const TMUX_TIMEOUT = 5000;
const POLL_INTERVAL_MS = 10_000;
const CAPTURE_LINES = 50;
const SEND_MESSAGE_DELAY_MS = 150;
const SENT_REARM_MS = 5 * 60_000; // banner still present this long after sending -> re-arm as awaiting
const PRUNE_AFTER_MS = 10 * 60_000; // terminal events kept this long for toast display
const RATE_LIMIT_STATE_PATH = path.join(homedir(), ".claude", "rate-limit-state.json");
const FIVE_HOUR_HORIZON_MS = 5 * 60 * 60_000;
const SEVEN_DAY_HORIZON_MS = 7 * 24 * 60 * 60_000;
const CLAUDE_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");
const USAGE_LOOKBACK_MS = 24 * 60 * 60_000;
const USAGE_CACHE_TTL_MS = 30_000;

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8", timeout: TMUX_TIMEOUT }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

// ---- Detection ----

// Type keywords the CLI actually renders (verified against the installed
// claude bundle: "5-hour session limit", "weekly limit", "Opus limit",
// "Sonnet limit", "Fable 5 limit") plus the older generic "usage limit"
// phrasing, mapped to a coarse kind for reset-time lookup purposes.
const KIND_BY_KEYWORD = {
  "5-hour": "5h",
  session: "5h",
  weekly: "weekly",
  "7-day": "weekly",
  opus: "weekly",
  sonnet: "weekly",
  fable: "weekly",
  usage: "unknown",
};

const KEYWORD_ALTERNATION = Object.keys(KIND_BY_KEYWORD).join("|");
// One line: a whitelisted keyword, then "limit reached", then a
// reset/resets clause capturing the trailing time text. Deliberately does
// NOT match the CLI's other "limit reached" strings (Context, Budget,
// Concurrent subagent, spend, Fast) - none of those mean "session stopped,
// resume after reset".
const BANNER_RE = new RegExp(
  `(?:${KEYWORD_ALTERNATION})[^\\n]*?limit reached[^\\n]*?resets?(?:\\s+(?:at|in))?\\s+([^\\n]+)`,
  "i",
);

function classifyKind(line) {
  const lower = line.toLowerCase();
  for (const [keyword, kind] of Object.entries(KIND_BY_KEYWORD)) {
    if (lower.includes(keyword)) return kind;
  }
  return "unknown";
}

// Returns { bannerLine, timeText, kind } for the last matching line in the
// captured tail, or null. "Approaching ..." lines are the still-working
// warning, not a stop, and are skipped.
function findBanner(tail) {
  const lines = tail.split("\n");
  let found = null;
  for (const line of lines) {
    if (/approaching/i.test(line)) continue;
    const m = BANNER_RE.exec(line);
    if (m) found = { bannerLine: line.trim(), timeText: m[1].trim(), kind: classifyKind(line) };
  }
  return found;
}

// ---- Reset-time resolution ----

// Primary source: ~/.claude/rate-limit-state.json, written by the user's own
// statusline.sh hook (not Claude Code itself) - see plan Approach. Used only
// when the relevant epoch is in the future and within the window's own
// horizon; a stale updated_at does NOT disqualify it since the statusline
// stops refreshing exactly while the session is blocked.
async function readRateLimitState(kind) {
  let raw;
  try {
    raw = await readFile(RATE_LIMIT_STATE_PATH, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const now = Date.now();
  if (kind === "5h") {
    const resetsAt = parsed.resets_at;
    if (typeof resetsAt !== "number") return null;
    const epochMs = resetsAt * 1000;
    if (epochMs > now && epochMs - now <= FIVE_HOUR_HORIZON_MS) return epochMs;
    return null;
  }
  if (kind === "weekly") {
    const resetsAt = parsed.seven_day_resets_at;
    if (typeof resetsAt !== "number") return null;
    const epochMs = resetsAt * 1000;
    if (epochMs > now && epochMs - now <= SEVEN_DAY_HORIZON_MS) return epochMs;
    return null;
  }
  return null;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Resolves the offset (in minutes) of an IANA zone at a given instant, via
// Intl - used to convert a banner's local wall-clock time (in that zone)
// back to a UTC epoch. Returns null for an unrecognized zone.
function tzOffsetMinutes(zone, atMs) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = Object.fromEntries(dtf.formatToParts(atMs).map((p) => [p.type, p.value]));
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) === 24 ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    return (asUTC - atMs) / 60_000;
  } catch {
    return null;
  }
}

// Converts a wall-clock date (in the named zone, or local if zone is
// null/unrecognized) to an epoch ms. Two-pass: resolve the offset near a
// first guess, then re-resolve at the corrected instant to settle DST edges.
function zonedTimeToEpoch(y, mo, d, h, mi, zone) {
  const guessUTC = Date.UTC(y, mo, d, h, mi);
  if (!zone) return new Date(y, mo, d, h, mi).getTime();
  const offset1 = tzOffsetMinutes(zone, guessUTC);
  if (offset1 === null) return new Date(y, mo, d, h, mi).getTime();
  const pass1 = guessUTC - offset1 * 60_000;
  const offset2 = tzOffsetMinutes(zone, pass1);
  const offset = offset2 === null ? offset1 : offset2;
  return guessUTC - offset * 60_000;
}

// Strips a trailing "(Zone/Name)" parenthetical, returning the zone (if it
// looks like an IANA identifier) and the remaining text.
function stripZone(text) {
  const m = /^(.*?)\s*\(([A-Za-z_]+\/[A-Za-z_]+)\)\s*$/.exec(text.trim());
  if (!m) return { text: text.trim(), zone: null };
  return { text: m[1].trim(), zone: m[2] };
}

// Parses the banner's captured time text into an epoch ms, given "now".
// Handles: "in <duration>" (relative), "<time>" / "<time> (Zone)" (today or
// tomorrow), "<Month> <day>" / "<Month> <day>, <time>" (this year or next).
// Returns null when unparsable.
function parseResetTime(text, now) {
  const trimmed = text.trim();

  const relMatch = /^in\s+(.+)$/i.exec(trimmed);
  if (relMatch) {
    const durMs = parseDuration(relMatch[1]);
    return durMs === null ? null : now + durMs;
  }

  const { text: stripped, zone } = stripZone(trimmed);

  const timeRe = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;
  const dateTimeRe = /^([A-Za-z]{3,})\s+(\d{1,2})(?:,\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i;

  const timeOnly = timeRe.exec(stripped);
  if (timeOnly) {
    const { hour, minute } = to24Hour(timeOnly[1], timeOnly[2], timeOnly[3]);
    const nowDate = new Date(now);
    let epoch = zonedTimeToEpoch(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), hour, minute, zone);
    if (epoch <= now) {
      const tomorrow = new Date(now + 24 * 60 * 60_000);
      epoch = zonedTimeToEpoch(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), hour, minute, zone);
    }
    return epoch;
  }

  const dateMatch = dateTimeRe.exec(stripped);
  if (dateMatch) {
    const monthKey = dateMatch[1].slice(0, 3).toLowerCase();
    const month = MONTHS[monthKey];
    if (month === undefined) return null;
    const day = Number(dateMatch[2]);
    let hour = 0;
    let minute = 0;
    if (dateMatch[3]) {
      ({ hour, minute } = to24Hour(dateMatch[3], dateMatch[4], dateMatch[5]));
    }
    const nowDate = new Date(now);
    let year = nowDate.getFullYear();
    let epoch = zonedTimeToEpoch(year, month, day, hour, minute, zone);
    if (epoch <= now - 24 * 60 * 60_000) {
      epoch = zonedTimeToEpoch(year + 1, month, day, hour, minute, zone);
    }
    return epoch;
  }

  return null;
}

function to24Hour(hourStr, minuteStr, ampm) {
  let hour = Number(hourStr) % 12;
  if (/pm/i.test(ampm)) hour += 12;
  const minute = minuteStr ? Number(minuteStr) : 0;
  return { hour, minute };
}

// "2h 30m", "45m", "1d 3h" -> ms.
function parseDuration(text) {
  const re = /(\d+)\s*(d|h|m)/gi;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === "d") total += n * 24 * 60 * 60_000;
    else if (unit === "h") total += n * 60 * 60_000;
    else total += n * 60_000;
  }
  return matched ? total : null;
}

// ---- Pane listing ----

// list-panes -a returns the same real pane once per grouped
// tmuxserver-view-* session it also belongs to (observed live) - dedup by
// pane id, preferring the non-tmuxserver-view- session name for display.
async function listClaudePanes() {
  let raw;
  try {
    raw = await tmux([
      "list-panes", "-a", "-F",
      "#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_current_command}",
    ]);
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [paneId, sessionName, windowIndexStr, cmd] = line.split("\t");
    if (cmd !== "claude") continue;
    const windowIndex = Number(windowIndexStr);
    const existing = byId.get(paneId);
    const isGroupedView = sessionName.startsWith("tmuxserver-view-");
    if (!existing || (existing.isGroupedView && !isGroupedView)) {
      byId.set(paneId, { paneId, sessionName, windowIndex, isGroupedView });
    }
  }
  return [...byId.values()].map(({ paneId, sessionName, windowIndex }) => ({ paneId, sessionName, windowIndex }));
}

async function captureTail(paneId) {
  try {
    return await tmux(["capture-pane", "-p", "-t", paneId, "-S", `-${CAPTURE_LINES}`]);
  } catch {
    return "";
  }
}

// ---- Event store ----

let events = new Map(); // id -> event
let nextId = 1;
let suppressedPanes = new Map(); // paneId -> { until: epochMs, bannerLine }
let pollTimer = null;

function pruneEvents() {
  const now = Date.now();
  for (const [id, ev] of events) {
    const terminal = ev.status === "sent" || ev.status === "aborted" || ev.status === "skipped";
    if (terminal && now - (ev.sentAt ?? ev.detectedAt) > PRUNE_AFTER_MS) events.delete(id);
  }
}

function activeEventForPane(paneId) {
  for (const ev of events.values()) {
    if (ev.paneId === paneId && (ev.status === "awaiting" || ev.status === "scheduled")) return ev;
  }
  return null;
}

async function sendContinueMessage(paneId, message) {
  await tmux(["send-keys", "-t", paneId, "-l", "--", message]);
  await new Promise((resolve) => setTimeout(resolve, SEND_MESSAGE_DELAY_MS));
  await tmux(["send-keys", "-t", paneId, "Enter"]);
}

async function detectTick(settings) {
  const panes = await listClaudePanes();
  const now = Date.now();
  for (const pane of panes) {
    if (activeEventForPane(pane.paneId)) continue;

    const suppression = suppressedPanes.get(pane.paneId);
    const tail = await captureTail(pane.paneId);
    const banner = findBanner(tail);
    if (!banner) {
      suppressedPanes.delete(pane.paneId);
      continue;
    }
    if (suppression) {
      if (now < suppression.until && suppression.bannerLine === banner.bannerLine) continue;
      suppressedPanes.delete(pane.paneId);
    }

    const stateResetAt = await readRateLimitState(banner.kind);
    const resetAt = stateResetAt ?? parseResetTime(banner.timeText, now);

    const id = String(nextId++);
    const base = {
      id,
      paneId: pane.paneId,
      sessionName: pane.sessionName,
      windowIndex: pane.windowIndex,
      kind: banner.kind,
      bannerLine: banner.bannerLine,
      resetAt,
      dismissed: false,
      detectedAt: now,
    };

    if (resetAt === null) {
      events.set(id, { ...base, sendAt: null, status: "awaiting" });
    } else if (settings.mode === "auto") {
      const offsetMs = clampOffsetMinutes(settings.offsetMinutes) * 60_000;
      events.set(id, { ...base, sendAt: resetAt + offsetMs, status: "scheduled" });
    } else {
      events.set(id, { ...base, sendAt: null, status: "awaiting" });
    }
  }
}

function clampOffsetMinutes(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(120, Math.max(0, n));
}

async function schedulerTick(settings) {
  const now = Date.now();
  for (const ev of events.values()) {
    if (ev.status !== "scheduled" || ev.sendAt === null || ev.sendAt > now) continue;

    // Re-check the pane immediately before sending: if the banner is gone,
    // the session already resumed (e.g. the rate-limit-guard cron beat us
    // to it) - skip rather than sending a redundant continue.
    const tail = await captureTail(ev.paneId);
    const stillPresent = tail.split("\n").some((l) => l.trim() === ev.bannerLine);
    if (!stillPresent) {
      ev.status = "skipped";
      ev.sentAt = now;
      continue;
    }

    try {
      await sendContinueMessage(ev.paneId, settings.message);
      ev.status = "sent";
      ev.sentAt = Date.now();
      suppressedPanes.set(ev.paneId, { until: ev.sentAt + SENT_REARM_MS, bannerLine: ev.bannerLine });
    } catch {
      // Leave it scheduled; the next tick retries the send.
    }
  }
}

async function poll(getSettings) {
  pruneEvents();
  const raw = await getSettings();
  const settings = {
    mode: raw["claudeAutoRetry.mode"] === "manual" || raw["claudeAutoRetry.mode"] === "off" ? raw["claudeAutoRetry.mode"] : "auto",
    offsetMinutes: raw["claudeAutoRetry.offsetMinutes"],
    message: typeof raw["claudeAutoRetry.message"] === "string" && raw["claudeAutoRetry.message"] ? raw["claudeAutoRetry.message"] : "continue",
  };
  if (settings.mode === "off") return;
  await detectTick(settings);
  await schedulerTick(settings);
}

function eventToJSON(ev) {
  return {
    id: ev.id,
    sessionName: ev.sessionName,
    windowIndex: ev.windowIndex,
    kind: ev.kind,
    resetAt: ev.resetAt,
    sendAt: ev.sendAt,
    status: ev.status,
    dismissed: ev.dismissed,
    detectedAt: ev.detectedAt,
    sentAt: ev.sentAt ?? null,
  };
}

// ---- Usage aggregation (T16/T17) ----

// Reads one transcript file's usage entries — best-effort: a vanished/
// unreadable file just contributes nothing. Skipped entirely if its mtime
// is older than USAGE_LOOKBACK_MS, since a file untouched in the last 24h
// can't have any entries inside the current or immediately-previous 5-hour
// block anyway.
async function collectFileEntries(filePath, now, out) {
  try {
    const s = await stat(filePath);
    if (now - s.mtimeMs > USAGE_LOOKBACK_MS) return;
    out.push(...parseUsageLines(await readFile(filePath, "utf8")));
  } catch {
    // Vanished mid-scan, or unreadable — contributes nothing.
  }
}

// Every project's own session transcripts, plus every session's subagent
// sidecars — verified live (2026-08-18) against a real transcript with a
// known subagent run: the subagent's own token usage appears nowhere in the
// parent's entries, so skipping subagents/ would under-count actual usage,
// not double-count it (see plans/orca-features-implementation.md's Open
// Questions for the check). Layout: ~/.claude/projects/<project>/
// <sessionId>.jsonl (parent) and ~/.claude/projects/<project>/<sessionId>/
// subagents/agent-*.jsonl (sidecars) — the same layout subagent-viewer's
// server hook (in the main tmux-server repo) already reads.
async function collectUsageEntries() {
  let projectDirs;
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const entries = [];
  for (const projEnt of projectDirs) {
    if (!projEnt.isDirectory()) continue;
    const projDir = path.join(CLAUDE_PROJECTS_DIR, projEnt.name);
    let children;
    try {
      children = await readdir(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(".jsonl")) {
        await collectFileEntries(path.join(projDir, child.name), now, entries);
      } else if (child.isDirectory()) {
        const subagentsDir = path.join(projDir, child.name, "subagents");
        let subFiles;
        try {
          subFiles = await readdir(subagentsDir);
        } catch {
          continue;
        }
        for (const name of subFiles) {
          if (name.endsWith(".jsonl")) await collectFileEntries(path.join(subagentsDir, name), now, entries);
        }
      }
    }
  }
  return entries;
}

let usageCache = null; // { at, entries }

async function getUsageEntriesCached() {
  const now = Date.now();
  if (usageCache && now - usageCache.at < USAGE_CACHE_TTL_MS) return usageCache.entries;
  const entries = await collectUsageEntries();
  usageCache = { at: now, entries };
  return entries;
}

// ---- Server activation ----

// activate() re-runs on a disable->enable cycle within the same server
// process (the module stays resident) - guard the poll-loop singleton so a
// second activation doesn't double the interval.
let activated = false;

export function activate({ router, getSettings, log }) {
  if (!activated) {
    activated = true;
    pollTimer = setInterval(() => {
      poll(getSettings).catch((err) => log("poll error:", err.message));
    }, POLL_INTERVAL_MS);
    poll(getSettings).catch((err) => log("poll error:", err.message));
  }

  router.get("/events", (req, res) => {
    const list = [...events.values()]
      .filter((ev) => !ev.dismissed)
      .sort((a, b) => b.detectedAt - a.detectedAt)
      .map(eventToJSON);
    res.json({ events: list });
  });

  // Current block + up to 5 previous, most-recent-first. When
  // ~/.claude/rate-limit-state.json has a plausible future reset epoch (the
  // same file this extension's own detection already reads), the current
  // block's displayed end is overridden to it — real reset data beats the
  // floating-window heuristic whenever it's available.
  router.get("/usage", async (req, res) => {
    try {
      const entries = await getUsageEntriesCached();
      const now = Date.now();
      const blocks = blocksFor(entries, now)
        .sort((a, b) => b.start - a.start)
        .slice(0, 6);
      const resetsAt5h = await readRateLimitState("5h");
      const resetsAtWeekly = await readRateLimitState("weekly");
      const current = blocks.find((b) => b.isCurrent);
      if (current && typeof resetsAt5h === "number" && resetsAt5h > now) current.end = resetsAt5h;
      res.json({ blocks, resetsAt5h, resetsAtWeekly });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/confirm", (req, res) => {
    const { id } = req.body ?? {};
    const ev = typeof id === "string" ? events.get(id) : null;
    if (!ev || ev.status !== "awaiting") {
      res.status(404).json({ error: "event not found or not awaiting confirmation" });
      return;
    }
    getSettings().then((raw) => {
      const offsetMs = clampOffsetMinutes(raw["claudeAutoRetry.offsetMinutes"]) * 60_000;
      const now = Date.now();
      ev.sendAt = Math.max(now, (ev.resetAt ?? now) + offsetMs);
      ev.status = "scheduled";
      res.status(204).end();
    });
  });

  router.post("/abort", (req, res) => {
    const { id } = req.body ?? {};
    const ev = typeof id === "string" ? events.get(id) : null;
    if (!ev || (ev.status !== "awaiting" && ev.status !== "scheduled")) {
      res.status(404).json({ error: "event not found or not abortable" });
      return;
    }
    ev.status = "aborted";
    ev.sentAt = Date.now();
    // Without this, a persistent banner (one that never scrolls out of the
    // captured tail) gets re-detected on the very next poll tick and
    // silently re-schedules - the same re-arm window a successful send gets.
    suppressedPanes.set(ev.paneId, { until: ev.sentAt + SENT_REARM_MS, bannerLine: ev.bannerLine });
    res.status(204).end();
  });

  router.post("/dismiss", (req, res) => {
    const { id } = req.body ?? {};
    const ev = typeof id === "string" ? events.get(id) : null;
    if (!ev) {
      res.status(404).json({ error: "event not found" });
      return;
    }
    ev.dismissed = true;
    res.status(204).end();
  });
}

export const __test = { parseResetTime, findBanner, classifyKind };
