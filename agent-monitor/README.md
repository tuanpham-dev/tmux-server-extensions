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

A server-side poll classifies every pane whose foreground command matches
`agentMonitor.programs` (default: `claude`), in priority order:

1. **An opt-in Claude Code hooks event** (see below) for that pane's resolved Claude
   session, when it's fresher than the session's last transcript write — the
   high-fidelity signal. `Notification` means waiting on a permission prompt and
   `Stop` means done (neither is observable any other way: a permission prompt writes
   nothing to the transcript, and "your turn" is otherwise inferred from silence);
   `UserPromptSubmit` and `PreToolUse` mean working, which turns the other half of
   the guess into a fact — the pane is working the moment a prompt is sent or a tool
   starts, not once the transcript happens to be flushed.
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
   hooks snippet above removes the need to guess about.

Nothing is ever typed into a pane — every signal here is read-only.

## Settings

| Key | Default | Description |
|---|---|---|
| `agentMonitor.programs` | `claude` | Comma-separated foreground commands to treat as agents |
| `agentMonitor.waitingThresholdSeconds` | `15` | How long a transcript can go unwritten before falling back to "waiting" |

## Claude Code hooks (optional, but recommended)

Settings → Agent Monitor shows the exact JSON to merge into `~/.claude/settings.json`'s
`hooks` section — two hooks (`Notification`, `Stop`) that curl a status update to this
extension's own route on every relevant event. It's opt-in and read-only from the
extension's side: it never edits your settings file, and events are keyed by Claude's
own `session_id`, so two agent panes sharing one folder can't cross-contaminate each
other's state.
