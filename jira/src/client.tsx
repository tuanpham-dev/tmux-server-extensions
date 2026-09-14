// jira: two JIRA sidebar panes - the issues assigned to you and the active
// repo's project - via the Jira Cloud REST API, with a "Start work" action
// per row that creates a worktree session for it (optionally priming an agent
// and moving the issue to In Progress), and a details popover that shows the
// description and comment thread without leaving the sidebar. Host hooks
// arrive via module-level bridge variables set once in activate() - same
// pattern every bundled-style extension uses.
//
// The two lists are separate registerSidebarPanel panes rather than two
// sections inside one component (git-scm's COMMITS/STASH do the same): the
// host's accordion then owns collapsing, resizing, reordering and moving them
// between tabs, and remembers all of it per user. Because they are separate
// React trees that need the same data, the fetching lives in one module-level
// store below instead of in either component.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import Icon from "./Icon";
import { resolveAgentPresets, sendToAgent, type AgentLaunchPreset } from "./agentTarget";
import SettingsPanel, { onTokenChange, setFetcher } from "./SettingsPanel";

// ---- Module-level host bridge ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
  // Leading check icon. The host has supported this all along (see core's
  // MenuItem in client/src/types.ts); this structural copy just never
  // declared it. Informational only - the app applies the Yolo/Manual choice.
  checked?: boolean;
  // Thin divider row - label/onClick are unused placeholders on one.
  separator?: boolean;
}

// The subset of the host's SidebarPanelHostProps these panes use.
interface SidebarPanelHostProps {
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
let openSessionWindow: ((sessionName: string, opts?: { createCwd?: string }) => void) | null = null;
let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;
let disposeBridge: (() => void)[] = [];

// ---- Types (mirror server.js's responses) ----

interface StatusResponse {
  configured: boolean;
  hasToken: boolean;
  authed: boolean;
  user: { accountId: string | null; displayName: string | null } | null;
  projectKey: string | null;
  projectSource: string | null;
  error: string | null;
}

interface IssueRow {
  key: string;
  summary: string;
  status: string;
  statusCategory: string | null;
  type: string;
  assignee: string | null;
  updated: string | null;
  url: string;
}

interface IssuesResponse {
  issues: IssueRow[];
  projectKey: string | null;
  projectSource: string | null;
}

interface IssueComment {
  author: string;
  created: string | null;
  body: string;
}

interface IssueDetail {
  key: string;
  summary: string;
  description: string;
  status: string;
  type: string;
  priority: string | null;
  labels: string[];
  comments: IssueComment[];
  url: string;
}

interface WorktreeResponse {
  path: string;
  branch: string;
  base: string;
  note: string | null;
}

interface ProgressResponse {
  transitioned: boolean;
  assigned: boolean;
  note: string | null;
}

// ---- Fetch helpers ----

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function apiGet<T>(path: string): Promise<T> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(path).then((res) => readJson<T>(res));
}

function apiPost<T>(path: string, body: unknown): Promise<T> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => readJson<T>(res));
}

// ---- Helpers ----

