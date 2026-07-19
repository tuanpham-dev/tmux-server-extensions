# Full Keyboard

A full on-screen **QWERTY keyboard** for mobile, for typing in a terminal from a phone or tablet. First-party (tmux-server), MIT-licensed.

## Contributes

- **Terminal accessory:** a docked or floating on-screen keyboard, shown for a focused terminal on mobile.
- **Settings component:** a drag-and-drop editor for the special-key top bar.

## What it does

- **QWERTY grid** with a number row, sticky one-shot **Shift / Ctrl / Alt**, two **symbol pages** (`!#1` ⇄ `1/2`/`2/2`), and **Backspace / arrow-key hold-to-repeat**. Every printable ASCII character is reachable.
- A **customizable special-key top bar** above the grid (Esc, Tab, arrows, Ctrl+C, voice input, image upload by default) — the same model as the Touch Keys bar, editable in settings.
- **Fixed** mode (docked below the terminal, which shrinks above it) or **Floating** mode (a draggable ⌨ toggle you tap to show the keyboard as an overlay that leaves the terminal full-size; the panel opens above or below the toggle depending on where you drag it).
- Optionally **hides the device's native keyboard** while shown (never / while showing / always — configurable), so the two don't stack.

## Settings

- `fullKeyboard.show` — when the keyboard shows (auto = mobile only / always / never).
- `fullKeyboard.style` — fixed (docked) or floating (movable toggle).
- `fullKeyboard.suppressSoftKeyboard` — when to hide the OS keyboard (never / whenShown / always).
- `fullKeyboard.topKeys` — the top-bar layout (edited with the drag-and-drop editor in settings).

## Install

```sh
npm run pack
```

Then, in tmux-server's Extensions sidebar tab:
- **Registry (recommended):** click the gear icon, add this repo's `dist/` folder as a source, and click Install on Full Keyboard.
- **Manual:** click "Install from .tsix" and pick `dist/full-keyboard-<version>.tsix`.
