# AI Command Search

Natural language → shell command, powered by an AI CLI already installed on the machine running tmux-server. The generated command is typed at your prompt for review — it is **never executed automatically**.

## Usage

- **Command palette** (`Ctrl+Shift+P`) → "AI: Generate Command…", describe what you want, press Enter.
- **Quick switcher** (`Ctrl+P`) → type `??` followed by your request (e.g. `??list the 5 largest files here`) and press Enter on the "Ask AI" row.

Either way the reply lands on your command line in the active terminal, ready to edit or run yourself.

## Which AI

This extension has no provider setting of its own. It asks whatever is configured in **Settings → AI Providers**, shared with every other AI feature in the app — the `claude`, `codex` or `agy` CLIs, the Anthropic or OpenAI HTTP APIs, or a custom command. Change it once there and every feature follows.

A CLI provider must be installed and authenticated on the **server** machine — it runs there, not in the browser. Expect a few seconds of startup latency per request; a small, fast model helps.