// Byte-identical to the bundled worktrees extension's own sessionNameFor -
// tmux session names can't contain "." or ":".
function sessionNameFor(branch: string): string {
  return branch.replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

function shortSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "untitled";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.round(days / 365)}y`;
}

// {key}/{slug}/{type} - so both "CAP-123-fix-header" and "feature/CAP-123"
// conventions are reachable from one setting. github hardcodes its equivalent;
// Jira branch conventions vary too much between teams for that.
function buildBranch(template: string, issue: IssueRow): string {
  const type = issue.type.toLowerCase() === "bug" ? "bugfix" : "feature";
  const filled = (template.trim() || "{key}-{slug}")
    .replaceAll("{key}", issue.key)
    .replaceAll("{slug}", shortSlug(issue.summary))
    .replaceAll("{type}", type);
  return filled.replace(/^-+|-+$/g, "") || issue.key;
}

// ---- Agent launch presets ----
// Which agents "Start work" can offer comes from the app's own registry
// (Settings → AI Providers), shared with every other extension that needs to know
// what an agent is. This extension never shipped an agents setting of its
// own, so unlike github and agent-monitor there is no deprecated value to
// prefer and none is read - resolveAgentPresets still falls back to the
// presets it ships with if the registry cannot be read at all (an older
// core).
//
// The registry is a fetch, so unlike the old JSON setting it cannot be
// parsed inline during render. Cached at module level with a short TTL: the
// click path always awaits (so it is never wrong about which presets exist),
// while render reads whatever is cached, which only drives a tooltip.
const PRESETS_TTL_MS = 10_000;
let cachedPresets: AgentLaunchPreset[] = [];
let cachedPresetsAt = 0;
let presetsInFlight: Promise<AgentLaunchPreset[]> | null = null;

// Cached-or-fetched, and never rejects (resolveAgentPresets degrades on its
// own). Concurrent callers share one request.
function agentPresets(): Promise<AgentLaunchPreset[]> {
  if (Date.now() - cachedPresetsAt < PRESETS_TTL_MS) return Promise.resolve(cachedPresets);
  if (presetsInFlight) return presetsInFlight;
  presetsInFlight = resolveAgentPresets()
    .then((presets) => {
      cachedPresets = presets;
      cachedPresetsAt = Date.now();
      return presets;
    })
    .finally(() => {
      presetsInFlight = null;
    });
  return presetsInFlight;
}

// The cached presets for render, kept current by the panel's own re-renders
// rather than read once at mount - so changing Settings → AI Providers shows up
// within the TTL instead of waiting for a remount, which is how the old
// inline parse behaved.
function useAgentPresets(): AgentLaunchPreset[] {
  const [presets, setPresets] = useState(cachedPresets);
  useEffect(() => {
    let alive = true;
    void agentPresets().then((next) => {
      // Same array reference when nothing was re-fetched, so this cannot
      // loop through the effect.
      if (alive) setPresets(next);
    });
    return () => {
      alive = false;
    };
  });
  return presets;
}

// Everything the agent needs to start without going back to Jira itself.
// The description alone was not enough in practice: on a real ticket the
// decisions tend to live in the comment thread, so those go in too (oldest
// first, capped by jira.commentLimit). The URL is included so the agent can
// cite it or ask the user to open it.
function buildAgentBrief(detail: IssueDetail): string {
  const lines: string[] = [`${detail.key}: ${detail.summary}`, ""];

  const facts = [
    detail.type && `Type: ${detail.type}`,
    detail.status && `Status: ${detail.status}`,
    detail.priority && `Priority: ${detail.priority}`,
    detail.labels.length > 0 && `Labels: ${detail.labels.join(", ")}`,
    `Link: ${detail.url}`,
  ].filter((line): line is string => typeof line === "string" && line.length > 0);
  lines.push(...facts, "");

  lines.push("## Description", detail.description || "(none)");

  if (detail.comments.length > 0) {
    lines.push("", `## Comments (${detail.comments.length}, oldest first)`);
    for (const comment of detail.comments) {
      const when = comment.created ? ` on ${comment.created.slice(0, 10)}` : "";
      lines.push("", `### ${comment.author}${when}`, comment.body);
    }
  }

  return lines.join("\n").trimEnd();
}

function readSetting(key: string): string {
  const value = extSettings?.get(key);
  return typeof value === "string" ? value : "";
}

// Core sends text with `tmux send-keys -l`, which puts the newlines on the
// wire raw - and a terminal program reads each one as Enter. So a multi-line
// brief submitted itself line by line (a shell ran every line as its own
// command; an agent TUI sent the first line as a whole message), and the
// trailing Enter that was meant to submit it landed on an empty prompt. That
// is why ticking jira.sendAutoSubmit appeared to do nothing.
//
// Bracketed-paste markers tell the receiving program "everything between
// these is one paste", so the block lands in its composer intact and only the
// explicit Enter submits it. Applied only to multi-line text: a program that
// never enabled bracketed-paste mode would otherwise render the markers as
// literal junk, and single-line sends (the agent's own launch command) never
// needed this.
function asPaste(text: string): string {
  return text.includes("\n") ? `[200~${text}[201~` : text;
}

