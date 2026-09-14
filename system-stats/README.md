# System Stats

Shows how much memory the host is using in tmux-server's status bar (`6.1 / 23.4 GB`). Click the reading for a popover with:

- **CPU** - a line chart of usage over the last 2 minutes, with core count, load average and CPU model
- **Memory** and **Swap** (swap only when the host has any)
- **Disk** usage for `/`, and for your home directory when it is a separate filesystem
- **Network** throughput, excluding loopback
- Hostname, kernel, uptime and process count

The CPU chart starts recording when the popover opens and is cleared when it closes. The popover asks the server for the full reading (which checks each filesystem) only while it is open. The status bar reading itself is a light poll every 3 seconds, paused while the browser tab is hidden.

Memory "in use" is `MemTotal - MemAvailable` from `/proc/meminfo`, so page cache doesn't count as used. Off Linux, the numbers fall back to Node's `os` module, and the network row is dropped.

This replaces the memory reading that used to be built into tmux-server's status bar. Like any status bar item, it can be dragged to reorder it or move it to the other end of the bar.
