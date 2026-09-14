# Agent Tasks

Give several AI coding agents owned, dependency-ordered work and supervise them from one
**AGENT TASKS** sidebar tab - including while no browser is open.

- A **run** has an objective and a repository, and holds **tasks**.
- A task can depend on other tasks in its run. It becomes **ready** once every dependency has
  completed, and **blocked** if one fails.
- **Start worker** launches an agent (from **Settings → AI Providers**) on a ready task, in its
  own tmux session and, optionally, its own git worktree. That launch is a **dispatch**.
- Workers report back with the `agent-task` command, and through the agent's own hooks.
  Questions become **gates** you answer from the panel; what workers tell you lands in the
  **INBOX**, and the tab's badge counts what you have not acknowledged.

Every status and every button in the panel is computed by the server, so what you see is
what the state machine actually allows.

## The panel

| Section | What it shows |
| --- | --- |
| INBOX | Messages from workers, newest first: `done` reports, `question`s (an `ask`, or an agent waiting on a permission prompt), `escalation`s (a lost worker, or one that ended its turn without finishing) and notes. Acknowledge one or all; jump to the worker's session. |
| GATES | Open decisions. One button per option the worker offered, or type an answer. Resolving a gate a worker opened sends the answer to that worker and unblocks its task. |
| TASKS | Runs and their tasks: status, dependencies, the live worker (agent, elapsed time, what it is waiting on), and one button per allowed action - Start worker, Stop worker, Retry, Complete, Fail, Hold for decision, Delete. Under a finished task, what its worker left behind - its session and a worktree Agent Tasks created - with Open, Close session and Remove worktree. A run's Clean up button does the same for every finished worker in it. |
| ARCHIVED RUNS | Loaded on demand; Restore brings a run back. |

Task statuses: `pending` (waiting on dependencies), `ready`, `dispatched` (a worker is on it),
`blocked` (an open gate or a failed dependency), `completed`, `failed`.

Stopping a worker and deleting a task or a run ask for confirmation first; stopping a worker
also kills its tmux session.

A finished worker's session and worktree are **kept** so you can review the work, and removed
only when you ask. Removing a worktree always keeps its branch, never touches the run's own
repository or a directory you named, and never one a running worker is using. A worktree with
uncommitted or untracked files asks a second time before it is forced out.

## How a worker finishes

1. **`agent-task done`**, run by the agent itself, as its brief tells it to. This is the normal
   way, and the only way to report a failure.
2. **The agent's own `stop` hook**, for an agent that never uses `agent-task` at all. When its
   turn ends, core delivers a `stop` event for its tmux pane and the task completes as succeeded.
   This needs the agent's hooks installed: **Settings → AI Providers → Install for me**. A turn
   you interrupt (Esc) does not count.

   Once a worker has used any `agent-task` verb - even just `dispatch-show` - it speaks the
   protocol, and **a turn ending no longer finishes its task**. A stop without `done` means it
   stopped early, usually to ask you something in its own UI instead of with `agent-task ask`.
   The task stays open, the worker shows as *stopped without finishing*, and one escalation lands
   in the inbox. Answer it in the worker's pane (it clears as soon as the worker uses
   `agent-task` again), or mark the task complete or failed yourself.
3. **Neither.** A liveness sweep every 15 seconds marks a worker **lost** as soon as its tmux pane
   is gone, or when it has shown no sign of life (a heartbeat, a check, a message) for
   `agentTasks.heartbeatTimeoutSeconds`. A worker waiting on you - an open question, a permission
   prompt, a turn that ended early - is never timed out, only a gone pane counts. The task goes
   back to ready and an escalation lands in the inbox. Nothing is retried automatically.

Only a task's current dispatch can finish it: a late `done` from a worker that was already
lost or replaced is refused.

Workers are tracked by **tmux pane id**, so renaming a session or window changes nothing.

## Launching

Start worker asks for an agent and where to work:

- **New worktree for this task** - a branch named from the task title (lowercased, other
  characters turned into `-`, capped at 48, plus the short task id) at
  `agentTasks.worktreeLocation`;
- **The run's repository**;
- **A directory** you name.

The server creates the session and types one line into it:

```sh
export TS_AGENT_SOCK=... TS_RUN_ID=... TS_TASK_ID=... TS_DISPATCH_ID=...; export PATH='<config>/tmux-server/bin':"$PATH"; <agent launch command> '<one-line brief>'
```