// Description and comment bodies arrive as flattened text in which links are
// markdown ("[label](url)", from a text node's link mark) or bare URLs (from
// a smart-link card) — see adfToText in server.js. Rendered into real anchors
// here so they can actually be clicked, built as React nodes rather than
// injected HTML: this is other people's comment text, so it must never reach
// dangerouslySetInnerHTML.
const LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'\])]+)/g;

function RichText({ text }: { text: string }) {
  const nodes: (string | JSX.Element)[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  LINK_PATTERN.lastIndex = 0;
  while ((match = LINK_PATTERN.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    // Sentence punctuation that happens to sit after a bare URL isn't part
    // of it; markdown links are already delimited so they keep theirs.
    let href = match[2] ?? match[3] ?? "";
    let label = match[1] ?? href;
    let trailing = "";
    if (!match[2]) {
      const trimmed = href.replace(/[.,;:!?]+$/, "");
      trailing = href.slice(trimmed.length);
      href = trimmed;
      label = trimmed;
    }
    nodes.push(
      <a key={`${match.index}-${href}`} className="jira-link" href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>,
    );
    if (trailing) nodes.push(trailing);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

// ---- Shared store ----
//
// Both panes need the same status and the same in-flight/error state, and the
// two lists come from one /status call plus one /issues call each. Keeping
// that in a module-level store means one fetch feeds both panes, a "Start
// work" error shows wherever you are looking, and only one details popover
// can be open at a time.

type ListId = "mine" | "project";

interface PopoverState {
  key: string;
  // The same issue key can appear in BOTH lists, so the owning list is part
  // of the identity - otherwise opening it in one pane would also render it
  // in the other.
  list: ListId;
  anchor: { top: number; bottom: number; left: number; right: number };
  detail: IssueDetail | null;
  error: string | null;
}

interface JiraState {
  cwd: string | null;
  status: StatusResponse | null;
  mine: IssueRow[];
  project: IssuesResponse | null;
  loading: boolean;
  error: string | null;
  busyKey: string | null;
  startError: string | null;
  note: string | null;
  popover: PopoverState | null;
}

let state: JiraState = {
  cwd: null,
  status: null,
  mine: [],
  project: null,
  loading: false,
  error: null,
  busyKey: null,
  startError: null,
  note: null,
  popover: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<JiraState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function useJira(): JiraState {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

// Guards against an in-flight response from a previous cwd overwriting a
// newer one - the /status call makes a real network round trip to Atlassian
// and can easily outlive a fast tab switch.
let refreshToken = 0;

function refresh(): void {
  const cwd = state.cwd;
  if (!cwd) {
    setState({ status: null, mine: [], project: null, error: null, loading: false });
    return;
  }
  const token = ++refreshToken;
  const q = encodeURIComponent(cwd);
  setState({ loading: true });
  apiGet<StatusResponse>(`/status?cwd=${q}`)
    .then((status) => {
      if (token !== refreshToken) return;
      setState({ status, error: null });
      if (!status.configured || !status.authed) {
        setState({ mine: [], project: null, loading: false });
        return;
      }
      return Promise.all([
        apiGet<IssuesResponse>(`/issues?cwd=${q}&scope=mine`),
        apiGet<IssuesResponse>(`/issues?cwd=${q}&scope=project`),
      ]).then(([mine, project]) => {
        if (token !== refreshToken) return;
        setState({ mine: mine.issues, project, loading: false });
      });
    })
    .catch((err: Error) => {
      if (token !== refreshToken) return;
      setState({ error: err.message, loading: false });
    });
}

// ---- Start work ----

async function startWork(issue: IssueRow, preset: AgentLaunchPreset | null): Promise<void> {
  const cwd = state.cwd;
  if (!cwd) return;
  const branch = buildBranch(readSetting("jira.branchTemplate"), issue);
  setState({ busyKey: issue.key, startError: null, note: null });
  try {
    const result = await apiPost<WorktreeResponse>("/worktree", { cwd, branch });
    const sessionName = sessionNameFor(branch);
    openSessionWindow?.(sessionName, { createCwd: result.path });
    // A fallback base is worth saying out loud - the worktree is real either
    // way, but it didn't start where the user expected.
    if (result.note) setState({ note: result.note });

    if (extSettings?.get("jira.updateIssueOnStartWork") === true) {
      // Never fatal: the worktree already exists, so a Jira-side failure must
      // not read as "Start work failed".
      try {
        const progress = await apiPost<ProgressResponse>("/progress", { key: issue.key });
        if (progress.note) setState({ note: state.note ? `${state.note} ${progress.note}` : progress.note });
      } catch (err) {
        setState({ note: err instanceof Error ? err.message : String(err) });
      }
    }

    if (preset) {
      // Already carries the app's Yolo/Manual choice - see resolveAgentPresets.
      await sendToAgent(sessionName, preset.command, true, { retries: 12, retryDelayMs: 400 });
      const detail = await apiGet<IssueDetail>(`/issue?key=${encodeURIComponent(issue.key)}`);
      await sendToAgent(sessionName, asPaste(buildAgentBrief(detail)), extSettings?.get("jira.sendAutoSubmit") === true, {
        retries: 6,
        retryDelayMs: 400,
      });
    }
  } catch (err) {
    setState({ startError: err instanceof Error ? err.message : String(err) });
  } finally {
    setState({ busyKey: null });
  }
}

// ---- Details popover ----

function openPopover(issue: IssueRow, list: ListId, anchorEl: HTMLElement): void {
  const r = anchorEl.getBoundingClientRect();
  setState({
    popover: {
      key: issue.key,
      list,
      anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      detail: null,
      error: null,
    },
  });
  apiGet<IssueDetail>(`/issue?key=${encodeURIComponent(issue.key)}`)
    .then((detail) => {
      // Ignore a response that lands after the popover was closed or moved on.
      if (state.popover?.key !== issue.key || state.popover.list !== list) return;
      setState({ popover: { ...state.popover, detail } });
    })
    .catch((err: Error) => {
      if (state.popover?.key !== issue.key || state.popover.list !== list) return;
      setState({ popover: { ...state.popover, error: err.message } });
    });
}

function closePopover(): void {
  if (state.popover) setState({ popover: null });
}

function DetailPopover({ popover }: { popover: PopoverState }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Positioned after measuring, so a card taller than the space below the row
  // flips above it instead of running off the bottom of the sidebar.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const card = el.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, popover.anchor.left), window.innerWidth - card.width - margin);
    const below = popover.anchor.bottom + 4;
    const top = below + card.height + margin > window.innerHeight ? Math.max(margin, popover.anchor.top - card.height - 4) : below;
    setPos({ top, left });
  }, [popover.anchor, popover.detail, popover.error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePopover();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closePopover();
    };
    document.addEventListener("keydown", onKey);
    // Capture phase: a row click elsewhere should close this one before it
    // opens its own.
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, []);

  const detail = popover.detail;
  return (
    <div
      ref={ref}
      className="jira-popover"
      role="dialog"
      // Hidden until measured, so it never paints at the wrong spot first.
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
    >
      <div className="jira-pop-head">
        <span className="jira-key">{popover.key}</span>
        {detail && (
          <a
            className="icon-button"
            href={detail.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Jira"
          >
            <Icon name="link-external" />
          </a>
        )}
        <button className="icon-button" title="Close" onClick={closePopover}>
          <Icon name="close" />
        </button>
      </div>

      {popover.error && <div className="jira-error">{popover.error}</div>}
      {!detail && !popover.error && <div className="jira-empty">Loading…</div>}

      {detail && (
        <>
          <div className="jira-pop-title">{detail.summary}</div>
          <div className="jira-pop-facts">
            {detail.type && <span className="jira-chip">{detail.type}</span>}
            {detail.status && <span className="jira-chip">{detail.status}</span>}
            {detail.priority && <span className="jira-chip">{detail.priority}</span>}
            {detail.labels.map((label) => (
              <span key={label} className="jira-chip jira-chip-label">
                {label}
              </span>
            ))}
          </div>
          <div className="jira-pop-body">
            <div className="jira-pop-section">Description</div>
            <div className="jira-pop-text">
              {detail.description ? <RichText text={detail.description} /> : "(none)"}
            </div>
            {detail.comments.length > 0 && (
              <>
                <div className="jira-pop-section">Comments ({detail.comments.length})</div>
                {detail.comments.map((comment, i) => (
                  <div key={i} className="jira-comment">
                    <div className="jira-comment-head">
                      {comment.author}
                      {comment.created ? ` · ${comment.created.slice(0, 10)}` : ""}
                    </div>
                    <div className="jira-pop-text">
                      <RichText text={comment.body} />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Issue list (shared by both panes) ----

function IssueList({ issues, list, showMenu }: { issues: IssueRow[]; list: ListId; showMenu?: SidebarPanelHostProps["showMenu"] }) {
  const { busyKey, popover } = useJira();

  // With more than one agent in the registry, Start work asks which to use
  // instead of silently taking the first: offering only entry [0] made every
  // agent after the first unreachable. One agent (or no showMenu from the
  // host) keeps the direct, no-click-extra path.
  const handleStartClick = useCallback(
    async (issue: IssueRow, event: { clientX: number; clientY: number }) => {
      // Read before awaiting: the menu is placed at the click, and the
      // event must not be touched after an await.
      const { clientX, clientY } = event;
      const presets = await agentPresets();
      // Whether to skip permission prompts is NOT asked here. It is one
      // global choice - Settings → AI Providers' Yolo/Manual - and the app
      // applies it to the command this extension is handed. Asking again per
      // issue meant the same question in three places, and a local answer
      // could silently contradict the global one.
      if (presets.length <= 1 || !showMenu) {
        void startWork(issue, presets[0] ?? null);
        return;
      }
      showMenu(clientX, clientY, [
        ...presets.map((preset) => ({
          label: preset.name,
          onClick: () => void startWork(issue, preset),
        })),
        { label: "No agent (worktree only)", onClick: () => void startWork(issue, null) },
      ]);
    },
    [showMenu, list],
  );

  // Tooltip only - the menu-or-direct decision above awaits the real answer,
  // so a first render before the registry has been read costs nothing worse
  // than the singular wording for a moment.
  const multiplePresets = useAgentPresets().length > 1;

  return (
    <ul className="jira-list">
      {issues.map((issue) => {
        const open = popover?.key === issue.key && popover.list === list;
        return (
          <li key={issue.key} className={`jira-row${open ? " open" : ""}`}>
            {/* The row opens the details popover rather than linking straight
                out to Jira: reading the ticket is the common case, and the
                popover carries its own "Open in Jira" link for the other one.
                Summary on its own line, because a key plus a status chip plus
                an age leaves nothing readable beside it at sidebar width. */}
            <button
              className="jira-row-main"
              title={issue.summary}
              onClick={(e) => openPopover(issue, list, e.currentTarget)}
            >
              <span className="jira-title">{issue.summary}</span>
              <span className="jira-sub">
                <span className="jira-key">{issue.key}</span>
                <span className="jira-chip" data-cat={issue.statusCategory ?? "unknown"}>
                  {issue.status}
                </span>
                <span className="jira-age">{relativeTime(issue.updated)}</span>
              </span>
            </button>
            <button
              className="icon-button jira-start"
              title={
                multiplePresets
                  ? "Start work: create a worktree session and pick an agent"
                  : "Start work: create a worktree session for this issue"
              }
              disabled={busyKey === issue.key}
              onClick={(e) => void handleStartClick(issue, e)}
            >
              <Icon name={busyKey === issue.key ? "loading" : "play"} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Every state that isn't "here is a list" is identical in both panes, so it
// is answered once here and each pane renders its own list underneath.
function gateMessage(s: JiraState): { kind: "error" | "empty"; text: string } | null {
  if (s.error) return { kind: "error", text: s.error };
  if (!s.cwd) return { kind: "empty", text: "No active window." };
  if (!s.status) return { kind: "empty", text: "Loading…" };
  if (!s.status.configured) {
    return {
      kind: "empty",
      text: s.status.hasToken
        ? "Not configured. Set jira.siteUrl and jira.email in Settings."
        : "Not configured. Set jira.siteUrl and jira.email in Settings, then add an API token there.",
    };
  }
  if (!s.status.authed) return { kind: "error", text: s.status.error ?? "Could not sign in to Jira." };
  return null;
}

function Gate({ message }: { message: { kind: "error" | "empty"; text: string } }) {
  return <div className={message.kind === "error" ? "jira-error" : "jira-empty"}>{message.text}</div>;
}

// ---- The two panes ----

function AssignedPanel({ showMenu }: SidebarPanelHostProps) {
  const s = useJira();
  const gate = gateMessage(s);
  return (
    <div className="jira-panel">
      {s.startError && <div className="jira-error">{s.startError}</div>}
      {s.note && <div className="jira-note">{s.note}</div>}
      {gate ? (
        <Gate message={gate} />
      ) : s.mine.length === 0 ? (
        <div className="jira-empty">No issues assigned to you.</div>
      ) : (
        <IssueList issues={s.mine} list="mine" showMenu={showMenu} />
      )}
      {s.popover?.list === "mine" && <DetailPopover popover={s.popover} />}
    </div>
  );
}

function ProjectPanel({ showMenu }: SidebarPanelHostProps) {
  const s = useJira();
  const gate = gateMessage(s);
  // projectSource "projectJql" means the query replaced the key entirely, so
  // the caption says so rather than naming a key that no longer applies.
  const caption =
    s.project?.projectSource === "projectJql" ? "Custom query" : (s.project?.projectKey ?? null);

  return (
    <div className="jira-panel">
      {gate ? (
        <Gate message={gate} />
      ) : caption === null ? (
        <div className="jira-empty">
          No project key - add a .jira-project file, map this repo in jira.projectMap, or set jira.projectKey.
        </div>
      ) : (
        <>
          <div className="jira-caption">{caption}</div>
          {s.project!.issues.length === 0 ? (
            <div className="jira-empty">No open issues.</div>
          ) : (
            <IssueList issues={s.project!.issues} list="project" showMenu={showMenu} />
          )}
        </>
      )}
      {s.popover?.list === "project" && <DetailPopover popover={s.popover} />}
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    defaultTab?: string;
    focusBinding?: string;
    component: (props: SidebarPanelHostProps) => ReturnType<typeof AssignedPanel>;
  }): void;
  registerSettingsComponent(entry: { id: string; component: () => ReturnType<typeof SettingsPanel> }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
  };
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  getActiveContext = ctx.app.getActiveContext;
  onDidChangeContext = ctx.app.onDidChangeContext;
  openSessionWindow = ctx.app.openSessionWindow;
  extSettings = ctx.settings;
  setFetcher(ctx.serverFetch);
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  // The store is driven from here, not from a component: two panes share it,
  // and either one may be collapsed or absent when the context changes.
  state = { ...state, cwd: getActiveContext?.().cwd ?? null };
  refresh();
  disposeBridge = [
    onDidChangeContext?.((active) => {
      if (active.cwd === state.cwd) return;
      setState({ cwd: active.cwd, popover: null });
      refresh();
    }) ?? (() => {}),
    // Editing jira.siteUrl/jira.email, or saving a token, both change what
    // /status would answer.
    ctx.settings.onDidChange(() => refresh()),
    onTokenChange(() => refresh()),
  ];

  // "project" is the codicon name; style.css replaces the glyph with the Jira
  // mark, scoped to this panel's own tab id.
  ctx.registerSidebarPanel({
    id: "jira",
    title: "Assigned to Me",
    icon: "project",
    component: AssignedPanel,
  });
  // Its own pane rather than a section inside the first: the host's accordion
  // then owns collapse, resize and reorder, and remembers them per user.
  // defaultTab puts it under the JIRA tab instead of standing up a second tab
  // (core namespaces the id - see client/src/extensions.ts).
  ctx.registerSidebarPanel({
    id: "project",
    title: "Project",
    icon: "folder",
    location: "tab",
    defaultTab: "jira",
    component: ProjectPanel,
  });

  ctx.registerSettingsComponent({ id: "jira-token", component: SettingsPanel });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  for (const dispose of disposeBridge) dispose();
  disposeBridge = [];
  listeners.clear();
}
