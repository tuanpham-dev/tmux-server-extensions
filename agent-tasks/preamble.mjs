// The brief a worker's agent gets: what the task is, which ids it is working
// under, and the three rules that let the server supervise it. Two forms of
// the same text:
//
//   buildPreamble      the full multi-line brief, served by
//                      `agent-task dispatch-show` whenever the worker asks;
//   buildPreambleLine  one line, passed to the agent as its first prompt on
//                      the launch line.
//
// One line because the launch line is typed into the pane's shell through
// tmux send-keys, where a newline is an Enter: inside the quoted argument it
// would leave the shell waiting on a continuation prompt instead of starting
// the agent. The line carries the task and the rules and points at
// dispatch-show for the rest.

const SPEC_LINE_MAX = 1200;

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

const RULES = [
  "Run `agent-task heartbeat --status <what you are doing>` every few minutes during long stretches of work, or this worker is marked lost.",
  "Run `agent-task ask --question <question> --options <a,b>` when you need a decision, then `agent-task check --wait` for the answer. Do not guess at decisions that are not yours.",
  "Run `agent-task done --outcome succeeded|failed --body <summary>` exactly once, when the task is finished or cannot be finished.",
];

export function buildPreamble({ run, task, dispatch, depsSummary = [] }) {
  const lines = [
    `# Agent task: ${oneLine(task.title)}`,
    "",
    "You are a worker in an agent-tasks run, supervised from the AGENT TASKS panel.",
    "",
    `Run objective: ${oneLine(run?.objective) || "(none)"}`,
    `Run: ${task.runId}   Task: ${task.id}   Dispatch: ${dispatch.id}`,
  ];
  if (dispatch.worktreePath) lines.push(`Working directory: ${dispatch.worktreePath}`);
  if (depsSummary.length > 0) {
    lines.push("", "Finished before this task:");
    for (const dep of depsSummary) lines.push(`- ${oneLine(dep.title)} (${dep.status})`);
  }
  lines.push("", "## Task", "", String(task.spec ?? "").trim() || oneLine(task.title), "", "## Rules", "");
  RULES.forEach((rule, i) => lines.push(`${i + 1}. ${rule}`));
  lines.push(
    "",
    "The `agent-task` command is already on your PATH and knows your ids. `agent-task help` lists every verb.",
  );
  return `${lines.join("\n")}\n`;
}

export function buildPreambleLine({ run, task, dispatch }) {
  let spec = oneLine(task.spec);
  if (spec.length > SPEC_LINE_MAX) spec = `${spec.slice(0, SPEC_LINE_MAX)}... (truncated - see agent-task dispatch-show)`;
  const parts = [
    `You are an agent-tasks worker (task ${task.id}, dispatch ${dispatch.id}).`,
    run?.objective ? `Run objective: ${oneLine(run.objective)}.` : "",
    `Task: ${oneLine(task.title)}.`,
    spec ? `Details: ${spec}` : "",
    `Rules: (1) ${RULES[0]} (2) ${RULES[1]} (3) ${RULES[2]}`,
    "Run `agent-task dispatch-show` any time to read this brief again.",
  ];
  return parts.filter(Boolean).join(" ");
}
