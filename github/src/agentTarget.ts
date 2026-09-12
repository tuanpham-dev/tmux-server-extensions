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

// Anything carrying the foreground command tmux reports for an agent —
// satisfied structurally by a core registry entry (GET /api/agents) and by
// the deprecated per-extension CSV, so agentWindows never has to know which
// it was handed. An entry with an empty program is launch-preset only and
// matches nothing, which is why the filter below drops it rather than
// matching every window whose command happens to be "".
export interface AgentTargetProgram {
  program: string;
}

// A core registry entry as GET /api/agents returns it. `program` is the
// foreground command tmux reports (detection), `command` the full launch
// line (presets) — see server/src/agents.ts.
export interface AgentRegistryEntry extends AgentTargetProgram {
  id: string;
  label: string;
  command: string;
  // Appended to `command` for this agent's no-prompts mode. Empty means it
  // has none, so a caller offering the choice hides it rather than showing a
  // checkbox that would do nothing.
  skipPermissionsArgs: string;
}

function matchesProgram(command: string, agents: readonly AgentTargetProgram[]): boolean {
  return agents.some((agent) => agent.program !== "" && agent.program === command);
}

// The core agent registry: the one list of "what is an AI agent", edited in
// Settings → Agents and shared by every extension that needs to find an
// agent pane (plans/agent-platform-core.md). A plain same-origin fetch of a
// public core route, like fetchSessions below.
export function fetchAgents(): Promise<AgentRegistryEntry[]> {
  return fetch("/api/agents").then((res) => {
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json().then((body: { agents?: AgentRegistryEntry[] }) => body.agents ?? []);
  });
}

// What every one of these extensions used to default to before core had a
// registry. Also the floor they fall back to when it cannot be read - see
// PRE_REGISTRY_* below.
const PRE_REGISTRY_PROGRAMS: readonly string[] = ["claude"];

// A registry-shaped fetch that never rejects. An extension from the registry
// repo can be installed on ANY core version, including one that predates
// /api/agents (it 404s there, and there is no manifest field to declare a
// minimum core version). Rejecting would take the feature out entirely -
// "Send to Agent" erroring, an empty preset menu - so a failure degrades to
// what this extension shipped with before the registry existed instead. The
// warning is there because the other cause is a core that HAS the route and
// is failing, which is worth seeing in a console.
async function fetchAgentsOrNull(): Promise<AgentRegistryEntry[] | null> {
  try {
    return await fetchAgents();
  } catch (err) {
    console.warn(
      "tmux-server: could not read the agent registry (/api/agents); falling back to the pre-registry defaults.",
      err,
    );
    return null;
  }
}

// What to match panes against: the extension's own deprecated
// agentPrograms setting when the user actually set one, else the core
// registry. Kept for one version so upgrading cannot silently reset a list
// somebody customized - every migrating extension routes through here, so
// the deprecation lives in one place rather than three.
export async function resolveAgentTargets(legacyProgramsCsv: unknown): Promise<AgentTargetProgram[]> {
  if (typeof legacyProgramsCsv === "string" && legacyProgramsCsv.trim()) {
    return legacyProgramsCsv
      .split(",")
      .map((program) => program.trim())
      .filter(Boolean)
      .map((program) => ({ program }));
  }
  const agents = await fetchAgentsOrNull();
  return agents ?? PRE_REGISTRY_PROGRAMS.map((program) => ({ program }));
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

// One agent as a LAUNCH preset: what to call it in a picker, and the command
// line that starts it. The other half of a registry entry from the detection
// half above, and the shape the "Start work" flows want.
export interface AgentLaunchPreset {
  name: string;
  command: string;
  // See AgentRegistryEntry. Carried through so a caller can offer "start it
  // without permission prompts" as a checkbox beside the preset rather than
  // as a second preset - which is what this used to be.
  skipPermissionsArgs: string;
}

// The line to type into the new session: the preset's command, plus its
// skip-permissions argument(s) when the caller asked for that and the agent
// actually has some.
export function launchCommand(preset: AgentLaunchPreset, skipPermissions: boolean): string {
  if (!skipPermissions || !preset.skipPermissionsArgs) return preset.command;
  return `${preset.command} ${preset.skipPermissionsArgs}`;
}

// The two presets the "Start work" flows shipped with before core had a
// registry, and the floor they fall back to when it cannot be read.
const PRE_REGISTRY_PRESETS: readonly AgentLaunchPreset[] = [
  { name: "Claude Code", command: "claude", skipPermissionsArgs: "--dangerously-skip-permissions" },
];

// The presets to offer: the caller's own deprecated JSON setting when it is
// set and parseable, else the core registry's enabled entries that have a
// command. Same one-version deprecation as resolveAgentTargets, for the
// other of the two shapes "what is an agent" used to be stored in.
export async function resolveAgentPresets(legacyJson: unknown): Promise<AgentLaunchPreset[]> {
  if (typeof legacyJson === "string" && legacyJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(legacyJson);
      const presets = Array.isArray(parsed)
        ? parsed
            .filter(
              (p): p is { name: string; command: string } =>
                typeof p === "object" &&
                p !== null &&
                typeof (p as AgentLaunchPreset).name === "string" &&
                typeof (p as AgentLaunchPreset).command === "string",
            )
            // The old JSON shape had no skip-permissions field - a user who
            // wanted that wrote a second entry with the flag in its command,
            // which still works exactly as they wrote it.
            .map((p) => ({ name: p.name, command: p.command, skipPermissionsArgs: "" }))
        : [];
      // A stored "[]" means "offer nothing", which is a real choice and has
      // to win over the registry as much as a populated list does.
      if (Array.isArray(parsed)) return presets;
    } catch {
      // Not JSON any more (a hand-edit) - fall through to the registry
      // rather than offering nothing.
    }
  }
  const agents = await fetchAgentsOrNull();
  if (!agents) return PRE_REGISTRY_PRESETS.map((preset) => ({ ...preset }));
  return agents
    .filter((agent) => agent.command !== "")
    .map((agent) => ({
      name: agent.label || agent.command,
      command: agent.command,
      skipPermissionsArgs: agent.skipPermissionsArgs ?? "",
    }));
}

// Every window, across every session rooted at or under repoPath, whose
// foreground command matches one of the agents' `program` —
// synthetic tmuxserver-view-* sessions are skipped since they mirror a real
// session's windows and would otherwise double-list every match. Callers
// fetch /api/sessions and the agent list themselves (providers must be
// sync-from-cache; this stays a plain function over whatever lists they
// already have — see resolveAgentTargets).
export function agentWindows(
  sessions: AgentTmuxSession[],
  repoPath: string,
  agents: readonly AgentTargetProgram[],
): AgentWindow[] {
  const out: AgentWindow[] = [];
  for (const session of sessions) {
    if (session.name.startsWith(WINDOW_TAB_PREFIX)) continue;
    if (!isUnderRepo(session.path, repoPath)) continue;
    for (const window of session.windows) {
      if (matchesProgram(window.command, agents)) {
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
