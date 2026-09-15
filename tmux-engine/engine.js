// tmux as a terminal engine: the multiplexer interface (server/src/multiplexer.ts)
// implemented against a tmux server, so sessions made with `tmux new` in any
// terminal show up in the app and sessions made in the app are ordinary tmux
// sessions.
//
// How the interface maps onto tmux:
// - A session is a tmux session. A window is one tmux *pane*: the app shows
//   one terminal per tab, so a tmux window split into panes shows up as one
//   app window per pane. The first pane of a tmux window takes the window's
//   index and name; each further pane gets index 10000 + its pane number and
//   the name "<window>·<pane index>".
// - Window ids are "tmux-<n>" for pane %n. They last as long as the tmux
//   server does.
// - Listings and one-off changes run plain `tmux` commands.
// - Viewing a terminal goes through one control-mode client (`tmux -C`) per
//   session that has viewers. Its output notifications carry the raw bytes
//   programs write, which is what the browser's terminal wants; history comes
//   from capture-pane on attach. The control client sets `ignore-size`, so a
//   tmux terminal the user has attached keeps deciding the window size; with
//   none attached, the app's viewer size applies (refresh-client -C per
//   window).
// - Nothing is restored after a reboot: that is tmux's own business
//   (tmux-resurrect and friends), so restoredCommands is always null and the
//   engine settings for shell and restore don't apply.
import { execFile, spawn } from "node:child_process";

const SEP = "\x1f";
// tmux prints the separator back as the text \037 (older versions: as itself).
const SPLIT = /\\037|\x1f/;
const HISTORY_LINES = 10_000;
const EXTRA_PANE_BASE = 10_000;
const DETACH_GRACE_MS = 5_000;
const POLL_MS = 1_500;
const INPUT_CHUNK = 512;
const PROCESS_TTL_MS = 1_000;

const REFRESH_PREFIX = "\x1b[0m\x1b[?1049l\x1b[?25h\x1b[H\x1b[2J\x1b[3J";

export function windowIdOf(paneId) {
  return `tmux-${paneId.slice(1)}`;
}

export function paneIdOf(windowId) {
  const m = /^tmux-(\d+)$/.exec(windowId);
  return m ? `%${m[1]}` : null;
}

// Control-mode output escapes bytes below 32 and the backslash as \ooo; every
// other byte arrives as itself.
export function decodeOutput(bytes) {
  const out = Buffer.allocUnsafe(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x5c && i + 3 < bytes.length && isOctal(bytes[i + 1]) && isOctal(bytes[i + 2]) && isOctal(bytes[i + 3])) {
      out[n++] = ((bytes[i + 1] - 48) << 6) | ((bytes[i + 2] - 48) << 3) | (bytes[i + 3] - 48);
      i += 3;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

function isOctal(b) {
  return b >= 48 && b <= 55;
}

// Arguments for `send-keys -H`: each byte as two hex digits, in chunks small
// enough for one command line.
export function hexChunks(data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const chunks = [];
  for (let i = 0; i < buf.length; i += INPUT_CHUNK) {
    chunks.push([...buf.subarray(i, i + INPUT_CHUNK)].map((b) => b.toString(16).padStart(2, "0")));
  }
  return chunks;
}

// A tmux command line argument, quoted for tmux's own parser.
export function quoteArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const SESSION_FORMAT = ["#{session_id}", "#{session_name}", "#{session_created}", "#{session_attached}", "#{session_path}"].join(SEP);

const PANE_FORMAT = [
  "#{session_id}",
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{automatic-rename}",
  "#{window_active}",
  "#{window_activity}",
  "#{window_bell_flag}",
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_active}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_pid}",
].join(SEP);

export function parseSessions(stdout) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, name, created, attached, path] = line.split(SPLIT);
      return { id, name, createdAt: Number(created) * 1000, attached: Number(attached) || 0, rootCwd: path };
    });
}

