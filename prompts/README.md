# Prompts

A dedicated editor tab for `.prompt.md` files, with AI refinement and AI-suggested filenames. Useful for keeping a library of reusable prompts next to the code they're about.

## Usage

- **Command palette** (`Ctrl+Shift+P`) → "Prompts: New Prompt" opens an empty draft tab.
- Write the prompt, press **Refine** to have a local AI CLI tighten it up (your text is replaced; the tab is marked unsaved so nothing is written yet).
- Press **Save**. On a new draft the AI proposes a kebab-case filename from the content and saves straight to `plans/prompts/<name>.prompt.md` under the active session's working directory. If that name is taken — or the AI call fails — a small dialog asks you to name it yourself.
- **Reopen any prompt** by right-clicking it in the FILES tree and choosing **Edit Prompt**. A plain click still opens the file in nvim, and the markdown preview is still available from the hover icon.
- **Open in Editor** in the tab's toolbar hands the file to nvim whenever you'd rather edit it there.

The tab reloads the file when you switch back to it (unless you have unsaved changes), so edits made in nvim or by an agent show up without reopening.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `prompts.provider` | `claude` | Which local AI CLI to use: Claude Code, OpenAI Codex, Google Gemini, or a custom command. |
| `prompts.binaryPath` | — | Override the provider's binary (name on PATH or an absolute path). |
| `prompts.model` | — | Model passed to the CLI (`--model` for claude, `-m` for codex/gemini). |
| `prompts.customCommand` | — | Custom provider's command line; the instruction plus prompt arrives as its single trailing argument. |
| `prompts.refineInstruction` | see Settings | The instruction sent to the CLI when you press Refine. |
| `prompts.directory` | `plans/prompts` | Where new prompts are saved, relative to the session's working directory. |

The chosen CLI must be installed and authenticated on the **server** machine — it runs there, not in the browser. Expect a few seconds per Refine.

Nothing from the AI's reply is ever executed: the refined text lands in the editor, and the suggested filename is reduced to `[a-z0-9-]` before it's used.

## Requirements

The "Edit Prompt" context-menu item needs a tmux-server build with the `registerFileMenuItem` extension API. On older hosts everything else still works — reach prompts through the New Prompt command.
