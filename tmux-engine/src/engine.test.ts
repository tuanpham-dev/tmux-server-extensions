// The tmux backend against a real tmux server of its own (a private socket,
// no user config), plus the pure pieces: output decoding, the listing's
// pane-to-window mapping and the replay payload.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildSessions, createTmuxEngine, decodeOutput, hexChunks, paneIdOf, replayPayload, windowIdOf } from "../engine.js";

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test("control-mode output decodes octal escapes and passes other bytes", () => {
  const raw = Buffer.from("a\\033[1mb\\134c\\015\\012é");
  assert.deepEqual(decodeOutput(raw), Buffer.from("a\x1b[1mb\\c\r\né"));
  assert.deepEqual(decodeOutput(Buffer.from("\\01")), Buffer.from("\\01"), "a short escape is left alone");
});

test("input becomes hex key codes in bounded chunks", () => {
  assert.deepEqual(hexChunks("é\x1b"), [["c3", "a9", "1b"]]);
  const chunks = hexChunks("x".repeat(1200));
  assert.deepEqual(chunks.map((c) => c.length), [512, 512, 176]);
});

test("window ids round-trip to pane ids", () => {
  assert.equal(windowIdOf("%12"), "tmux-12");
  assert.equal(paneIdOf("tmux-12"), "%12");
  assert.equal(paneIdOf("0b5e-uuid"), null);
});

test("a split tmux window lists one app window per pane", () => {
  const pane = (over) => ({
    sessionId: "$1", windowId: "@1", windowIndex: 0, windowName: "zsh", autoName: true, windowActive: true,
    windowActivity: 5000, bell: false, paneId: "%1", paneIndex: 0, paneActive: false, cwd: "/w", command: "zsh", pid: 10, ...over,
  });
  const [s] = buildSessions(
    [{ id: "$1", name: "work", createdAt: 1000, attached: 2, rootCwd: "/w" }],
    [
      pane({}),
      pane({ paneId: "%4", paneIndex: 1, paneActive: true, command: "vim", windowActivity: 9000 }),
      pane({ windowId: "@2", windowIndex: 1, windowName: "logs", autoName: false, windowActive: false, paneId: "%2" }),
    ],
    { controlClients: new Map([["work", 1]]), lastSeen: new Map([["%1", Infinity], ["%4", 6000]]), startedAt: 0 },
  );
  assert.equal(s.attached, 1, "our own control client is not a viewer");
  assert.deepEqual(
    s.windows.map((w) => [w.index, w.id, w.name, w.autoName, w.current, w.activity]),
    [
      [0, "tmux-1", "zsh", true, false, false],
      [1, "tmux-2", "logs", false, false, true],
      [10004, "tmux-4", "zsh·1", true, true, true],
    ],
  );
  assert.equal(s.currentIndex, 10004);
});

test("the replay clears, draws history then screen, and restores cursor and modes", () => {
  const state = { cursorX: 2, cursorY: 1, alternate: true, keypadCursor: true, mouseSgr: true, cursorVisible: false };
  const text = replayPayload(state, "old\n", "top\nbottom\n").toString();
  assert.ok(text.startsWith("\x1b[0m\x1b[?1049l"));
  assert.ok(text.includes("old\x1b[0m\r\n\x1b[?1049h\x1b[Htop\x1b[0m\r\nbottom\x1b[0m\x1b[2;3H"));
  assert.ok(text.endsWith("\x1b[?1h\x1b[?1006h\x1b[?25l"));
});

// ---- Against tmux ---------------------------------------------------------

let dir;
let engine;
let socketName;
const tmux = (...args) =>
  execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...args], { env: { ...process.env, TMUX: "" } }).toString();

before(() => {
  if (!hasTmux) return;
  dir = mkdtempSync(path.join(tmpdir(), "tmux-engine-"));
  socketName = `tmux-engine-test-${process.pid}`;
  engine = createTmuxEngine({
    socketName,
    configFile: "/dev/null",
    env: { PATH: process.env.PATH, HOME: dir, SHELL: "/bin/sh", ENV: "", PS1: "$ ", TERM: "xterm-256color", BROWSER: "/x/open", TMUX_SERVER_PORT: "4321" },
  });
});

after(() => {
  if (!hasTmux) return;
  engine.dispose();
  try {
    tmux("kill-server");
  } catch {
    // Already gone.
  }
  rmSync(dir, { recursive: true, force: true });
});

