// The hook half of agent-monitor's classifier, as a pure reducer: one
// normalized hook event in, one per-pane status record out. Kept free of
// tmux and the filesystem so it can be tested by calling it.
//
// The rules are Orca's (stablyai/orca, src/shared/agent-hook-listener/
// providers/claude-events.ts and codex-events.ts), read from its source
// rather than guessed:
//
//   session-start   -> done, as a session boundary. A resumed session emits
//                      SessionStart at an idle prompt and nothing else;
//                      "working" there would spin forever over a TUI that is
//                      waiting for input.
//   prompt-submit   -> working. The prompt is cached for the turn.
//   tool-start      -> working - unless the tool is the agent asking the USER
//                      a question (Claude's AskUserQuestion, Codex's
//                      request_user_input), which blocks on a human exactly
//                      like a permission prompt does and is shown the same.
//   tool-end        -> working, tool cleared.
//   permission      -> waiting, on a permission prompt.
//   stop            -> done; `is_interrupt` marks a cancelled turn.
//
// A record is authoritative while fresh: nothing else (a transcript write, a
// title glyph) overrides it, because a turn that starts or a tool that runs
// sends its own event. It goes stale after STALE_AFTER_MS, Orca's
// AGENT_STATUS_STALE_AFTER_MS, for the pane whose process died without a
// final hook.
export const STALE_AFTER_MS = 30 * 60 * 1000;

// Tools that mean "the agent is waiting for the user to answer", per agent.
// Matched by tool name, not by event: newer Claude builds report
// AskUserQuestion as PermissionRequest and older ones as PreToolUse.
export const QUESTION_TOOLS = new Set(["AskUserQuestion", "request_user_input"]);

const PROMPT_MAX = 160;
const TOOL_NAME_MAX = 60;

function text(value, max) {
  if (typeof value !== "string") return undefined;
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function toolNameOf(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  return text(payload.tool_name ?? payload.name, TOOL_NAME_MAX);
}

// previous: the pane's current record or undefined. event: core's normalized
// AgentHookEvent. Returns the new record, or null for an event this reducer
// does not act on (which leaves the previous record in place).
export function reduceHookEvent(previous, event) {
  const at = typeof event.receivedAt === "number" ? event.receivedAt : Date.now();
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const carried = previous?.prompt;

  switch (event.event) {
    case "session-start":
      return { state: "done", at, sessionBoundary: true };
    case "prompt-submit":
      return { state: "working", at, prompt: text(payload.prompt, PROMPT_MAX) };
    case "tool-start": {
      const toolName = toolNameOf(payload);
      if (toolName && QUESTION_TOOLS.has(toolName)) {
        return { state: "waiting", detail: "question", at, toolName, prompt: carried };
      }
      return { state: "working", at, toolName, prompt: carried };
    }
    case "tool-end":
      return { state: "working", at, prompt: carried };
    case "permission": {
      const toolName = toolNameOf(payload);
      // Same tool-name rule as tool-start: a question reported through the
      // permission channel is still a question.
      const detail = toolName && QUESTION_TOOLS.has(toolName) ? "question" : "permission";
      return { state: "waiting", detail, at, toolName, prompt: carried };
    }
    case "stop":
      return { state: "done", at, interrupted: payload.is_interrupt === true || undefined, prompt: carried };
    default:
      return null;
  }
}

// What the classifier reports for a pane from its record alone, or null when
// there is no record or it has gone stale - in which case the caller falls
// through to its other signals.
export function classifyFromHook(record, now = Date.now()) {
  if (!record || now - record.at > STALE_AFTER_MS) return null;
  return {
    state: record.state,
    ...(record.detail ? { stateDetail: record.detail } : {}),
    ...(record.prompt ? { prompt: record.prompt } : {}),
    ...(record.toolName ? { toolName: record.toolName } : {}),
    ...(record.interrupted ? { interrupted: true } : {}),
    lastActivityAt: record.at,
  };
}
