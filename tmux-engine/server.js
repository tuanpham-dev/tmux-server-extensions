// Server hook for the tmux backend: registers tmux as a terminal engine the
// user can pick in Settings -> Terminal Backend. Nothing changes until it is
// picked and the server restarts; see engine.js for how tmux is driven.
//
// TMUX_SERVER_TMUX_SOCKET names a tmux socket (tmux -L) to use instead of the
// default one, so a test instance can run without touching the user's tmux.
import { execFileSync } from "node:child_process";
import { createTmuxEngine } from "./engine.js";

export function activate({ host, log }) {
  host.terminalEngines.register({
    id: "tmux",
    label: "tmux",
    description:
      "Terminals run in tmux. Sessions started with tmux in any terminal show up here, and sessions started here are ordinary tmux sessions. The shell and what survives a reboot come from tmux's own configuration.",
    create: ({ env }) => {
      // Refusing here keeps the server on the bundled daemon.
      execFileSync("tmux", ["-V"], { stdio: "ignore" });
      return createTmuxEngine({ env, socketName: process.env.TMUX_SERVER_TMUX_SOCKET ?? "", log });
    },
  });
}
