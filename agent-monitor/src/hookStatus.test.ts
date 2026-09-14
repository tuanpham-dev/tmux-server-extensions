// The hook reducer's rules, pinned. They are Orca's (read from its source, not
// guessed), so each case names the situation it protects rather than the
// mapping it asserts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFromHook, reduceHookEvent, STALE_AFTER_MS } from "../hookStatus.mjs";

const at = 1_000_000;
const ev = (event: string, payload: unknown = {}, receivedAt = at) => ({ event, payload, receivedAt, paneId: "%1" });

test("a resumed session lands idle, not spinning", () => {
  // SessionStart is the only event a resumed session sends before its first
  // prompt; "working" would spin over an idle TUI forever.
  const r = reduceHookEvent(undefined, ev("session-start", { source: "resume" }));
  assert.equal(r?.state, "done");
  assert.equal(r?.sessionBoundary, true);
});

test("a prompt starts a turn and is remembered across it", () => {
  const started = reduceHookEvent(undefined, ev("prompt-submit", { prompt: "fix the   flaky test\n please" }));
  assert.equal(started?.state, "working");
  assert.equal(started?.prompt, "fix the flaky test please");
  const tool = reduceHookEvent(started, ev("tool-start", { tool_name: "Bash" }));
  assert.equal(tool?.prompt, "fix the flaky test please", "the prompt survives later tool events");
  assert.equal(tool?.toolName, "Bash");
});

test("a tool call means working, and the tool is named", () => {
  const r = reduceHookEvent(undefined, ev("tool-start", { tool_name: "Read" }));
  assert.equal(r?.state, "working");
  assert.equal(r?.toolName, "Read");
  const ended = reduceHookEvent(r, ev("tool-end", { tool_name: "Read" }));
  assert.equal(ended?.state, "working");
  assert.equal(ended?.toolName, undefined, "nothing is in flight after the tool ends");
});

test("the agent asking the user a question is a wait, whichever channel reports it", () => {
  // Claude: AskUserQuestion arrives as PreToolUse on older builds and as
  // PermissionRequest on newer ones. Codex: request_user_input is auto-allowed
  // and so arrives as PreToolUse while blocked on a human.
  for (const [event, tool] of [
    ["tool-start", "AskUserQuestion"],
    ["permission", "AskUserQuestion"],
    ["tool-start", "request_user_input"],
  ] as const) {
    const r = reduceHookEvent(undefined, ev(event, { tool_name: tool }));
    assert.equal(r?.state, "waiting", `${event}/${tool}`);
    assert.equal(r?.detail, "question", `${event}/${tool}`);
  }
});

test("a permission prompt is a wait that names the tool", () => {
  const r = reduceHookEvent(undefined, ev("permission", { tool_name: "Bash", tool_input: { command: "rm -rf" } }));
  assert.equal(r?.state, "waiting");
  assert.equal(r?.detail, "permission");
  assert.equal(r?.toolName, "Bash");
});

test("stop is done, and a cancelled turn says so", () => {
  assert.equal(reduceHookEvent(undefined, ev("stop"))?.interrupted, undefined);
  assert.equal(reduceHookEvent(undefined, ev("stop", { is_interrupt: true }))?.interrupted, true);
  assert.equal(reduceHookEvent(undefined, ev("stop", { is_interrupt: true }))?.state, "done");
});

test("an event the reducer does not act on leaves the record alone", () => {
  assert.equal(reduceHookEvent({ state: "working", at }, ev("subagent-stop")), null);
  assert.equal(reduceHookEvent(undefined, ev("something-new")), null);
});

test("a payload that is not an object never throws", () => {
  for (const payload of [null, "text", 42, [], undefined]) {
    assert.equal(reduceHookEvent(undefined, ev("tool-start", payload))?.state, "working");
  }
});

test("prompt and tool name are single-line and bounded", () => {
  const long = "x".repeat(500);
  const r = reduceHookEvent(undefined, ev("prompt-submit", { prompt: `${long}\n\n${long}` }));
  assert.ok((r?.prompt?.length ?? 0) <= 160);
  assert.ok(!r?.prompt?.includes("\n"));
  const t = reduceHookEvent(undefined, ev("tool-start", { tool_name: long }));
  assert.ok((t?.toolName?.length ?? 0) <= 60);
});

test("hook evidence is authoritative while fresh and gone after 30 minutes", () => {
  const record = reduceHookEvent(undefined, ev("permission", { tool_name: "Bash" }));
  assert.equal(classifyFromHook(record, at + STALE_AFTER_MS)?.state, "waiting");
  assert.equal(classifyFromHook(record, at + STALE_AFTER_MS + 1), null);
  assert.equal(classifyFromHook(undefined), null);
});

test("the classification carries only what is set", () => {
  const c = classifyFromHook(reduceHookEvent(undefined, ev("stop")), at);
  assert.deepEqual(c, { state: "done", lastActivityAt: at });
  const w = classifyFromHook(reduceHookEvent(undefined, ev("permission", { tool_name: "Edit" })), at);
  assert.deepEqual(w, { state: "waiting", stateDetail: "permission", toolName: "Edit", lastActivityAt: at });
});
