// automations' schedule rules and store, pinned. The subject is the plain .mjs
// beside server.js, as in agent-monitor's src/hookStatus.test.ts. Dates are
// built in local time because schedules are server-local by design.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describeTrigger, dueAction, nextCron, nextRun, normalizeTrigger, parseCron } from "../schedule.mjs";
import { createAutomationStore } from "../store.mjs";

const MINUTE = 60_000;
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

// ---- daily ----

test("a daily trigger runs later today when its time has not passed, else tomorrow", () => {
  const trigger = normalizeTrigger({ kind: "daily", time: "9:05" });
  assert.deepEqual(trigger, { kind: "daily", time: "09:05" });
  assert.equal(nextRun(trigger, local(2026, 3, 10, 8, 0)), local(2026, 3, 10, 9, 5));
  assert.equal(nextRun(trigger, local(2026, 3, 10, 9, 5)), local(2026, 3, 11, 9, 5), "exactly at the time means the next day");
  assert.equal(nextRun(trigger, local(2026, 12, 31, 23, 0)), local(2027, 1, 1, 9, 5), "across a year boundary");
});

test("a daily time that is not HH:MM is refused at create", () => {
  assert.throws(() => normalizeTrigger({ kind: "daily", time: "25:00" }), /HH:MM/);
  assert.throws(() => normalizeTrigger({ kind: "daily", time: "noon" }), /HH:MM/);
});

// ---- interval ----

test("an interval counts from the last run", () => {
  const trigger = normalizeTrigger({ kind: "interval", minutes: 15 });
  assert.equal(nextRun(trigger, local(2026, 3, 10, 8, 0)), local(2026, 3, 10, 8, 15));
  assert.throws(() => normalizeTrigger({ kind: "interval", minutes: 0 }), /minutes/);
  assert.throws(() => normalizeTrigger({ kind: "interval", minutes: 1.5 }), /minutes/);
});

// ---- cron ----

test("cron: every 15 minutes during working hours on weekdays", () => {
  const trigger = normalizeTrigger({ kind: "cron", expr: "*/15  9-17 * * 1-5" });
  assert.equal(trigger.expr, "*/15 9-17 * * 1-5");
  // Friday 2026-03-13 17:50 -> Monday 09:00
  assert.equal(nextRun(trigger, local(2026, 3, 13, 17, 50)), local(2026, 3, 16, 9, 0));
  assert.equal(nextRun(trigger, local(2026, 3, 16, 9, 0)), local(2026, 3, 16, 9, 15), "strictly after");
  assert.equal(nextRun(trigger, local(2026, 3, 16, 9, 7)), local(2026, 3, 16, 9, 15));
});

test("cron: lists, a month field and Sunday written as 7", () => {
  assert.equal(nextCron(parseCron("30 6 1,15 * *"), local(2026, 3, 2, 0, 0)), local(2026, 3, 15, 6, 30));
  assert.equal(nextCron(parseCron("0 0 1 1 *"), local(2026, 3, 2)), local(2027, 1, 1));
  const sunday = nextCron(parseCron("0 12 * * 7"), local(2026, 3, 10));
  assert.equal(new Date(sunday!).getDay(), 0);
});

test("cron: day-of-month and day-of-week both restricted means either", () => {
  // The 20th, or any Monday - whichever comes first after Tue 2026-03-10.
  assert.equal(nextCron(parseCron("0 8 20 * 1"), local(2026, 3, 10)), local(2026, 3, 16, 8, 0));
});

test("cron: unparseable or impossible expressions are refused at create", () => {
  assert.throws(() => normalizeTrigger({ kind: "cron", expr: "* * *" }), /5 fields/);
  assert.throws(() => normalizeTrigger({ kind: "cron", expr: "61 * * * *" }), /out of range/);
  assert.throws(() => normalizeTrigger({ kind: "cron", expr: "a * * * *" }), /not a number/);
  assert.throws(() => normalizeTrigger({ kind: "cron", expr: "0 0 30 2 *" }), /never runs/);
});

// ---- event ----

test("event triggers have no next run and only known events are accepted", () => {
  const trigger = normalizeTrigger({ kind: "event", event: "task-failed", runId: " run_abc " });
  assert.deepEqual(trigger, { kind: "event", event: "task-failed", runId: "run_abc" });
  assert.equal(nextRun(trigger, Date.now()), null);
  assert.throws(() => normalizeTrigger({ kind: "event", event: "task-exploded" }), /event trigger/);
  assert.equal(describeTrigger(trigger), "On task failed (run run_abc)");
});

// ---- grace ----

test("the startup pass fires a missed run inside the grace window, once", () => {
  const now = local(2026, 3, 10, 9, 30);
  const automation = { enabled: true, trigger: { kind: "daily", time: "09:00" }, nextRunAt: local(2026, 3, 10, 9, 0) };
  assert.equal(dueAction(automation, now, { startup: true, graceMinutes: 60 }), "fire");
  // After firing, the scheduler moves nextRunAt on, and it is not due again.
  const after = { ...automation, nextRunAt: nextRun(automation.trigger, now) };
  assert.equal(dueAction(after, now, { startup: true, graceMinutes: 60 }), "wait");
});

test("the startup pass skips a run missed longer ago than the grace window", () => {
  const now = local(2026, 3, 10, 11, 0);
  const automation = { enabled: true, trigger: { kind: "daily", time: "09:00" }, nextRunAt: local(2026, 3, 10, 9, 0) };
  assert.equal(dueAction(automation, now, { startup: true, graceMinutes: 60 }), "skip");
  assert.equal(dueAction(automation, now, { startup: true, graceMinutes: 0 }), "skip", "grace 0 fires nothing missed");
  assert.equal(dueAction(automation, now, { startup: false, graceMinutes: 60 }), "fire", "a running server's tick always fires");
});

test("disabled, not yet due and event automations never fire from the scheduler", () => {
  const now = local(2026, 3, 10, 9, 30);
  assert.equal(dueAction({ enabled: false, trigger: { kind: "interval", minutes: 1 }, nextRunAt: now - MINUTE }, now), "wait");
  assert.equal(dueAction({ enabled: true, trigger: { kind: "interval", minutes: 1 }, nextRunAt: now + MINUTE }, now), "wait");
  assert.equal(dueAction({ enabled: true, trigger: { kind: "event", event: "task-failed" }, nextRunAt: now - MINUTE }, now), "wait");
});

// ---- store ----

test("store: concurrent updates both land, at 0600", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "automations-test-"));
  const store = createAutomationStore(dir);
  assert.deepEqual(await store.list(), [], "an empty store lists nothing");
  await Promise.all([
    store.update(async (d: { automations: Record<string, unknown> }) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      d.automations.auto_1 = { id: "auto_1", createdAt: 1 };
    }),
    store.update((d: { automations: Record<string, unknown> }) => {
      d.automations.auto_2 = { id: "auto_2", createdAt: 2 };
    }),
  ]);
  const onDisk = JSON.parse(await readFile(store.file, "utf8"));
  assert.deepEqual(Object.keys(onDisk.automations).sort(), ["auto_1", "auto_2"]);
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
});