export function parsePanes(stdout) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const f = line.split(SPLIT);
      return {
        sessionId: f[0],
        windowId: f[1],
        windowIndex: Number(f[2]),
        windowName: f[3],
        autoName: f[4] === "1" || f[4] === "on",
        windowActive: f[5] === "1",
        windowActivity: Number(f[6]) * 1000,
        bell: f[7] === "1",
        paneId: f[8],
        paneIndex: Number(f[9]),
        paneActive: f[10] === "1",
        cwd: f[11],
        command: f[12],
        pid: Number(f[13]) || 0,
      };
    });
}

// Sessions of app windows, from a tmux session and pane listing. `extra`
// supplies what tmux doesn't know: our own control clients (not viewers the
// user would count), per-pane activity, and process names under a pid.
export function buildSessions(sessions, panes, extra = {}) {
  const controlClients = extra.controlClients ?? new Map();
  const lastSeen = extra.lastSeen ?? new Map();
  const childNames = extra.childNames ?? (() => []);
  const startedAt = extra.startedAt ?? 0;
  const bySession = new Map(sessions.map((s) => [s.id, []]));
  for (const p of panes) bySession.get(p.sessionId)?.push(p);
  return sessions.map((s) => {
    const own = bySession.get(s.id) ?? [];
    const firstPane = new Map();
    for (const p of own) {
      const first = firstPane.get(p.windowId);
      if (!first || p.paneIndex < first.paneIndex) firstPane.set(p.windowId, p);
    }
    const windows = own.map((p) => {
      const isFirst = firstPane.get(p.windowId) === p;
      const index = isFirst ? p.windowIndex : EXTRA_PANE_BASE + Number(p.paneId.slice(1));
      const seen = lastSeen.get(p.paneId) ?? startedAt;
      return {
        id: windowIdOf(p.paneId),
        index,
        name: isFirst ? p.windowName : `${p.windowName}·${p.paneIndex}`,
        autoName: isFirst ? p.autoName : true,
        current: p.windowActive && p.paneActive,
        cwd: p.cwd,
        command: p.command,
        declaredCommand: "",
        commands: childNames(p.pid),
        pid: p.pid,
        activity: seen !== Infinity && p.windowActivity > seen,
        lastOutputAt: p.windowActivity,
        restoredCommands: null,
      };
    });
    windows.sort((a, b) => a.index - b.index);
    return {
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      attached: Math.max(0, s.attached - (controlClients.get(s.name) ?? 0)),
      rootCwd: s.rootCwd,
      currentIndex: windows.find((w) => w.current)?.index ?? windows[0]?.index ?? 0,
      windows,
    };
  });
}

// What a fresh viewer is sent before live output: the pane's history and
// screen, the cursor, and the modes a program set, so the browser's terminal
// ends up where tmux's is.
export function replayPayload(state, history, screen) {
  const lines = (text) => text.replace(/\n$/, "").split("\n").map((l) => `${l}\x1b[0m`).join("\r\n");
  let out = REFRESH_PREFIX;
  if (history) out += `${lines(history)}\r\n`;
  if (state.alternate) out += "\x1b[?1049h\x1b[H";
  out += lines(screen);
  out += `\x1b[${state.cursorY + 1};${state.cursorX + 1}H`;
  if (state.keypadCursor) out += "\x1b[?1h";
  if (state.mouseStandard) out += "\x1b[?1000h";
  if (state.mouseButton) out += "\x1b[?1002h";
  if (state.mouseAny) out += "\x1b[?1003h";
  if (state.mouseSgr) out += "\x1b[?1006h";
  if (!state.cursorVisible) out += "\x1b[?25l";
  return Buffer.from(out, "utf8");
}

const STATE_FORMAT = [
  "#{cursor_x}",
  "#{cursor_y}",
  "#{alternate_on}",
  "#{history_size}",
  "#{pane_width}",
  "#{pane_height}",
  "#{keypad_cursor_flag}",
  "#{mouse_standard_flag}",
  "#{mouse_button_flag}",
  "#{mouse_any_flag}",
  "#{mouse_sgr_flag}",
  "#{cursor_flag}",
  "#{window_id}",
].join(" ");

