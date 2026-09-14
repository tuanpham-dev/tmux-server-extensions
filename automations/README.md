# Automations

Agent work that starts itself. An **AUTOMATIONS** section in the **Run** tab lists automations -
a trigger and an action each - and the server runs them with no browser open.

## Triggers

| Trigger | Runs |
| --- | --- |
| Every day at a time | Daily at `HH:MM`, server-local time. |
| Every few minutes | Every `n` minutes, counted from the last run. |
| Cron | A standard 5-field expression (`minute hour day-of-month month day-of-week`): numbers, `*`, ranges, `*/n` steps and comma lists. Day of week 0-7, with 0 and 7 both Sunday. An expression that can never run is refused. |
| When something happens in Agent Tasks | `task-completed`, `task-failed`, `task-blocked`, `gate-opened` or `worker-lost`, optionally only for one run id or one repository. |

Schedules are checked every 15 seconds, so a run can start up to 15 seconds late. Event
triggers fire as the event happens.

**Missed runs.** If the server was down when a schedule came due, it runs once at startup when
it was due within `automations.missedRunGraceMinutes`; an older miss is skipped, recorded as
`missed`, and rescheduled. Turning an automation back on, or changing its trigger, counts from
that moment.

## Actions

| Action | Does |
| --- | --- |
| Ask the AI and keep the answer | Sends the prompt to the AI chosen in `automations.aiProfile` (or your default in **Settings → AI Providers**), running in the repository when one is set. The reply becomes the automation's last result. |
| Create an Agent Tasks task | Creates a run and a task in [Agent Tasks](../agent-tasks/README.md), with the prompt as the task spec. |
| Create a task and start a worker on it | The same, then starts a worker with the chosen agent, in a new worktree or in the repository. |

An event-triggered action gets the event appended to its prompt: the event, the task and its
id, the run and the repository.

An automation that is still running is not started again on top of itself.

## The panel

Each row shows the name, the trigger, the next run, the last result (click to expand it), an
enable checkbox, **Run now**, Edit and Delete. The + in the header creates one. Rows that need
Agent Tasks say **Requires the Agent Tasks extension** while its socket cannot be reached.

## Agent Tasks

Automations talks to Agent Tasks through its control socket
(`~/.config/tmux-server/agent-tasks/control.sock`), never by importing it:

- scheduled "ask the AI" automations need nothing else;
- the two task actions record `Agent Tasks is not installed` as their result when the socket is
  not there;
- event triggers hold the socket's `subscribe` stream open and reconnect on their own, backing
  off from 1 second to at most 60, so installing or restarting Agent Tasks needs no restart here.

A worker an automation starts finishes the way any Agent Tasks worker does: through the agent's
hooks (installed from **Settings → AI Providers**), the `agent-task done` command, or the
liveness sweep - see the Agent Tasks README for the worker contract and the full CLI.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `automations.missedRunGraceMinutes` | `60` (0-1440) | How late a missed scheduled run may still fire at startup. 0 fires nothing missed. |
| `automations.aiProfile` | default AI | Which AI answers "ask the AI" automations. |

## Files

`~/.config/tmux-server/automations/automations.json` (or under `$XDG_CONFIG_HOME`): every
automation with its last run, result and next run. Written `0600`, temp-then-rename.

## Known limits

- Disabling Agent Tasks does not close its socket on the tmux-server core this was built
  against (a server extension gets no stop signal), so event rows keep working until it is
  re-enabled or the server restarts. Removing it and restarting does show the note.
