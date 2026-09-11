// claude-auto-retry client: renders the event toasts produced by the server
// hook's poll/scheduler loop over the app-global overlay extension point
// (registerAppOverlay) so they're visible over any tab, not just terminals.
// All the decision logic (detection, scheduling, sending) lives server-side
// -- this is presentation only, polling /events and forwarding button clicks.
import { useEffect, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";

// ---- Module-level host bridge ----

interface AppApi {
  openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let appApi: AppApi | null = null;
let removeStylesheet: (() => void) | null = null;

// ---- Event types (mirrors server.js's eventToJSON) ----

type EventStatus = "awaiting" | "scheduled" | "aborted" | "sent" | "skipped";

interface LimitEvent {
  id: string;
  sessionName: string;
  windowIndex: number;
  kind: "5h" | "weekly" | "unknown";
  resetAt: number | null;
  sendAt: number | null;
  status: EventStatus;
  dismissed: boolean;
  detectedAt: number;
  sentAt: number | null;
}

const POLL_INTERVAL_MS = 5000;
const SENT_AUTO_DISMISS_MS = 15_000;

async function fetchEvents(): Promise<LimitEvent[]> {
  if (!serverFetch) return [];
  try {
    const res = await serverFetch("/events");
    if (!res.ok) return [];
    const body = (await res.json()) as { events?: LimitEvent[] };
    return body.events ?? [];
  } catch {
    return [];
  }
}

function postAction(path: string, id: string): void {
  serverFetch?.(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

// ---- Formatting ----

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatCountdown(targetMs: number, now: number): string {
  const remaining = Math.max(0, targetMs - now);
  const totalSec = Math.round(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function kindLabel(kind: LimitEvent["kind"]): string {
  if (kind === "5h") return "5-hour limit";
  if (kind === "weekly") return "weekly limit";
  return "usage limit";
}

function windowLabel(ev: LimitEvent): string {
  return `${ev.sessionName}:${ev.windowIndex}`;
}

// ---- Toast component ----

function Toast({ ev, now, onAction }: { ev: LimitEvent; now: number; onAction: (path: string) => void }) {
  const openWindow = () => appApi?.openSessionWindow(ev.sessionName);
  const title = (
    <span className="autoretry-toast-title" onClick={openWindow} role="button" tabIndex={0}>
      {windowLabel(ev)}
    </span>
  );

  let message: React.ReactNode;
  let actions: { label: string; path: string; primary?: boolean }[];

  if (ev.status === "scheduled") {
    message = (
      <>
        Claude hit its {kindLabel(ev.kind)} in {title} - auto-continuing in {formatCountdown(ev.sendAt ?? now, now)}
        {ev.sendAt ? ` (${formatTime(ev.sendAt)})` : ""}.
      </>
    );
    actions = [
      { label: "Abort", path: "/abort" },
      { label: "Dismiss", path: "/dismiss" },
    ];
  } else if (ev.status === "awaiting" && ev.resetAt !== null) {
    message = (
      <>
        Claude hit its {kindLabel(ev.kind)} in {title} - resets at {formatTime(ev.resetAt)}. Continue after reset?
      </>
    );
    actions = [
      { label: "Yes", path: "/confirm", primary: true },
      { label: "Dismiss", path: "/dismiss" },
    ];
  } else if (ev.status === "awaiting") {
    message = (
      <>
        Claude hit a {kindLabel(ev.kind)} in {title}, but the reset time couldn't be read. Send "continue" now?
      </>
    );
    actions = [
      { label: "Yes", path: "/confirm", primary: true },
      { label: "Dismiss", path: "/dismiss" },
    ];
  } else if (ev.status === "sent") {
    message = <>Sent "continue" to {title}.</>;
    actions = [{ label: "Dismiss", path: "/dismiss" }];
  } else {
    // "aborted" / "skipped" are never surfaced (server keeps them only so
    // other devices' toasts disappear); this branch is unreachable in
    // practice since the poll filters them client-side too.
    return null;
  }

  return (
    <div className={`autoretry-toast autoretry-toast-${ev.status}`}>
      <div className="autoretry-toast-message">{message}</div>
      <div className="autoretry-toast-actions">
        {actions.map((a) => (
          <button
            key={a.path}
            className={a.primary ? "autoretry-btn autoretry-btn-primary" : "autoretry-btn"}
            onClick={() => onAction(a.path)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- Usage panel (T17) ----

interface ModelTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface UsageBlock {
  start: number;
  end: number;
  isCurrent: boolean;
  perModel: Record<string, ModelTotals>;
  total: ModelTotals;
  firstAt: number;
  lastAt: number;
}

interface UsageResponse {
  blocks: UsageBlock[];
  resetsAt5h: number | null;
  resetsAtWeekly: number | null;
  // From Claude Code's own rate-limit state file — the only figures here
  // that aren't reconstructed from local transcripts. null when the window
  // has already rolled over (its old percentage would describe a window that
  // no longer exists).
  fiveHourPct: number | null;
  sevenDayPct: number | null;
}

const USAGE_POLL_MS = 30_000;

async function fetchUsage(): Promise<UsageResponse | null> {
  if (!serverFetch) return null;
  try {
    const res = await serverFetch("/usage");
    if (!res.ok) return null;
    return (await res.json()) as UsageResponse;
  } catch {
    return null;
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function blockTotalTokens(b: UsageBlock): number {
  return b.total.input + b.total.output + b.total.cacheRead + b.total.cacheCreation;
}

function formatTimeRange(b: UsageBlock): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return `${new Date(b.start).toLocaleTimeString([], opts)}–${new Date(b.end).toLocaleTimeString([], opts)}`;
}

// Tokens/min over the block's own active span (first to last write) — not
// over the full 5h window, which would read as near-zero for a block that's
// mostly idle time.
function burnRate(b: UsageBlock): number | null {
  const spanMin = (b.lastAt - b.firstAt) / 60_000;
  if (spanMin < 0.5) return null;
  return blockTotalTokens(b) / spanMin;
}

// Claude's asterisk mark, inline so it inherits currentColor and the bar's
// own icon metric — a codicon would be someone else's glyph.
function ClaudeMark() {
  return (
    <svg className="autoretry-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2.6c.5 0 .9.4.9.9v5.2l3.7-3.7a.9.9 0 0 1 1.3 1.3l-3.7 3.7h5.2a.9.9 0 0 1 0 1.8h-5.2l3.7 3.7a.9.9 0 0 1-1.3 1.3l-3.7-3.7v5.2a.9.9 0 0 1-1.8 0v-5.2l-3.7 3.7a.9.9 0 0 1-1.3-1.3l3.7-3.7H4.6a.9.9 0 0 1 0-1.8h5.2L6.1 6.3a.9.9 0 0 1 1.3-1.3l3.7 3.7V3.5c0-.5.4-.9.9-.9Z"
      />
    </svg>
  );
}

// "4h 38m", "2d 21h" — how long the window has left, at the coarsest two
// units that still say something useful.
function formatRemaining(untilMs: number): string {
  const total = Math.max(0, untilMs - Date.now());
  const minutes = Math.floor(total / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

// One window's readout: a small meter, the percentage, and the time left.
function UsageMeter({ label, pct, resetsAt }: { label: string; pct: number; resetsAt: number | null }) {
  return (
    <span
      className="autoretry-status-meter"
      title={`${label}: ${pct}% used${resetsAt ? `, resets in ${formatRemaining(resetsAt)}` : ""}`}
    >
      <span className="autoretry-status-bar">
        {/* Filled proportionally; the class carries the warning colour past
            the thresholds where the number starts to matter. */}
        <span
          className={`autoretry-status-bar-fill${pct >= 90 ? " critical" : pct >= 70 ? " warn" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="autoretry-status-text">
        {pct}%
        <span className="full-only"> used{resetsAt ? ` ${formatRemaining(resetsAt)}` : ""}</span>
      </span>
    </span>
  );
}

interface StatusItemContext {
  openPopover(anchor: DOMRect, content: ReturnType<typeof UsagePanel>): void;
  closePopover(): void;
}

// The status-bar readout: the 5-hour and weekly limits at a glance, with the
// full usage panel one click away. Percentages come from Claude Code's own
// rate-limit file, so this shows nothing until that file exists — a token
// count would be a poor substitute, since it can't say how close to a limit
// you are.
function UsageStatusItem({ context }: { context: StatusItemContext }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const data = await fetchUsage();
      if (!cancelled && data) setUsage(data);
    };
    void poll();
    const id = setInterval(poll, USAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const fiveHour = usage?.fiveHourPct ?? null;
  const weekly = usage?.sevenDayPct ?? null;
  if (fiveHour === null && weekly === null) return null;

  return (
    <button
      className="status-bar-item autoretry-status-item"
      data-menu-trigger="true"
      aria-haspopup="dialog"
      title="Claude usage - click for the full breakdown"
      onClick={(e) => context.openPopover(e.currentTarget.getBoundingClientRect(), <UsagePanel />)}
    >
      <ClaudeMark />
      {fiveHour !== null && (
        <UsageMeter label="5-hour limit" pct={fiveHour} resetsAt={usage?.resetsAt5h ?? null} />
      )}
      {weekly !== null && (
        <UsageMeter label="Weekly limit" pct={weekly} resetsAt={usage?.resetsAtWeekly ?? null} />
      )}
    </button>
  );
}

function UsagePanel() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const data = await fetchUsage();
      if (!cancelled && data) setUsage(data);
    };
    void poll();
    const id = setInterval(poll, USAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!usage) {
    return <div className="autoretry-usage-empty">Loading…</div>;
  }

  const current = usage.blocks.find((b) => b.isCurrent);
  const previous = usage.blocks.filter((b) => !b.isCurrent);
  const rate = current ? burnRate(current) : null;

  return (
    <div className="autoretry-usage-panel">
      {current ? (
        <div className="autoretry-usage-current">
          <div className="autoretry-usage-headline">{formatCount(blockTotalTokens(current))} tokens</div>
          <div className="autoretry-usage-subline">
            Current block · {formatTimeRange(current)}
            {rate !== null ? ` · ${formatCount(rate)} tok/min` : ""}
          </div>
          <ul className="autoretry-usage-models">
            {Object.entries(current.perModel).map(([model, t]) => (
              <li key={model}>
                {model}: {formatCount(t.input + t.output + t.cacheRead + t.cacheCreation)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="autoretry-usage-empty">No activity in the current block.</div>
      )}
      {previous.length > 0 && (
        <div className="autoretry-usage-previous">
          <div className="autoretry-usage-previous-header">Previous blocks</div>
          {previous.map((b) => (
            <div key={b.start} className="autoretry-usage-previous-row">
              <span>{formatTimeRange(b)}</span>
              <span>{formatCount(blockTotalTokens(b))}</span>
            </div>
          ))}
        </div>
      )}
      {usage.resetsAtWeekly && (
        <div className="autoretry-usage-footnote">
          Weekly limit resets {new Date(usage.resetsAtWeekly).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.
        </div>
      )}
      <div className="autoretry-usage-footnote">Estimated from local transcripts - not official rate-limit data.</div>
    </div>
  );
}

// ---- App overlay ----

interface AppOverlayContext {
  mobilePointer: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function LimitToasts(_props: { context: AppOverlayContext }) {
  const [events, setEvents] = useState<LimitEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const list = await fetchEvents();
      if (!cancelled) setEvents(list.filter((e) => e.status === "scheduled" || e.status === "awaiting" || e.status === "sent"));
    };
    void poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Local 1s tick so the auto-continue countdown reads live between polls.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Auto-dismiss "sent" toasts after a delay so they don't linger forever.
  useEffect(() => {
    const timers = events
      .filter((e) => e.status === "sent")
      .map((e) =>
        setTimeout(() => {
          postAction("/dismiss", e.id);
          setEvents((prev) => prev.filter((x) => x.id !== e.id));
        }, SENT_AUTO_DISMISS_MS),
      );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.map((e) => e.id).join(",")]);

  const onAction = (path: string, id: string) => {
    postAction(path, id);
    setEvents((prev) => prev.filter((e) => e.id !== id));
  };

  if (events.length === 0) return null;

  return (
    <div className="autoretry-toast-stack">
      {events.map((ev) => (
        <Toast key={ev.id} ev={ev} now={now} onAction={(path) => onAction(path, ev.id)} />
      ))}
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerAppOverlay(overlay: {
    id: string;
    component: (props: { context: AppOverlayContext }) => ReturnType<typeof LimitToasts>;
  }): void;
  registerStatusBarItem(item: {
    id: string;
    placement?: "left" | "right";
    order?: number;
    component: (props: { context: StatusItemContext }) => ReturnType<typeof UsageStatusItem>;
  }): void;
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    component: () => ReturnType<typeof UsagePanel>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  app: AppApi;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  appApi = ctx.app;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerAppOverlay({ id: "limit-toasts", component: LimitToasts });
  // No sidebar panel any more — the status-bar item's popover renders this
  // same panel, which is the whole surface now.
  ctx.registerStatusBarItem({ id: "usage", placement: "left", component: UsageStatusItem });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  appApi = null;
}
