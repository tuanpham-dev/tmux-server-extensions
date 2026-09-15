# tmux Terminal Backend

Runs tmux-server's terminals in [tmux](https://github.com/tmux/tmux) instead of the bundled terminal daemon. Sessions you start with `tmux new` in any terminal show up in the app, and sessions started in the app are ordinary tmux sessions you can `tmux attach` to.

After installing, choose **tmux** under **Settings -> Terminal -> Backend** and restart the server. Uninstalling it (or tmux not being installed) puts the server back on the bundled daemon.

How the app's model maps onto tmux:

- A session is a tmux session. Each tmux **pane** is one app window, so a split tmux window shows up as one tab per pane (named `window·pane`).
- Terminal output streams through tmux's control mode (`tmux -C`), one connection per session you are viewing. Opening a tab replays the pane's history, colors and cursor.
- Window sizes follow the view used most recently, like tmux's own `window-size latest`: attaching, typing, clicking or focusing an app tab claims the window, and a real tmux terminal used after that takes it back.
- Your `~/.tmux.conf` applies as usual. The shell, key bindings and what survives a reboot (for example tmux-resurrect) come from tmux, so the app's Terminal Daemon settings don't apply.

Requires tmux 3.2 or newer (tested with 3.5a). `TMUX_SERVER_TMUX_SOCKET` in the server's environment names a separate tmux socket (`tmux -L`), which is how tests and test instances avoid touching your own tmux.
