# One-Hand Operation

A transparent **swipe bar** across the bottom of the editor — on *every* tab (terminal, Settings, viewers) — for driving tmux-server one-handed from a phone or tablet. First-party (tmux-server), MIT-licensed.

## Contributes

- **App overlay:** a transparent, thumb-reachable strip pinned to the bottom edge of the editor area, on top of whatever tab is active.
- **Settings component:** a picker for which command each swipe direction runs.

## What it does

Swipe over the bottom strip to run a command, one-handed:

- **Swipe left** → Next Tab (default)
- **Swipe right** → Previous Tab (default)
- **Swipe up** → Toggle Quick Switcher (default)

Each direction is remappable to **any runnable command** in the settings picker below, or set to *None* to disable it. A swipe must travel ~48px to register (shorter movements are treated as taps and ignored). The strip is transparent and only captures gestures within a thin band at the very bottom, so the rest of each tab stays fully interactive.

## Settings

- `oneHand.show` — when the swipe bar is active (auto = mobile only / always / never).
- `oneHand.actions` — which command each swipe direction runs (edited with the picker in settings).

## Requirements

Needs a tmux-server build that provides the `registerAppOverlay` extension point and the `app.executeCommand` / `app.getCommands` context APIs.

## Install

```sh
npm run pack
```

Then, in tmux-server's Extensions sidebar tab:
- **Registry (recommended):** click the gear icon, add this repo's `dist/` folder as a source, and click Install on One-Hand Operation.
- **Manual:** click "Install from .tsix" and pick `dist/one-hand-<version>.tsix`.