The launch command is the agent's own, with the global Yolo/Manual choice from
**Settings → AI Providers** applied. The one-line brief is the agent's first prompt, so the
worker starts on the task straight away - there is no step where it waits for you to press
Enter. The agent's CLI must accept an initial prompt argument, as Claude Code and Codex do.
The line assumes a POSIX-style shell (bash, zsh) that starts straight to a prompt.

## The worker contract

The brief tells the agent three rules:

1. Run `agent-task heartbeat --status <what you are doing>` every few minutes during long work.
2. Run `agent-task ask --question <question> --options <a,b>` for a decision, then
   `agent-task check --wait` for the answer.
3. Run `agent-task done --outcome succeeded|failed --body <summary>` exactly once.

`agent-task dispatch-show` prints the full brief again at any time.

## The `agent-task` CLI

Installed to `<config>/tmux-server/bin/agent-task` whenever the extension activates, and put on
the worker's PATH by the launch line. It is a POSIX `sh` script around `curl --unix-socket`.

| Verb | Flags | What it does |
| --- | --- | --- |
| `heartbeat` | `[--status <text>]` | Sign of life, with an optional status shown in the panel. |
| `ask` | `--question <text> [--options <a,b,c>]` | Opens a gate and files a question in the inbox. |
| `check` | `[--wait] [--timeout-ms <ms>] [--ack] [--types <a,b>]` | The next unread message for this worker. `--wait` blocks until one arrives or the timeout passes (default 60000, max 600000); `--ack` marks it read. |
| `send` | `--body <text> [--to <handle>] [--type note\|status\|question\|escalation]` | A message. `--to` defaults to `@coordinator` (the inbox); other handles reach workers: `@all`, `@idle`, `@<program>` (e.g. `@claude`), `@worktree:<path>`, `@task:<id>`, or a dispatch id. |
| `done` | `--outcome succeeded\|failed --body <summary>` | Finishes the task. |
| `status` | | This worker's dispatch, task and run. |
| `dispatch-show` | | The brief. |
| `run-create` | `--objective <text> [--repo <path>]` | Creates a run (from any shell). |
| `task-create` | `(--run-id <id> \| --objective <text> [--repo <path>]) --title <text> [--spec <text>] [--deps <id,id>]` | Creates a task, and a run for it when given an objective. |
| `worker-start` | `--task-id <id> --agent-id <id> [--worktree current\|new\|<path>]` | Starts a worker. |
| `subscribe` | | Streams task, gate and worker transitions as JSON lines. |
| `help` | | Lists all of the above. |

Any flag value can be `-` to read it from stdin. The ids come from `TS_RUN_ID`, `TS_TASK_ID` and
`TS_DISPATCH_ID` unless a flag gives them. Outside a worker pane, set
`TS_AGENT_SOCK=~/.config/tmux-server/agent-tasks/control.sock`.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `agentTasks.worktreeLocation` | `{repo}/.worktrees/{branch}` | Where a new worktree goes. |
| `agentTasks.heartbeatTimeoutSeconds` | `600` (60-3600) | Silence before a worker is marked lost. A worker whose pane is gone is lost at once. |
| `agentTasks.archiveAfterDays` | `30` (1-365) | Runs whose tasks have all finished are archived this long after their last activity. |

## Files

All under `~/.config/tmux-server/` (or `$XDG_CONFIG_HOME/tmux-server/`):

| Path | |
| --- | --- |
| `agent-tasks/store.json` | Runs, tasks, dispatches, gates and messages (the newest 500 messages per run). |
| `agent-tasks/archive.json` | Archived runs. |
| `agent-tasks/control.sock` | The control socket. |
| `bin/agent-task` | The CLI. |

The directory is `0700` and every file in it `0600`; writes are temp-then-rename.

## Security

Workers reach the extension over a unix socket rather than the app's HTTP API, because core
deliberately keeps the app's auth token out of every pane. The socket is only reachable by the
user who runs tmux-server. Anything that user runs can create runs and tasks and start workers
through it, just as it could run the agent directly.

## Known limits

- Disabling the extension stops its control socket and sweep only on a tmux-server core that
  calls a server extension's `deactivate()`. On an older core they keep running until the
  extension is enabled again or the server restarts.
- An agent that never uses `agent-task` is finished by its first turn end, so if it stops to ask
  you something in chat, its task completes early. Agents following the brief do not hit this.
- The control socket lives under the config directory. A config directory path long enough to
  push `control.sock` past the 108-byte Unix socket limit stops the extension from starting.
