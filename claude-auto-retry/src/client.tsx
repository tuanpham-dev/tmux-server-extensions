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
        Claude hit its {kindLabel(ev.kind)} in {title} — auto-continuing in {formatCountdown(ev.sendAt ?? now, now)}
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
        Claude hit its {kindLabel(ev.kind)} in {title} — resets at {formatTime(ev.resetAt)}. Continue after reset?
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
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  app: AppApi;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  appApi = ctx.app;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerAppOverlay({ id: "limit-toasts", component: LimitToasts });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  appApi = null;
}