function parseState(line) {
  const f = line.trim().split(" ");
  return {
    cursorX: Number(f[0]),
    cursorY: Number(f[1]),
    alternate: f[2] === "1",
    historySize: Number(f[3]),
    cols: Number(f[4]),
    rows: Number(f[5]),
    keypadCursor: f[6] === "1",
    mouseStandard: f[7] === "1",
    mouseButton: f[8] === "1",
    mouseAny: f[9] === "1",
    mouseSgr: f[10] === "1",
    cursorVisible: f[11] !== "0",
    windowId: f[12],
  };
}

// One `tmux -C attach` for a session. Replies arrive in the order commands
// were sent, framed by %begin/%end (or %error) lines flagged as ours, and
// interleave with notifications strictly in the order tmux produced them:
// output seen before a capture's reply is already in that capture.
class ControlClient {
  constructor(engine, session) {
    this.engine = engine;
    this.session = session;
    this.pending = [];
    this.reply = null;
    this.viewers = new Set();
    this.closed = false;
    this.detachTimer = null;
    this.buf = Buffer.alloc(0);
    this.proc = spawn("tmux", [...engine.socketArgs, "-C", "attach-session", "-t", `=${session}`], {
      env: engine.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.on("exit", () => this.onExit());
    this.proc.on("error", () => this.onExit());
    this.proc.stdin.on("error", () => {});
    // Who decides window sizes for this session: "terminals" (real tmux
    // clients, ignore-size on) until an app viewer is used, then "app".
    this.sizing = "terminals";
    this.appActiveAt = 0;
    // Answered before anything else is sent, so it never takes the attach's
    // own reply block.
    this.ready = this.command("refresh-client -f ignore-size").catch(() => {});
  }

  command(line) {
    return this.commands([line]).then(([lines]) => lines);
  }

  // Several commands on one line, which tmux runs back to back with no pane
  // output in between. `onDone` runs synchronously as the last reply is read,
  // before any line after it: output from that point on is live.
  commands(lines, onDone) {
    if (this.closed) return Promise.reject(new Error("tmux control client closed"));
    const replies = lines.map(
      (_, i) =>
        new Promise((resolve, reject) => {
          const last = i === lines.length - 1;
          this.pending.push({
            resolve: (value) => {
              if (last) onDone?.();
              resolve(value);
            },
            reject: (err) => {
              if (last) onDone?.();
              reject(err);
            },
          });
        }),
    );
    this.proc.stdin.write(`${lines.join(" ; ")}\n`);
    return Promise.all(replies);
  }

  // Fire and forget, for input and resizes: an error reply is still consumed.
  send(line) {
    this.command(line).catch(() => {});
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = 0;
    for (let i = this.buf.indexOf(10, start); i !== -1; i = this.buf.indexOf(10, start)) {
      this.onLine(this.buf.subarray(start, i));
      start = i + 1;
    }
    this.buf = this.buf.subarray(start);
  }

  onLine(line) {
    if (this.reply) {
      const text = line.toString("utf8");
      if (/^%(end|error) \d+ \d+ 1$/.test(text)) {
        const { lines } = this.reply;
        this.reply = null;
        const waiter = this.pending.shift();
        if (!waiter) return;
        if (text.startsWith("%end")) waiter.resolve(lines);
        else waiter.reject(new Error(lines.join("\n") || "tmux command failed"));
        return;
      }
      if (this.reply.ours) this.reply.lines.push(text);
      else if (/^%(end|error) /.test(text)) this.reply = null;
      return;
    }
    if (line[0] !== 0x25) return; // not a notification
    if (line.subarray(0, 8).toString() === "%output ") {
      const space = line.indexOf(32, 8);
      if (space === -1) return;
      const paneId = line.subarray(8, space).toString();
      this.engine.onOutput(this, paneId, decodeOutput(line.subarray(space + 1)));
      return;
    }
    const text = line.toString("utf8");
    const begin = /^%begin \d+ \d+ (\d+)$/.exec(text);
    if (begin) {
      this.reply = { ours: (Number(begin[1]) & 1) === 1, lines: [] };
      return;
    }
    if (text.startsWith("%exit")) {
      this.onExit();
      return;
    }
    this.engine.onNotification(this, text);
  }

  onExit() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.splice(0)) waiter.reject(new Error("tmux control client exited"));
    this.engine.onControlExit(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.detachTimer);
    for (const waiter of this.pending.splice(0)) waiter.reject(new Error("tmux control client closed"));
    try {
      this.proc.stdin.end();
    } catch {
      // Already gone.
    }
    this.engine.onControlExit(this);
  }
}

