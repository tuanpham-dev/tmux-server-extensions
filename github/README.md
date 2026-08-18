# GitHub

A GITHUB sidebar tab listing the active repo's open pull requests and issues, with a
"Start work" action per row that creates a worktree session for it — optionally
priming an agent on it. Backed by the `gh` CLI; the extension holds no credentials of
its own.

## Requirements

- The [`gh` CLI](https://cli.github.com/) installed and on `PATH`.
- `gh auth login` run once on this machine.

Without either, the panel shows a setup hint instead of an error.

## "Start work"

Creates a worktree — for an issue, a new branch off the repo's default branch; for a
PR, the PR's own head ref (fetched by number via GitHub's `refs/pull/<n>/head`
convention) — opens it as a session, then (if `github.agents` has at least one preset)
starts the first configured agent and hands it the issue/PR title and body as a second
message. The agent's launch command is always submitted; the issue/PR context follows
`github.sendAutoSubmit` (default off — you review before pressing Enter).

## Settings

| Key | Default | Description |
|---|---|---|
| `github.worktreeLocation` | `{repo}/.worktrees/{branch}` | Where "Start work" creates its worktree — same convention as the bundled Worktrees extension |
| `github.agents` | Claude Code presets | JSON array of `{name, command}` — the agent "Start work" primes. `[]` skips starting an agent |
| `github.sendAutoSubmit` | `false` | Submit the issue/PR context to the agent immediately, instead of typing it for review |
