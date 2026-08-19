# Agent Monitor

Classifies every tmux pane running an AI coding agent as working / waiting / done, and
shows it as a colored status dot on that window's own row in the PROJECTS pane (working
= green, waiting = amber, permission-blocked = orange; `done` gets no dot — it's the
steady idle state most agent panes sit in, and a permanent dot there would be noise,
not signal). "Which of my agents needs me?" at a glance, without opening every tab —
built assuming one window per tab, so a window's dot always reflects a single pane.

## How it works

A server-side poll classifies every pane whose foreground command matches
`agentMonitor.programs` (default: `claude`), in priority order:

1. **An opt-in Claude Code hooks event** (see below) for that pane's resolved Claude
   session, when it's fresher than the session's last transcript write — the
   high-fidelity signal: a `Notification` hook means waiting on a permission prompt,
   a `Stop` hook means done.
2. **The pane's tmux title.** Claude Code sets an OSC title of `<glyph> <task>` — a
   rotating quarter-circle glyph (◐◑◓◒) while working, a fixed `✳` once idle. An
   unrecognized title shape (a non-Claude agent, or a format this hasn't seen) is
   treated as no signal, never guessed as a state.
3. **Transcript recency**, for whichever cwd/session Claude Code itself last wrote to
   — written within `agentMonitor.waitingThresholdSeconds` means working, otherwise
   waiting. No transcript at all (a non-Claude agent with no title match either) means
   waiting.

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
