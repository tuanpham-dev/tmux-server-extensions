# Prompts

A dedicated editor tab for `.prompt.md` files, with AI refinement and AI-suggested filenames. Useful for keeping a library of reusable prompts next to the code they're about.

## Usage

- **Command palette** (`Ctrl+Shift+P`) → "Prompts: New Prompt" opens an empty draft tab for the active session.
- **Tab group menu** → right-click a session's group chip in the tab bar and choose **New Prompt Here** to start a draft for *that* session, whichever tab you currently have focused. Each session gets its own draft tab, and the draft remembers which directory it belongs to, so saving always lands in the right tree.
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

Two entry points need recent tmux-server extension APIs: "Edit Prompt" (FILES-tree menu) needs `registerFileMenuItem`, and "New Prompt Here" (tab group menu) needs `registerTabGroupMenuItem`. Both are called optionally — on an older host those two entries simply don't appear, and everything else still works through the New Prompt command.

The AI CLI runs as the **server** process, so it must be on that process's `PATH`. A server started from a login shell inherits your usual `PATH`; one started by systemd often doesn't, and a CLI installed under `~/.local/bin` can go missing. If Refine reports the CLI wasn't found, set `prompts.binaryPath` to its absolute path.