test("sessions and windows made in the app are tmux's, and changes show up both ways", { skip: !hasTmux }, async () => {
  assert.deepEqual(await engine.listSessions(), [], "no tmux server yet is an empty listing");
  const created = await engine.createSession({ name: "work", cwd: dir });
  assert.equal(created.name, "work");
  assert.match(tmux("list-sessions", "-F", "#{session_name}"), /^work$/m);

  const events = [];
  const off = engine.onEvent((e) => events.push(e.event));
  const win = await engine.createWindow("work", { cwd: dir, name: "logs" });
  let [s] = await engine.listSessions();
  assert.deepEqual(s.windows.map((w) => w.name), [s.windows[0].name, "logs"]);
  assert.equal(s.windows.find((w) => w.id === win.windowId)?.autoName, false, "a named window keeps its name");

  // Made outside the app: a split pane and a whole session.
  tmux("split-window", "-t", "=work:0", "-c", dir);
  tmux("new-session", "-d", "-s", "outside", "-c", dir);
  await waitFor("the poll to notice", () => events.includes("sessions-changed"));
  const sessions = await engine.listSessions();
  assert.deepEqual(sessions.map((x) => x.name).sort(), ["outside", "work"]);
  s = sessions.find((x) => x.name === "work");
  assert.equal(s.windows.length, 3);
  assert.ok(s.windows.some((w) => w.index >= 10000 && w.name.endsWith("·1")), "the split pane is its own window");

  await engine.renameWindow(`@${win.windowId}`, "renamed");
  await engine.resetWindowName(`@${win.windowId}`);
  [s] = (await engine.listSessions()).filter((x) => x.name === "work");
  assert.equal(s.windows.find((w) => w.id === win.windowId)?.autoName, true);

  await engine.renameSession("outside", "gone");
  await engine.killSession("gone");
  assert.deepEqual((await engine.listSessions()).map((x) => x.name), ["work"]);
  off();
});

test("an attached viewer gets history, then live output, and its typing reaches the shell", { skip: !hasTmux }, async () => {
  const { windowId } = await engine.createSession({ name: "view", cwd: dir });
  await engine.sendText(`@${windowId}`, "for i in 1 2 3; do echo line-$i; done\r");
  await waitFor("the loop to print", () => tmux("capture-pane", "-p", "-t", paneIdOf(windowId)).includes("line-3"));

  const chunks = [];
  let replayedAt = -1;
  const sizes = [];
  const handle = await engine.attach(`@${windowId}`, { pinned: true, cols: 70, rows: 20 }, {
    output: (b) => chunks.push(b.toString()),
    replayed: () => (replayedAt = chunks.length),
    windowSwitched: () => {},
    resized: (c, r) => sizes.push(`${c}x${r}`),
    closed: () => {},
  });
  assert.equal(replayedAt, 1, "the replay is one payload, before replayed");
  assert.ok(chunks[0].includes("line-1") && chunks[0].includes("line-3"), "history is in the replay");

  handle.write("echo typed-$((6*7))\r");
  await waitFor("live output", () => chunks.slice(1).join("").includes("typed-42"));

  await waitFor("the viewer's size", () => tmux("display", "-p", "-t", paneIdOf(windowId), "#{window_width}x#{window_height}").trim() === "70x20");
  handle.resize(90, 25);
  await waitFor("a resize to reach tmux and come back", () => sizes.includes("90x25"));

  const [s] = (await engine.listSessions()).filter((x) => x.name === "view");
  assert.equal(s.attached, 0, "the app's own control client is not counted");

  let closed = null;
  const second = await engine.createWindow("view", { cwd: dir });
  const pinned = await engine.attach(`@${second.windowId}`, { pinned: true, cols: 80, rows: 24 }, {
    output: () => {},
    replayed: () => {},
    windowSwitched: () => {},
    resized: () => {},
    closed: (reason) => (closed = reason),
  });
  await engine.killWindow(`@${second.windowId}`);
  await waitFor("the pinned viewer to close", () => closed === "window-closed");
  pinned.close();
  handle.close();
});

