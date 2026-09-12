# Agent Monitor

Classifies every tmux pane running an AI coding agent as working / waiting / done, and
marks that window's own row in the PROJECTS pane:

| State | Mark | Color |
| --- | --- | --- |
| working | a dot, slowly pulsing | the theme's active green (`--status-active-bg`) |
| waiting | a dot | the theme's warning amber (`--warning`) |
| waiting, on a permission prompt | **`?`** | the same amber |
| done | nothing | — |

The state that is blocking *you* differs in shape, not in a third shade of dot: a `?`
reads before its color does, and can't be mistaken for the working dot at a glance.
Working pulses because a static dot says "this pane is an agent" while a moving one
says "it's still going". `done` gets no mark at all — it's the steady idle state most
agent panes sit in, and a permanent dot there would be noise, not signal. Colors are
theme tokens (with the old fixed hexes as fallbacks), so they follow the theme like
every other indicator in that tree.

"Which of my agents needs me?" at a glance, without opening every tab — built assuming
one window per tab, so a window's mark always reflects a single pane.

## How it works

A server-side poll classifies every pane whose foreground command matches one of the
agents in **Settings → Agents** (the app's own list, shared by every extension that
needs to know what an agent is), in priority order:

1. **An agent hook event** (see below) for that pane, when it's fresher than the
   pane's last transcript write — the high-fidelity signal. A permission prompt means
   waiting and a turn ending means done (neither is observable any other way: a
   permission prompt writes nothing to the transcript, and "your turn" is otherwise
   inferred from silence); a turn starting, or a tool call starting, means working,
   which turns the other half of the guess into a fact — the pane is working the
   moment the turn begins, not once the transcript happens to be flushed. Events are
   keyed by the tmux pane they fired in, so two agent panes sharing one folder can't
   cross-contaminate each other's state, and an agent that sends no session id of its
   own is served exactly as well as Claude Code.
2. **The pane's tmux title.** Claude Code sets an OSC title of `<glyph> <task>`. A
   rotating quarter-circle glyph (◐◑◓◒) means working. `✳` does **not** mean idle —
   it's Claude's own mark, present while it works as well — so it yields the task
   label only and the state falls through. Any other title shape is no signal, never
   guessed as a state.
3. **Transcript recency**, for whichever cwd/session Claude Code itself last wrote to
   — written within `agentMonitor.waitingThresholdSeconds` (default 45) means working,
   otherwise waiting. No transcript at all (a non-Claude agent with no title match
   either) means waiting. The mtime is read fresh on every poll; only the choice of
   *which* file to watch is cached, since a stale mtime here is a wrong state, not a
   slightly old one. The threshold is a timeout standing in for knowledge: one tool
   call routinely runs longer than a few seconds writing nothing, which is what the
   hooks above remove the need to guess about.

Nothing is ever typed into a pane — every signal here is read-only.

## Settings

| Key | Default | Description |
|---|---|---|
| `agentMonitor.programs` | *(empty)* | **Deprecated.** Settings → Agents holds the agent list now. A value here still overrides it for this version; clear it to follow Settings → Agents. |
| `agentMonitor.waitingThresholdSeconds` | `45` | How long a transcript can go unwritten before falling back to "waiting" |

## Agent hooks (optional, but recommended)

**This version moves hooks into the app itself.** They are no longer this extension's
business: **Settings → Agents** generates the snippet for each agent's own config file,
copies it for you to paste, or installs it on a press - with a timestamped backup
first, touching only its own entries, and never a hook you wrote by hand. It also says
when the installed hooks need reinstalling, and which extensions asked for what.

If you pasted this extension's old snippet into `~/.claude/settings.json`, **remove
it**: the route it curls is gone in this version, so it now does nothing. Settings →
Agents flags an old snippet it finds in that file, but it will not touch it - deleting
a hook you wrote is not the app's call.

What you get once the app's hooks are installed, beyond what this extension could do
before:

- **Any agent's hooks can reach it now, not just Claude Code's.** The old hook keyed on
  Claude's own `session_id`, which only Claude Code sends, so nothing else could ever
  report a state; the app's pipeline keys on the tmux pane, which every agent's hook
  can supply. Codex's own hook schema is confirmed against the installed binary, but
  whether its events actually *fire* has not been verified yet (the account used for
  testing was at its usage limit) - treat a Codex pane's hook states as unproven until
  you see one.
- **Antigravity panes get working and done**, from its turn-start and turn-end events.
  Not waiting-on-permission: Antigravity CLI 1.2.1 has no permission event at all
  (verified by firing hooks, not by reading its docs), so a permission prompt in an
  agy pane is invisible to any tool, this one included.
- **One hook per event, not one per extension**, and no auth hole: the app's endpoint
  is loopback-only with its own header check, where this extension's old route relied
  on a request with no `Origin` passing the gate.

Per-tool-call events (`tool call start`) are behind a toggle in Settings → Agents that
is off by default - they fire once per tool call. With it off, this extension falls
back to transcript timing for "working", exactly as it does when no hooks are
installed at all.
