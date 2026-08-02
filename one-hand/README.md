# One-Hand Operation

A transparent **gesture bar** across the bottom of the editor — on *every* tab (terminal, Settings, viewers) — for driving tmux-server one-handed from a phone or tablet. First-party (tmux-server), MIT-licensed.

## Contributes

- **App overlay:** a transparent, thumb-reachable strip pinned to the bottom edge of the editor area, on top of whatever tab is active.
- **Settings component:** a picker for which command each gesture runs.

## What it does

Use the bottom strip to run a command, one-handed — five gestures, each remappable:

| Gesture | Default |
|---|---|
| **Swipe left** | Next Tab |
| **Swipe right** | Previous Tab |
| **Swipe up** | Toggle Quick Switcher |
| **Double tap** | *unbound* |
| **Long press** | *unbound* |

Every gesture is remappable to **any runnable command** in the settings picker below, or set to *None* to disable it.

The two tap gestures ship **unbound** so that installing an update never changes what your thumb already does — pick commands for them in Settings to switch them on. A long press fires after **500ms** of holding still (a short vibration confirms it, where the device supports one); a double tap is two taps within **300ms**. A **single tap does nothing at all**, deliberately: the strip sits over the terminal, where a stray tap has to stay harmless. A swipe must travel ~48px to register, and drifting that far mid-hold cancels the long press rather than firing both.

The strip is transparent and only captures gestures within a thin band at the very bottom, so the rest of each tab stays fully interactive.

## Settings

- `oneHand.show` — when the gesture bar is active (auto = mobile only / always / never).
- `oneHand.actions` — which command each gesture runs (edited with the picker in settings). A map saved before the tap gestures existed keeps working; the two new slots simply read as unbound.

## Requirements

Needs a tmux-server build that provides the `registerAppOverlay` extension point and the `app.executeCommand` / `app.getCommands` context APIs.

## Install

```sh
npm run pack
```

Then, in tmux-server's Extensions sidebar tab:
- **Registry (recommended):** click the gear icon, add this repo's `dist/` folder as a source, and click Install on One-Hand Operation.
- **Manual:** click "Install from .tsix" and pick `dist/one-hand-<version>.tsix`.