// `socketName` and `configFile` pick a separate tmux server (tmux -L, -f), for
// tests and test instances.
export function createTmuxEngine({ env = process.env, socketName = "", configFile = "", bin = "tmux", log = () => {} } = {}) {
  const socketArgs = [...(socketName ? ["-L", socketName] : []), ...(configFile ? ["-f", configFile] : [])];
  // tmux started from here must not think it is nested in the launcher's tmux.
  const cleanEnv = { ...env };
  delete cleanEnv.TMUX;
  delete cleanEnv.TMUX_PANE;

  // Variables every new pane gets on top of the tmux server's own environment.
  // TMUX_SERVER_WINDOW is cleared: a tmux server started inside one of the
  // daemon's windows would otherwise hand that window's id to every pane,
  // where the shell integration should derive it from TMUX_PANE.
  const paneEnvArgs = ["-e", "TMUX_SERVER_WINDOW="];
  for (const name of ["BROWSER", "TMUX_SERVER_PORT"]) {
    if (env[name]) paneEnvArgs.push("-e", `${name}=${env[name]}`);
  }

  const startedAt = Date.now();
  const controls = new Map(); // session name -> ControlClient
  const lastSeen = new Map(); // pane id -> ms, while not viewed; Infinity while viewed
  const listeners = new Set();

  function tmux(args, { input } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(bin, [...socketArgs, ...args], { env: cleanEnv, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr).trim() || err.message));
        else resolve(stdout);
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  const noServer = (err) => /no server running|error connecting to|No such file or directory|no sessions/i.test(err.message);

  let processCache = { at: 0, children: new Map() };
  async function processChildren() {
    if (Date.now() - processCache.at < PROCESS_TTL_MS) return processCache.children;
    const children = new Map();
    try {
      const stdout = await new Promise((resolve, reject) =>
        execFile("ps", ["-axo", "pid=,ppid=,comm="], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
      );
      for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!m) continue;
        const ppid = Number(m[2]);
        const list = children.get(ppid) ?? [];
        list.push({ pid: Number(m[1]), name: m[3].trim().split("/").pop() });
        children.set(ppid, list);
      }
    } catch {
      // No ps: windows just list no child processes.
    }
    processCache = { at: Date.now(), children };
    return children;
  }

  function namesUnder(children, pid) {
    const names = [];
    const queue = [...(children.get(pid) ?? [])];
    while (queue.length) {
      const p = queue.shift();
      names.push(p.name);
      queue.push(...(children.get(p.pid) ?? []));
    }
    return names;
  }

  async function rawListing() {
    try {
      const [sessionsOut, panesOut] = await Promise.all([
        tmux(["list-sessions", "-F", SESSION_FORMAT]),
        tmux(["list-panes", "-a", "-F", PANE_FORMAT]),
      ]);
      return { sessions: parseSessions(sessionsOut), panes: parsePanes(panesOut) };
    } catch (err) {
      if (noServer(err)) return { sessions: [], panes: [] };
      throw err;
    }
  }

  async function listSessions() {
    const [{ sessions, panes }, children] = await Promise.all([rawListing(), processChildren()]);
    const controlClients = new Map([...controls].filter(([, c]) => !c.closed).map(([name]) => [name, 1]));
    return buildSessions(sessions, panes, {
      controlClients,
      lastSeen,
      startedAt,
      childNames: (pid) => namesUnder(children, pid),
    });
  }

  // "sess", "sess:2" or "@tmux-<n>" to a pane id and the session it's in.
  async function resolve(target) {
    const sessions = await listSessions();
    if (target.startsWith("@")) {
      const id = target.slice(1);
      for (const s of sessions) {
        const w = s.windows.find((x) => x.id === id);
        if (w) return { session: s, window: w, paneId: paneIdOf(w.id) };
      }
      throw new Error(`no window with id ${JSON.stringify(id)}`);
    }
    const colon = target.lastIndexOf(":");
    const name = colon === -1 ? target : target.slice(0, colon);
    const s = sessions.find((x) => x.name === name);
    if (!s) throw new Error(`can't find session: ${name}`);
    const index = colon === -1 ? s.currentIndex : Number(target.slice(colon + 1));
    const w = s.windows.find((x) => x.index === index);
    if (!w) throw new Error(`can't find window: ${target}`);
    return { session: s, window: w, paneId: paneIdOf(w.id) };
  }

  async function createSession({ name, cwd, command }) {
    const args = ["new-session", "-d", "-P", "-F", ["#{session_id}", "#{session_name}", "#{pane_id}"].join(SEP), "-x", "80", "-y", "24"];
    if (name) args.push("-s", name);
    if (cwd) args.push("-c", cwd);
    args.push(...paneEnvArgs);
    const [id, created, paneId] = (await tmux(args)).trim().split(SPLIT);
    if (command) await sendText(paneId, `${command}\r`, true);
    emit({ event: "sessions-changed" });
    return { id, name: created, windowId: windowIdOf(paneId) };
  }

  async function createWindow(session, opts = {}) {
    const args = ["new-window", "-P", "-F", ["#{window_index}", "#{pane_id}"].join(SEP), "-t", `=${session}:`];
    if (opts.background) args.push("-d");
    if (opts.name) args.push("-n", opts.name);
    if (opts.cwd) args.push("-c", opts.cwd);
    args.push(...paneEnvArgs);
    const [index, paneId] = (await tmux(args)).trim().split(SPLIT);
    if (opts.command) await sendText(paneId, `${opts.command}\r`, true);
    emit({ event: "sessions-changed" });
    return { index: Number(index), windowId: windowIdOf(paneId) };
  }

  // Typed bytes, through a session's control client when one is up (no
  // process per keystroke), else a one-off command.
  async function sendText(target, data, isPaneId = false) {
    const paneId = isPaneId ? target : (await resolve(target)).paneId;
    const control = [...controls.values()].find((c) => !c.closed && c.panes?.has(paneId));
    for (const chunk of hexChunks(data)) {
      if (control) control.send(`send-keys -H -t ${paneId} ${chunk.join(" ")}`);
      else await tmux(["send-keys", "-H", "-t", paneId, ...chunk]);
    }
  }

  // ---- Viewing ------------------------------------------------------------

  function controlFor(session) {
    let control = controls.get(session);
    if (control && !control.closed) {
      clearTimeout(control.detachTimer);
      return control;
    }
    control = new ControlClient({ socketArgs, env: cleanEnv, onOutput, onNotification, onControlExit }, session);
    control.panes = new Set();
    controls.set(session, control);
    ensurePolling();
    return control;
  }

  function releaseControl(control) {
    if (control.viewers.size > 0 || control.closed) return;
    clearTimeout(control.detachTimer);
    control.detachTimer = setTimeout(() => {
      if (control.viewers.size === 0) control.close();
    }, DETACH_GRACE_MS);
    control.detachTimer.unref?.();
  }

  function onOutput(control, paneId, bytes) {
    for (const viewer of control.viewers) {
      if (viewer.paneId !== paneId) continue;
      // Before the capture: already in it. After it but before the replay is
      // sent: held so it lands after the replay.
      if (viewer.replaying) viewer.held?.push(bytes);
      else viewer.handlers.output(bytes);
    }
    if (bytes.includes(7)) maybeBell(control.session, paneId, bytes);
  }

  function onNotification(control, text) {
    const [kind, ...rest] = text.split(" ");
    switch (kind) {
      case "%layout-change":
        void refreshSizes(control, rest[0]);
        break;
      case "%session-window-changed":
      case "%window-pane-changed":
        void followCurrent(control);
        emit({ event: "sessions-changed" });
        break;
      case "%window-close":
      case "%unlinked-window-close":
      case "%window-add":
      case "%unlinked-window-add":
      case "%window-renamed":
      case "%sessions-changed":
      case "%session-renamed":
        void checkViewers(control);
        emit({ event: "sessions-changed" });
        break;
      default:
        break;
    }
  }

  function onControlExit(control) {
    if (controls.get(control.session) === control) controls.delete(control.session);
    for (const viewer of [...control.viewers]) viewer.close("session-closed");
  }

  // A bell is BEL outside an escape sequence's string terminator. Programs
  // end OSC strings with BEL too; those are skipped.
  function maybeBell(session, paneId, bytes) {
    const text = bytes.toString("latin1");
    const withoutOsc = text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
    if (withoutOsc.includes("\x07")) emit({ event: "bell", session, windowId: windowIdOf(paneId) });
  }

  async function paneState(control, paneId) {
    const [line] = await control.command(`display-message -p -t ${paneId} ${quoteArg(STATE_FORMAT)}`);
    return parseState(line ?? "");
  }

  // Sends one viewer its pane's history and screen, then lets live output
  // through. The state and both captures are one command line, so they
  // describe the same instant; output before their replies is in them, and
  // output after is held until the replay has been sent.
  async function replay(viewer) {
    const { control, paneId } = viewer;
    viewer.replaying = true;
    viewer.held = null;
    try {
      const [stateLines, historyLines, screenLines] = await control.commands(
        [
          `display-message -p -t ${paneId} ${quoteArg(STATE_FORMAT)}`,
          `capture-pane -p -e -J -t ${paneId} -S -${HISTORY_LINES} -E -1`,
          `capture-pane -p -e -J -t ${paneId}`,
        ],
        () => {
          viewer.held = [];
        },
      );
      if (viewer.closed) return;
      const state = parseState(stateLines[0] ?? "");
      viewer.windowId = state.windowId;
      viewer.handlers.output(replayPayload(state, state.historySize > 0 ? historyLines.join("\n") : "", screenLines.join("\n")));
      viewer.size = { cols: state.cols, rows: state.rows };
      viewer.handlers.resized(state.cols, state.rows);
    } finally {
      const held = viewer.held ?? [];
      viewer.held = null;
      viewer.replaying = false;
      if (!viewer.closed) {
        viewer.handlers.replayed();
        for (const bytes of held) viewer.handlers.output(bytes);
      }
    }
  }

  // Window sizes follow the most recently used view, as tmux's own
  // window-size latest does for terminals: attaching, typing, a click or
  // focus, or a real resize makes a viewer the one its window is sized for.
  // Real tmux terminals take part too. The session's control client ignores
  // its own size while a terminal was used last, and claims the window back
  // (ignore-size off, a per-window size) when an app view is used.
  function activeViewer(control, windowId) {
    let best = null;
    for (const v of control.viewers) {
      if (v.closed || v.windowId !== windowId || !v.wanted) continue;
      if (!best || v.lastActiveAt > best.lastActiveAt) best = v;
    }
    return best;
  }

  function applySize(control, windowId) {
    if (control.closed || control.sizing !== "app" || !windowId) return;
    const best = activeViewer(control, windowId);
    if (best) control.send(`refresh-client -C ${windowId}:${best.wanted.cols}x${best.wanted.rows}`);
  }

  function touch(viewer) {
    if (viewer.closed) return;
    const { control } = viewer;
    viewer.lastActiveAt = Date.now();
    control.appActiveAt = viewer.lastActiveAt;
    if (control.sizing !== "app") {
      control.sizing = "app";
      control.send("refresh-client -f !ignore-size");
    }
    applySize(control, viewer.windowId);
  }

  // A real terminal used after the app hands the session back to terminals.
  // client_activity is in seconds, so a terminal has to be used in a later
  // second than the app to count.
  async function checkTerminalActivity() {
    const inApp = [...controls.values()].filter((c) => !c.closed && c.sizing === "app");
    if (inApp.length === 0) return;
    let out;
    try {
      out = await tmux(["list-clients", "-F", ["#{client_control_mode}", "#{client_activity}", "#{session_name}"].join(SEP)]);
    } catch {
      return;
    }
    const latest = new Map();
    for (const line of out.split("\n").filter(Boolean)) {
      const [control, activity, session] = line.split(SPLIT);
      if (control === "1") continue;
      latest.set(session, Math.max(latest.get(session) ?? 0, Number(activity) || 0));
    }
    for (const control of inApp) {
      const used = latest.get(control.session);
      if (used === undefined || used <= Math.floor(control.appActiveAt / 1000)) continue;
      control.sizing = "terminals";
      control.send("refresh-client -f ignore-size");
    }
  }

  async function refreshSizes(control, windowId) {
    for (const viewer of control.viewers) {
      if (viewer.closed || (windowId && viewer.windowId !== windowId)) continue;
      try {
        const state = await paneState(control, viewer.paneId);
        if (viewer.size?.cols === state.cols && viewer.size?.rows === state.rows) continue;
        viewer.size = { cols: state.cols, rows: state.rows };
        viewer.handlers.resized(state.cols, state.rows);
      } catch {
        // The pane went away; checkViewers closes the viewer.
      }
    }
  }

  async function checkViewers(control) {
    let panes;
    try {
      panes = new Set((await control.command("list-panes -s -F '#{pane_id}'")).map((l) => l.trim()));
    } catch {
      return;
    }
    control.panes = panes;
    for (const viewer of [...control.viewers]) {
      if (viewer.pinned && !panes.has(viewer.paneId)) viewer.close("window-closed");
    }
    if (panes.size === 0) for (const viewer of [...control.viewers]) viewer.close("session-closed");
  }

  // A session viewer follows the session's current window, as a tmux client
  // does: a switch is announced, then the new window is replayed.
  async function followCurrent(control) {
    const followers = [...control.viewers].filter((v) => !v.pinned && !v.closed);
    if (followers.length === 0) return;
    let target;
    try {
      target = await resolve(control.session);
    } catch {
      return;
    }
    for (const viewer of followers) {
      if (viewer.paneId === target.paneId || viewer.closed) continue;
      markUnseen(viewer.paneId);
      viewer.paneId = target.paneId;
      control.panes.add(target.paneId);
      viewer.handlers.windowSwitched(target.window.index);
      markSeen(viewer.paneId);
      await replay(viewer);
      applySize(control, viewer.windowId);
    }
  }

  function markSeen(paneId) {
    lastSeen.set(paneId, Infinity);
  }

  function markUnseen(paneId) {
    if (lastSeen.get(paneId) === Infinity) lastSeen.set(paneId, Date.now());
  }

  async function attach(target, opts, handlers) {
    const found = await resolve(target);
    const control = controlFor(found.session.name);
    await control.ready;
    if (control.closed) throw new Error(`tmux session ${found.session.name} is gone`);
    control.panes.add(found.paneId);
    const viewer = {
      control,
      paneId: found.paneId,
      pinned: opts.pinned,
      handlers,
      replaying: true,
      closed: false,
      windowId: null,
      size: null,
      wanted: { cols: opts.cols, rows: opts.rows },
      lastActiveAt: 0,
      close(reason) {
        if (viewer.closed) return;
        viewer.closed = true;
        control.viewers.delete(viewer);
        markUnseen(viewer.paneId);
        // The window falls back to the most recently used viewer left.
        applySize(control, viewer.windowId);
        releaseControl(control);
        if (reason) handlers.closed(reason);
      },
    };
    control.viewers.add(viewer);
    markSeen(viewer.paneId);
    try {
      await replay(viewer);
    } catch (err) {
      viewer.close();
      throw err;
    }
    touch(viewer); // a fresh attach is the view in use
    return {
      write: (data) => {
        if (viewer.closed) return;
        for (const chunk of hexChunks(data)) control.send(`send-keys -H -t ${viewer.paneId} ${chunk.join(" ")}`);
        touch(viewer);
      },
      resize: (cols, rows) => {
        // Only a real change is the view being used; the same size again is
        // the browser re-measuring.
        const changed = viewer.wanted?.cols !== cols || viewer.wanted?.rows !== rows;
        viewer.wanted = { cols, rows };
        if (changed) touch(viewer);
      },
      activate: () => {
        markSeen(viewer.paneId);
        touch(viewer);
      },
      close: () => viewer.close(),
    };
  }

  // ---- Events -------------------------------------------------------------

  function emit(event) {
    for (const l of listeners) l(event);
  }

  // Changes made outside the app (a `tmux new` in some terminal) have no
  // control client to announce them, so the listing is also polled while
  // anyone is listening.
  let pollTimer = null;
  let lastShape = "";

  // The poll runs while anyone listens for events or any session is viewed
  // (terminal activity is only noticed by polling).
  function ensurePolling() {
    if (pollTimer) return;
    void poll();
    pollTimer = setInterval(() => {
      void poll();
      stopPollingIfIdle();
    }, POLL_MS);
    pollTimer.unref?.();
  }

  function stopPollingIfIdle() {
    if (!pollTimer || listeners.size > 0 || [...controls.values()].some((c) => !c.closed)) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const bells = new Set();
  async function poll() {
    void checkTerminalActivity();
    if (listeners.size === 0) return;
    let listing;
    try {
      listing = await rawListing();
    } catch {
      return;
    }
    const shape = JSON.stringify([
      listing.sessions.map((s) => [s.id, s.name]),
      listing.panes.map((p) => [p.sessionId, p.paneId, p.windowIndex, p.windowName, p.windowActive, p.paneActive]),
    ]);
    if (lastShape && shape !== lastShape) emit({ event: "sessions-changed" });
    lastShape = shape;
    const names = new Map(listing.sessions.map((s) => [s.id, s.name]));
    const ringing = new Set();
    for (const p of listing.panes) {
      if (!p.bell) continue;
      ringing.add(p.windowId);
      // Viewed panes report their bells from output instead.
      const viewed = [...controls.values()].some((c) => [...c.viewers].some((v) => v.paneId === p.paneId));
      if (!bells.has(p.windowId) && !viewed) emit({ event: "bell", session: names.get(p.sessionId) ?? "", windowId: windowIdOf(p.paneId) });
    }
    bells.clear();
    for (const id of ringing) bells.add(id);
  }

  const engine = {
    listSessions,
    createSession,
    killSession: async (session) => {
      await tmux(["kill-session", "-t", `=${session}`]);
      emit({ event: "sessions-changed" });
    },
    renameSession: async (session, to) => {
      await tmux(["rename-session", "-t", `=${session}`, to]);
      emit({ event: "sessions-changed" });
    },
    createWindow,
    selectWindow: async (target) => {
      const { paneId } = await resolve(target);
      await tmux(["select-window", "-t", paneId]);
      await tmux(["select-pane", "-t", paneId]);
    },
    killWindow: async (target) => {
      const { paneId } = await resolve(target);
      await tmux(["kill-pane", "-t", paneId]);
      emit({ event: "sessions-changed" });
    },
    renameWindow: async (target, to) => {
      const { paneId } = await resolve(target);
      await tmux(["rename-window", "-t", paneId, to]);
      emit({ event: "sessions-changed" });
    },
    resetWindowName: async (target) => {
      const { paneId } = await resolve(target);
      await tmux(["set-option", "-w", "-t", paneId, "automatic-rename", "on"]);
      emit({ event: "sessions-changed" });
    },
    clearRestored: async () => {},
    sendText: (target, data) => sendText(target, data),
    attach,
    onEvent: (listener) => {
      listeners.add(listener);
      ensurePolling();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) lastShape = "";
        stopPollingIfIdle();
      };
    },
    running: async () => {
      try {
        await tmux(["list-sessions", "-F", "#{session_id}"]);
        return true;
      } catch {
        return false;
      }
    },
    // Shell and restore are tmux's own configuration (default-shell,
    // tmux-resurrect); the app doesn't override them.
    configure: async () => {},
    // For tests and shutdown: detach every control client now.
    dispose: () => {
      for (const control of [...controls.values()]) control.close();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      listeners.clear();
    },
  };
  log(`tmux engine ready${socketName ? ` (socket ${socketName})` : ""}`);
  return engine;
}
