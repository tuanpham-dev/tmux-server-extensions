# Jira

A JIRA sidebar tab listing the issues assigned to you and the active repo's project, with a
"Start work" action per row that creates a worktree session for it - optionally priming an
agent on it and moving the issue to In Progress. Backed by the Jira Cloud REST API v3.

## Requirements

- A Jira Cloud site (`https://your-team.atlassian.net`).
- An API token from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens).

Set `jira.siteUrl` and `jira.email` in Settings, then paste the token into the **API token**
field in the same section. Until all three are present the panel shows a setup hint rather
than an error.

### Where the token is kept

Not in a setting. Configuration values live in the settings document, which the client GETs,
merges, and PUTs back whole - so anything stored there is readable by anything with access to
the app. The token goes into the host's per-extension secret store instead: stripped from
`GET /api/settings`, restored from disk on every document write, and reachable only by this
extension's own server hook. That is why it has no row in the settings table below, and why
the field only ever tells you whether a token is stored, never what it is.

It survives disabling and re-enabling the extension. Uninstalling clears it.

## Project key

The project section needs to know which Jira project belongs to the repo you are looking at.
Four sources are tried, most local first - the first one that yields something shaped like a
project key wins:

| Order | Source | Example |
|---|---|---|
| 1 | A file in the repo root, named by `jira.projectKeyFile` | `.jira-project` containing `CAP` |
| 2 | A `jira.projectMap` entry for the repo root | `{"/works/acme": "CAP"}` |
| 3 | The environment variable named by `jira.projectKeyEnv` | `JIRA_PROJECT_KEY=CAP` |
| 4 | The flat `jira.projectKey` setting | `CAP` |

The in-repo file wins the way `.editorconfig` and `.nvmrc` beat user-level config. A malformed
`jira.projectMap` is skipped rather than treated as an error.

Setting **`jira.projectJql` bypasses this entirely** - the query replaces the project section
outright and no key is resolved. The section is headed `PROJECT QUERY` instead of the key when
that happens, so the bypass is visible.

## "Start work"

Creates a worktree branched off the repo's **default branch** - `origin/HEAD` if it is set,
otherwise whatever `git remote show origin` reports - after fetching `origin`. If neither can
answer (a `--depth` clone, an origin added by hand, no remote at all) it falls back to the
current HEAD and says so in the panel; `git remote set-head origin -a` fixes the common case.

The branch name comes from `jira.branchTemplate`:

| Token | Becomes |
|---|---|
| `{key}` | the issue key, e.g. `CAP-123` |
| `{slug}` | a short slug of the summary, e.g. `fix-header-alignment` |
| `{type}` | `bugfix` for a Bug issue type, `feature` otherwise |

So `{key}-{slug}` gives `CAP-123-fix-header-alignment`, and `{type}/{key}` gives
`feature/CAP-123`.

The worktree is then opened as a session, and an agent from **Settings → Agents** is started
in it and handed the issue key, summary and description as a second message. With more than
one agent configured, Start work opens a menu to pick which - and, for an agent that has a
skip-permissions flag, a **Skip permission prompts** row you can tick first, so yolo mode is
a checkbox rather than a second copy of the agent in the list. "No agent (worktree only)"
skips starting one. The agent's launch command is always submitted; the issue context
follows `jira.sendAutoSubmit`
(default off - you review before pressing Enter).

With `jira.updateIssueOnStartWork` on, it also moves the issue to `jira.inProgressStatus` and
assigns it to you if it is unassigned. Neither is fatal: the worktree exists either way, so a
Jira-side failure is reported as a note in the panel rather than as a failed "Start work".

## Settings

| Key | Default | Description |
|---|---|---|
| `jira.siteUrl` | `""` | Your Jira Cloud site. Must be https |
| `jira.email` | `""` | The Atlassian account email the API token belongs to |
| `jira.projectKey` | `""` | Fallback project key, used when no file, map entry or env var applies |
| `jira.projectKeyFile` | `.jira-project` | Repo-root file whose contents are the project key - the first source consulted |
| `jira.projectKeyEnv` | `JIRA_PROJECT_KEY` | Environment variable read for the project key |
| `jira.projectMap` | `{}` | JSON object mapping a repo root path to a project key |
| `jira.jql` | `""` | Replaces the "assigned to me" query. Empty means `assignee = currentUser() AND statusCategory != Done` |
| `jira.projectJql` | `""` | Replaces the project query, bypassing the project-key chain |
| `jira.maxResults` | `30` | How many issues each section fetches |
| `jira.branchTemplate` | `{key}-{slug}` | Branch name for "Start work" - `{key}`, `{slug}`, `{type}` |
| `jira.worktreeLocation` | `{repo}/.worktrees/{branch}` | Where "Start work" creates its worktree - same convention as the bundled Worktrees extension |
| `jira.sendAutoSubmit` | `false` | Submit the issue context to the agent immediately, instead of typing it for review |
| `jira.updateIssueOnStartWork` | `false` | Let "Start work" transition and assign the issue in Jira |
| `jira.inProgressStatus` | `In Progress` | Target status for that transition |

The API token is entered in this extension's Settings section but is not a setting - see
[Where the token is kept](#where-the-token-is-kept).
