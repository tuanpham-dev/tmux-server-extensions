# AI Command Search

Natural language → shell command, powered by an AI CLI already installed on the machine running tmux-server. The generated command is typed at your prompt for review — it is **never executed automatically**.

## Usage

- **Command palette** (`Ctrl+Shift+P`) → "AI: Generate Command…", describe what you want, press Enter.
- **Quick switcher** (`Ctrl+P`) → type `??` followed by your request (e.g. `??list the 5 largest files here`) and press Enter on the "Ask AI" row.

Either way the reply lands on your command line in the active terminal, ready to edit or run yourself.

## Providers

Pick one in the extension's Settings section:

| Provider | Binary | Invocation |
|---|---|---|
| Claude Code (default) | `claude` | `claude -p [--model <m>] <prompt>` |
| OpenAI Codex | `codex` | `codex exec [-m <m>] <prompt>` |
| Google Gemini | `gemini` | `gemini [-m <m>] -p <prompt>` |
| Custom command | — | your command line, prompt appended as its single argument |

Settings: `aiCommand.provider` (which CLI), `aiCommand.binaryPath` (override the binary name/path), `aiCommand.model` (passed as the provider's model flag), `aiCommand.customCommand` (custom provider's command line — it must print exactly one shell command).

The chosen CLI must be installed and authenticated on the **server** machine (it runs there, not in the browser). Expect a few seconds of CLI startup latency per request; a small/fast model helps.
