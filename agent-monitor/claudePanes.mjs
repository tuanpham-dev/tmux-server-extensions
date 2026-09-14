// Which Claude Code session is running in which tmux pane. Claude Code
// writes one ~/.claude/sessions/<pid>.json per running CLI, carrying its
// current sessionId, its real cwd and a `tmux` field of
// "<session>:@<window>.%<pane>" (verified against 2.1.270). Resolving a
// window through its pane is what keeps two Claude windows open in the same
// directory apart: the older rule, "the most recently written transcript in
// that cwd's project dir", handed both windows whichever session had written
// last.
//
// Files are left behind by CLIs that exited (hundreds accumulate), so a file
// only counts while its pid is alive; the pid is the filename, so dead ones
// are skipped without being read. Vendored from tmux-server core's
// extensions/subagent-viewer/claudePanes.mjs, since extensions can't import
// each other - keep the two copies in step.
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const CLAUDE_SESSIONS_DIR = path.join(homedir(), ".claude", "sessions");

// "tmuxserver-view-beb4b335:@0.%0" -> "%0". Null for a CLI started outside
// tmux (no field) or any shape this doesn't recognize.
export function paneIdFromTmuxField(value) {
  if (typeof value !== "string") return null;
  const m = /\.(%\d+)$/.exec(value);
  return m ? m[1] : null;
}

// Pure core of the lookup: parsed session records in, paneId -> session out.
// When a pane somehow has more than one live record, the most recently
// updated one wins.
export function sessionsByPane(records, isAlive) {
  const byPane = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const paneId = paneIdFromTmuxField(record.tmux);
    if (!paneId || typeof record.sessionId !== "string" || !record.sessionId) continue;
    if (typeof record.pid !== "number" || !isAlive(record.pid)) continue;
    const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
    const existing = byPane.get(paneId);
    if (existing && existing.updatedAt >= updatedAt) continue;
    byPane.set(paneId, {
      sessionId: record.sessionId,
      cwd: typeof record.cwd === "string" ? record.cwd : null,
      updatedAt,
    });
  }
  return byPane;
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it just isn't ours to signal.
    return err?.code === "EPERM";
  }
}

const CACHE_TTL_MS = 2_000;
let cache = null; // { at, value: Promise<Map> }

async function readSessionsByPane(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return new Map();
  }
  const records = await Promise.all(
    names.map(async (name) => {
      const m = /^(\d+)\.json$/.exec(name);
      if (!m || !isPidAlive(Number(m[1]))) return null;
      try {
        return JSON.parse(await readFile(path.join(dir, name), "utf8"));
      } catch {
        return null; // Mid-write or malformed: skip this poll.
      }
    }),
  );
  return sessionsByPane(records, isPidAlive);
}

// paneId -> { sessionId, cwd, updatedAt } for every live Claude CLI in tmux.
// Cached briefly so one poll resolving many windows reads the directory once.
export function claudeSessionsByPane(dir = CLAUDE_SESSIONS_DIR) {
  const now = Date.now();
  if (!cache || now - cache.at >= CACHE_TTL_MS) {
    cache = { at: now, value: readSessionsByPane(dir) };
  }
  return cache.value;
}
