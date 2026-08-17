// GUI Apps: runs xpra (adaptive HTML5 remote display) on the host and
// embeds its client in a viewer tab via the core app's own /proxy/<port>/
// route — see this extension's server.js for why xpra has to run inside a
// tmux session for that route to allow it at all. The sidebar panel owns
// start/stop/launch; GuiView (a viewer tab, never file-matched) just iframes
// whatever port is currently live.
import { useCallback, useEffect, useRef, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import Icon from "./Icon";

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface GuiStatus {
  installed: boolean;
  running: boolean;
  port: number | null;
  display: string | null;
  mode: "seamless" | "desktop" | null;
  encodings: Record<string, boolean>;
}

const STATUS_POLL_MS = 2000;

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;

async function fetchStatus(): Promise<GuiStatus> {
  if (!serverFetch) throw new Error("extension not active");
  const res = await serverFetch("/status");
  const body = (await res.json().catch(() => null)) as GuiStatus | { error?: string } | null;
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return body as GuiStatus;
}

async function postJson<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  if (!serverFetch) throw new Error("extension not active");
  const res = await serverFetch(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(parsed?.error ?? `${res.status} ${res.statusText}`);
  return (parsed ?? {}) as T;
}

// True once we know the build has *some* real picture codec beyond png —
// jpeg/webp/vpx cover xpra's normal adaptive path; x264 alone (video-only)
// would still leave still-image regions on png, so it isn't counted here.
function hasFastEncoding(encodings: Record<string, boolean>): boolean {
  return Boolean(encodings.jpeg || encodings.webp || encodings.vpx);
}

function GuiPanel() {
  const [status, setStatus] = useState<GuiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState("");

  const poll = useCallback(() => {
    fetchStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    poll();
    const id = window.setInterval(poll, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [poll]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await postJson<GuiStatus>("/start"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson("/stop");
      poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const launch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const cwd = getActiveContext?.().cwd ?? undefined;
      await postJson("/launch", { command: command.trim(), cwd });
      setCommand("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="gui-panel gui-panel-status">Loading…</div>;
  }

  if (!status.installed) {
    return (
      <div className="gui-panel">
        <div className="gui-panel-status">
          xpra isn't installed on this host — see this extension's README for the install command, then reload this
          panel.
        </div>
      </div>
    );
  }

  return (
    <div className="gui-panel">
      {!status.running && (
        <button className="gui-btn gui-btn-primary" disabled={busy} onClick={() => void start()}>
          <Icon name="play" /> Start GUI Session
        </button>
      )}
      {status.running && (
        <>
          <div className="gui-panel-row">
            <span className="gui-status-dot gui-status-on" />
            Running on display {status.display} ({status.mode === "desktop" ? "full desktop" : "individual apps"})
          </div>
          {!hasFastEncoding(status.encodings) && (
            <div className="gui-panel-warning">
              This xpra build only has png encoding available — performance will be degraded. Install a build with
              jpeg/webp/vpx support (see README).
            </div>
          )}
          <div className="gui-panel-row">
            <button
              className="gui-btn gui-btn-primary"
              disabled={busy}
              onClick={() => openViewerTab?.("guiView", "gui://display", { title: "GUI" })}
            >
              <Icon name="link-external" /> Open Display
            </button>
            <button className="gui-btn" disabled={busy} onClick={() => void stop()}>
              <Icon name="debug-stop" /> Stop
            </button>
          </div>
          <form className="gui-launch-form" onSubmit={(e) => void launch(e)}>
            <input
              className="gui-input"
              placeholder="Command to launch, e.g. xterm"
              value={command}
              disabled={busy}
              onChange={(e) => setCommand(e.target.value)}
            />
            <button className="gui-btn" type="submit" disabled={busy || !command.trim()}>
              Launch
            </button>
          </form>
        </>
      )}
      {error && <div className="gui-panel-error">{error}</div>}
    </div>
  );
}

interface GuiViewProps {
  active: boolean;
}

// xpra's own HTML5 client has a "Fullscreen" toolbar button, but it only
// sets an X11 window-level fullscreen hint (resizing the remote display to
// fill the tab) — it never calls the browser's real Fullscreen API, so it
// never actually reclaims browser-reserved shortcuts (Ctrl+W, Ctrl+T, …)
// from the tab. This button does that for real: requestFullscreen() on the
// iframe plus the Keyboard Lock API (Chromium-only — feature-detected,
// silently a no-op elsewhere) while fullscreen.
function FullscreenButton({ targetRef }: { targetRef: React.RefObject<HTMLIFrameElement | null> }) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const keyboardLockSupported = typeof navigator !== "undefined" && !!(navigator as unknown as { keyboard?: { lock?: unknown } }).keyboard?.lock;

  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === targetRef.current;
      setIsFullscreen(active);
      if (!active && keyboardLockSupported) {
        (navigator as unknown as { keyboard: { unlock: () => void } }).keyboard.unlock();
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (typeof document === "undefined" || !document.fullscreenEnabled) return null;

  const toggle = async () => {
    if (isFullscreen) {
      await document.exitFullscreen();
      return;
    }
    await targetRef.current?.requestFullscreen();
    if (keyboardLockSupported) {
      try {
        await (navigator as unknown as { keyboard: { lock: () => Promise<void> } }).keyboard.lock();
      } catch {
        // Unsupported/blocked — fullscreen still applies, just without
        // reclaimed browser shortcuts. Escape always exits fullscreen
        // regardless (the Fullscreen API spec guarantees this even with
        // Keyboard Lock active), so there's no trap either way.
      }
    }
  };

  return (
    <button className="gui-view-fullscreen-btn" onClick={() => void toggle()} title={isFullscreen ? "Exit fullscreen" : "Fullscreen (also reclaims browser shortcuts like Ctrl+W in Chromium)"}>
      <Icon name={isFullscreen ? "screen-normal" : "screen-full"} />
    </button>
  );
}

function GuiView({ active }: GuiViewProps) {
  const [status, setStatus] = useState<GuiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="gui-view-host">
        <div className="gui-view-status gui-view-error">
          {error}
          <button className="gui-btn" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="gui-view-host">
        <div className="gui-view-status">Loading…</div>
      </div>
    );
  }

  if (!status.running || !status.port) {
    return (
      <div className="gui-view-host">
        <div className="gui-view-status">
          No GUI session is running — start one from the GUI Apps sidebar panel.
          <button className="gui-btn" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`gui-view-host${active ? "" : " hidden"}`}>
      <iframe
        ref={iframeRef}
        className="gui-view-frame"
        src={`/proxy/${status.port}/`}
        title="GUI display"
        // No sandbox: the xpra HTML5 client needs full keyboard/pointer/
        // clipboard access and its own WebSocket back to the same origin —
        // this is same-origin infrastructure we run ourselves, unlike a
        // file-viewer iframe showing untrusted user content.
      />
      <FullscreenButton targetRef={iframeRef} />
    </div>
  );
}

interface QuickSwitcherItem {
  label: string;
  tag?: string;
  run: (secondary: boolean) => void;
}

interface ExtensionContext {
  registerCommand(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location: "tab" | "explorer" | "run" | "commands";
    component: React.ComponentType;
  }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: React.ComponentType<GuiViewProps>;
  }): void;
  app: {
    getActiveContext(): ActiveContext;
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  openViewerTab = ctx.app.openViewerTab;
  getActiveContext = ctx.app.getActiveContext;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: "gui",
    title: "GUI Apps",
    icon: "device-desktop",
    location: "tab",
    component: GuiPanel,
  });

  ctx.registerFileViewer({
    id: "guiView",
    extensions: [],
    mode: "default",
    component: GuiView,
  });

  ctx.registerCommand({
    id: "openDisplay",
    label: "GUI: Open Display",
    run: () => openViewerTab?.("guiView", "gui://display", { title: "GUI" }),
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  openViewerTab = null;
  getActiveContext = null;
}
