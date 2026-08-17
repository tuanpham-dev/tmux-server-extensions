# GUI Apps

Run Linux GUI apps on the server and view/control them right inside tmux-server, streamed over [xpra](https://xpra.org/) — an adaptive, low-latency HTML5 remote display. Much faster than X11 forwarding (`ssh -X`) or plain VNC: xpra sends only the screen regions that changed, encoded per-region (jpeg/webp for UI, video codecs for motion) instead of polling full frames.

## Install xpra (one-time, on the server)

Not in Debian's default apt repos — install from xpra.org's own repo:

```sh
sudo wget -O /usr/share/keyrings/xpra.asc https://xpra.org/xpra.asc
echo "deb [signed-by=/usr/share/keyrings/xpra.asc] https://xpra.org/ $(lsb_release -cs) main" | \
  sudo tee /etc/apt/sources.list.d/xpra.list
sudo apt update && sudo apt install -y xpra xpra-html5
```

(Tested on Debian 13 "trixie"; xpra.org publishes matching repos for other current Debian/Ubuntu releases — replace `$(lsb_release -cs)` if yours isn't listed.)

No GPU required — xpra falls back to software encoders (jpeg/webp/vpx/x264), which is what actually drives its performance day to day. The **GUI Apps** sidebar panel shows a warning if your build only has png available (rare; a repo install always ships the full set).

## Usage

1. Open the **GUI Apps** sidebar tab.
2. **Start GUI Session** — brings up an xpra display in the background (a dedicated `gui-apps` tmux session, visible like any other session if you want to check its log).
3. Type a command (e.g. `xterm`, `firefox`, `code`) and **Launch** — runs it on the display, in the active project's working directory.
4. **Open Display** — opens a tab embedding the live display; interact with it like a normal window.
5. **Stop** when done — tears the session down cleanly.

Repeat step 3 to launch more apps into the same display; they all share one desktop.

## Individual apps vs. full desktop

Two modes, set via `gui.mode` in this extension's Settings:

- **Individual apps** (default) — each launched app is its own window, composited directly by xpra. This is what step 3 above describes.
- **Full desktop** — streams one whole desktop environment (its own window manager, taskbar, wallpaper) instead. Use this to run something like XFCE. **Don't launch a full desktop environment's session command in Individual apps mode** — its own window manager fights xpra's own window handling (double title bars, broken window state); full desktop mode exists specifically to avoid that.

To run XFCE:

```sh
sudo apt install -y xfce4
```

Then set `gui.mode` to **Full desktop** in Settings (leave `gui.desktopCommand` at its default `xfce4-session`) and **Start GUI Session** — XFCE launches automatically, no need to type it into the Launch box. Switching modes on an already-running session needs a **Stop** then **Start** — the mode is only read when a session starts.

Other desktop environments work the same way — install it, then set `gui.desktopCommand` to whatever launches it (e.g. `startlxde` for LXDE, `mate-session` for MATE).

## Settings

| Setting | Default | Description |
|---|---|---|
| `gui.display` | `:100` | X11 display number xpra creates. |
| `gui.port` | `14500` | Preferred port for xpra's HTML5 server (auto-picks the next free one if taken). |
| `gui.quality` | `auto` | `auto` (adaptive), `high` (biases toward image quality), or `low` (biases toward responsiveness). |
| `gui.dpi` | `96` | DPI reported to apps running on the display. |
| `gui.mode` | `seamless` | `seamless` (individual apps) or `desktop` (full desktop environment) — see above. |
| `gui.desktopCommand` | `xfce4-session` | Full desktop mode only: the command that starts the desktop environment. |
| `gui.resizeDisplay` | `auto` | `auto` follows the browser window's size (including xpra's own Fullscreen toggle); `fixed` locks the display at its initial resolution instead — see the cursor-size note below. |

## Reclaiming browser shortcuts (Ctrl+W, Ctrl+T, …)

The display tab has its own **fullscreen button** in its top-right corner (separate from xpra's own toolbar — see note below) that does two things together: puts the display in real browser fullscreen, and (Chromium-based browsers only) locks the keyboard so shortcuts like Ctrl+W and Ctrl+T reach the display instead of your browser. Escape always exits fullscreen regardless, so there's no way to get stuck. Everything else (including most app shortcuts) already passes through normally without it.

xpra's own **"Fullscreen" icon inside its toolbar** (the hamburger-style row at the top of the display itself) does something different and unrelated: it's an X11 window-level fullscreen hint that resizes the remote display to fill the tab — it does not touch the browser's real fullscreen or keyboard APIs, so it doesn't reclaim any shortcuts. Use our button (outside the iframe, top-right corner) for that.

## Known limitations

- Keyboard Lock is Chromium-only (not supported in Firefox/Safari) — on those browsers the fullscreen button still works, just without reclaiming shortcuts.
- One shared display per host for v1 — all launched apps land on the same desktop, not isolated per app.
- **Full desktop mode:** logging out of the desktop environment (rather than clicking **Stop**) leaves xpra itself running with an empty display — the session still shows as "running" in the panel, just with nothing to look at. Click **Stop** and **Start** again to get a fresh desktop.
- **Oversized cursor/UI after resizing:** with `gui.resizeDisplay` at its default (`auto`), resizing the browser window — including via xpra's own Fullscreen toggle above — makes xpra recalculate DPI from the reported physical monitor size, which can drift far enough from `gui.dpi` to make the cursor and UI elements balloon in size. Set `gui.resizeDisplay` to `fixed` to stop this (tradeoff: the display then scales to fit your window instead of resizing natively, so text can look slightly softer).
- **Flashing/doubled cursor in full desktop mode (unresolved):** xpra's own cursor rendering runs on top of (not instead of) your real browser cursor and visibly diverges from it while moving — two cursor shapes, the wrong one oversized, flashing during movement. We tried disabling xpra's cursor forwarding entirely (`--cursors=no`) to fix this, but that setting crashes xpra's own pointer handler in desktop mode on every mouse move and click (a bug in xpra itself: `_adjust_pointer` calls a method, `restore_cursor`, that only exists when cursor forwarding is on) — silently breaking all mouse input, which is far worse than a visual glitch. That attempt has been reverted; the cursor issue remains open with no known client-side fix. If it bothers you, individual apps (`gui.mode: seamless`) may not have the same issue — the affected code path is specific to xpra's desktop/shadow server.
