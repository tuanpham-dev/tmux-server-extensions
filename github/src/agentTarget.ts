// Finds agent-running tmux windows under a repo path, and sends text into
// one — the shared "hand this to the project's agent pane" primitive behind
// the worktrees agent launcher, git-scm's diff comments, and live-preview's
// element picker. Structural copies of the TmuxSession/TmuxWindow shape the
// host already fetches via /api/sessions — see extensions/_shared's module
// comment on why this is a copy, not a shared runtime import. The github
// extension (in the separate tmux-server-extensions registry repo) vendors
// its own copy of this file for the same reason.

export interface AgentTmuxWindow {
  index: number;
  name: string;
  command: string;
}

export interface AgentTmuxSession {
  name: string;
  path: string;
  windows: AgentTmuxWindow[];
}

export interface AgentWindow {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  command: string;
}

const WINDOW_TAB_PREFIX = "tmuxserver-view-";

function matchesProgram(command: string, programsCsv: string): boolean {
  const programs = programsCsv
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return programs.includes(command);
}

// repoPath and session.path are both `~`-shortened server display paths (the
// same convention core hands the client) — string comparison is enough since
// both sides come from the same source, never mixed with a raw absolute path.
function isUnderRepo(sessionPath: string, repoPath: string): boolean {
  if (!sessionPath || !repoPath) return false;
  if (sessionPath === repoPath) return true;
  const prefix = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
  return sessionPath.startsWith(prefix);
}

// Every window, across every session rooted at or under repoPath, whose
// foreground command matches one of the comma-separated agentPrograms —
// synthetic tmuxserver-view-* sessions are skipped since they mirror a real
// session's windows and would otherwise double-list every match. Callers
// fetch /api/sessions themselves (providers must be sync-from-cache; this
// stays a plain function over whatever list they already have).
export function agentWindows(
  sessions: AgentTmuxSession[],
  repoPath: string,
  agentProgramsCsv: string,
): AgentWindow[] {
  const out: AgentWindow[] = [];
  for (const session of sessions) {
    if (session.name.startsWith(WINDOW_TAB_PREFIX)) continue;
    if (!isUnderRepo(session.path, repoPath)) continue;
    for (const window of session.windows) {
      if (matchesProgram(window.command, agentProgramsCsv)) {
        out.push({
          sessionName: session.name,
          windowIndex: window.index,
          windowName: window.name,
          command: window.command,
        });
      }
    }
  }
  return out;
}

// Fetches the live session list from core's public /api/sessions route (a
// plain same-origin fetch — no server hook of this extension's own is
// involved, per docs/EXTENSION_API.md's ctx.serverFetch section).
export function fetchSessions(): Promise<AgentTmuxSession[]> {
  return fetch("/api/sessions").then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  });
}

export interface SendToAgentOptions {
  // Retries a 404 (session not created yet) at a fixed interval — the
  // agent-launcher's race with a freshly created session. Not applied to any
  // other error status.
  retries?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POSTs to the core send-text route (docs/EXTENSION_API.md: a public core
// route, fine to hit with a plain fetch). Throws with the server's error
// message on failure. windowIndex targets a specific window within the
// session — omitting it targets tmux's own "current" (last-focused) window
// for that session, not necessarily the one the caller resolved via
// agentWindows() (a repo session can have several windows, only one of
// them running the agent). Every AgentWindow agentWindows() returns already
// carries its own windowIndex; pass it through rather than dropping it.
export async function sendToAgent(
  sessionName: string,
  text: string,
  submit: boolean,
  opts?: SendToAgentOptions & { windowIndex?: number },
): Promise<void> {
  const retries = opts?.retries ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? 0;
  let attempt = 0;
  for (;;) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, submit, windowIndex: opts?.windowIndex }),
    });
    if (res.ok) return;
    if (res.status === 404 && attempt < retries) {
      attempt++;
      await sleep(retryDelayMs);
      continue;
    }
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
}
