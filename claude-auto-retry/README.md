# Claude Usage & Auto-Retry

Detects a "usage limit reached" banner in any tmux pane running `claude`, then either sends `continue` automatically once the limit resets — with an on-screen Abort — or asks you first. No CLI changes required; it watches the pane the same way you would. Also adds a **CLAUDE USAGE** panel (Run tab) showing token burn for the current 5-hour block and recent previous ones.

## Claude Usage panel

Scans every Claude Code transcript under `~/.claude/projects/` — including subagent
sidecars, whose token usage never appears in their parent session's own entries
(verified against real transcripts: a subagent's work is additional usage, not
already counted) — and aggregates them into ccusage-style floating 5-hour blocks.
Shows the current block's total (with a per-model breakdown and a rough tokens/min
burn rate) plus up to 5 previous blocks. When `~/.claude/rate-limit-state.json` (see
below) has a real reset epoch, the current block's displayed end uses that instead of
the block's own computed window, and a weekly-reset line appears too. Everything here
is estimated from local files — Claude Code writes no official rate-limit data to
disk — labeled as such in the panel.

## How it works

A server-side poll (every 10s) scans every `claude` pane's recent output for a limit banner. When one is found, the exact reset time comes from `~/.claude/rate-limit-state.json` if present (written by a `statusline.sh` hook that reports `rate_limits` — see below); otherwise it's parsed straight out of the banner text itself (`resets 3pm`, `resets Oct 15`, `resets in 2h 30m`, optionally with a `(Region/City)` timezone).

Depending on the `claudeAutoRetry.mode` setting:

- **Auto-continue after reset** (default) — schedules the message for reset time + offset and shows a toast with an **Abort** button.
- **Ask me first** — shows a toast with a **Yes** button; nothing is sent until you click it.
- **Off** — the background pane scan itself stops; no detection, no toasts.

Right before actually sending, the extension re-checks the pane: if the banner has already scrolled away (the session resumed some other way — for example a cron job you've set up yourself), it skips the send instead of typing a redundant `continue`. Aborting an event also suppresses that exact banner for 5 minutes, so a banner that stays on screen doesn't immediately re-trigger a fresh toast.

## Matched banner patterns

Grounded in strings from the installed `claude` CLI: `5-hour session limit reached`, `Weekly limit reached`, `Opus limit reached`, `Sonnet limit reached`, `Fable 5 limit reached`, plus the older generic `usage limit reached` phrasing — each followed by `resets <time>` or `resets in <duration>`. A line containing `Approaching` (the still-working warning, not a stop) is ignored, as are the CLI's other unrelated `limit reached` strings (`Context limit reached`, `Budget limit reached ($…)`, `Concurrent subagent limit reached`, `spend limit reached`, `Fast limit reached`).

Wording can change across Claude Code releases — if detection stops working after an update, that's the first thing to check.

## Settings

| Key | Default | Description |
|---|---|---|
| `claudeAutoRetry.mode` | `auto` | `auto` \| `manual` \| `off` |
| `claudeAutoRetry.offsetMinutes` | `1` | Minutes to wait after the reset before sending |
| `claudeAutoRetry.message` | `continue` | Text sent to the pane |

**Off vs. disable**: turning the extension off in Settings → Extensions still leaves its server process resident (extension server hooks can't be told to stop their own timers on disable); use the `claudeAutoRetry.mode: off` setting instead if you want the background scan itself to stop without disabling the extension.

## `~/.claude/rate-limit-state.json` (optional, but recommended)

Not written by Claude Code itself — it's produced by a user-authored `statusline.sh` hook that persists the `rate_limits` object Claude Code feeds every statusline render:

```json
{"five_hour_pct": 42, "resets_at": 1786914000, "seven_day_pct": 4, "seven_day_resets_at": 1787500800, "updated_at": 1786905101}
```

When present and its reset epoch is still in the future, this is used instead of parsing the banner's own time text — no wall-clock or timezone guessing needed. Machines without that hook fall back to banner-text parsing automatically; nothing else changes.