test("a session viewer follows the session's current window", { skip: !hasTmux }, async () => {
  const { windowId } = await engine.createSession({ name: "follow", cwd: dir });
  const other = await engine.createWindow("follow", { cwd: dir, background: true });
  await engine.sendText(`@${other.windowId}`, "echo in-the-other-one\r");
  const switched = [];
  const chunks = [];
  const handle = await engine.attach("follow", { pinned: false, cols: 80, rows: 24 }, {
    output: (b) => chunks.push(b.toString()),
    replayed: () => {},
    windowSwitched: (index) => switched.push(index),
    resized: () => {},
    closed: () => {},
  });
  assert.ok(windowId);
  await engine.selectWindow(`follow:${other.index}`);
  await waitFor("the switch", () => switched.includes(other.index));
  await waitFor("the other window's replay", () => chunks.join("").includes("in-the-other-one"));
  handle.close();
});

test("a bell in a viewed window is reported for that window", { skip: !hasTmux }, async () => {
  const { windowId } = await engine.createSession({ name: "bell", cwd: dir });
  const bells = [];
  const off = engine.onEvent((e) => e.event === "bell" && bells.push(e));
  const handle = await engine.attach(`@${windowId}`, { pinned: true, cols: 80, rows: 24 }, {
    output: () => {},
    replayed: () => {},
    windowSwitched: () => {},
    resized: () => {},
    closed: () => {},
  });
  await engine.sendText(`@${windowId}`, "printf '\\033]0;title\\007'; printf '\\007'\r");
  await waitFor("the bell", () => bells.length > 0);
  assert.deepEqual(bells[0], { event: "bell", session: "bell", windowId });
  handle.close();
  off();
});

const noHandlers = { output: () => {}, replayed: () => {}, windowSwitched: () => {}, resized: () => {}, closed: () => {} };
const windowSize = (windowId) => tmux("display", "-p", "-t", paneIdOf(windowId), "#{window_width}x#{window_height}").trim();

test("a window is sized for the viewer used last, not the smallest", { skip: !hasTmux }, async () => {
  const { windowId } = await engine.createSession({ name: "latest", cwd: dir });
  const big = await engine.attach(`@${windowId}`, { pinned: true, cols: 100, rows: 30 }, noHandlers);
  await waitFor("the first viewer's size", () => windowSize(windowId) === "100x30");
  const small = await engine.attach(`@${windowId}`, { pinned: true, cols: 60, rows: 20 }, noHandlers);
  await waitFor("a new attach to take the window", () => windowSize(windowId) === "60x20");

  big.activate();
  await waitFor("activating the big view to take it back", () => windowSize(windowId) === "100x30");

  // The small view re-measures without changing size: not a use of it.
  small.resize(60, 20);
  small.resize(60, 20);
  await sleep(300);
  assert.equal(windowSize(windowId), "100x30", "an unchanged resize does not claim the window");

  small.write(" ");
  await waitFor("typing to claim it", () => windowSize(windowId) === "60x20");
  big.resize(110, 32);
  await waitFor("a real resize to claim it", () => windowSize(windowId) === "110x32");

  big.close();
  await waitFor("the window to fall back to the viewer left", () => windowSize(windowId) === "60x20");
  small.close();
});

// A real tmux terminal, as script(1) gives one a pty: sized with stty, typed
// into through its stdin.
function realTerminal(session, cols, rows) {
  // SHELL is pinned because script runs the command through it, and zsh would
  // expand the "=session" target as a command lookup.
  return spawn("script", ["-q", "-c", `stty cols ${cols} rows ${rows}; exec tmux -L ${socketName} -f /dev/null attach -t '=${session}'`, "/dev/null"], {
    env: { ...process.env, SHELL: "/bin/sh", TMUX: "", TERM: "xterm-256color" },
    stdio: ["pipe", "ignore", "ignore"],
  });
}

const hasScript = (() => {
  try {
    execFileSync("script", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("a real tmux terminal used after the app takes the window, and the app can take it back", { skip: !hasTmux || !hasScript }, async () => {
  const { windowId } = await engine.createSession({ name: "mixed", cwd: dir });
  const view = await engine.attach(`@${windowId}`, { pinned: true, cols: 70, rows: 20 }, noHandlers);
  await waitFor("the app view's size", () => windowSize(windowId) === "70x20");

  const term = realTerminal("mixed", 150, 46);
  try {
    // tmux records activity in whole seconds; use the terminal in a later one.
    await sleep(1100);
    term.stdin.write(" ");
    await waitFor("the terminal to take the window", () => /^150x4[56]$/.test(windowSize(windowId)), 8000);

    view.activate();
    await waitFor("the app view to take it back", () => windowSize(windowId) === "70x20", 8000);
  } finally {
    term.kill();
    view.close();
  }
});
