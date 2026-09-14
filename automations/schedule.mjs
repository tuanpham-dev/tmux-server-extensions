// When an automation runs next, as pure functions of a trigger and a clock -
// no timers, no store - so every rule is pinned by src/schedule.test.ts.
//
// Three schedule kinds, all in the SERVER's local time:
//   daily     { kind: "daily", time: "HH:MM" }
//   interval  { kind: "interval", minutes: n }         n >= 1
//   cron      { kind: "cron", expr: "m h dom mon dow" } standard 5 fields
// plus event triggers ({ kind: "event", event, runId?, repo? }), which have
// no next run at all: agent-tasks' lifecycle stream fires them.

const MINUTE = 60_000;

export const EVENT_KINDS = ["task-completed", "task-failed", "task-blocked", "gate-opened", "worker-lost"];

// ---- cron ----
// Hand-rolled on purpose (no dependency in a server entry with no build
// step): numbers, *, ranges a-b, steps */n and a-b/n, and comma lists. Day of
// week 0-7 with both 0 and 7 meaning Sunday. When day-of-month and day-of-week
// are both restricted a day matching EITHER runs, as in every cron.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${name}: "${part}" is not a number, range, list or step`);
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron ${name}: "${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs 5 fields: minute hour day-of-month month day-of-week");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

// The first matching minute strictly after `from`, searched up to ~4 years
// ahead (a Feb 29 schedule), or null for one that can never match (Feb 30).
// Skips a whole month, day or hour at a time when that part cannot match.
export function nextCron(c, from) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from + 4 * 366 * 24 * 60 * MINUTE;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) d.setMonth(d.getMonth() + 1, 1), d.setHours(0, 0, 0, 0);
    else if (!dayMatches(c, d)) d.setDate(d.getDate() + 1), d.setHours(0, 0, 0, 0);
    else if (!c.hour.has(d.getHours())) d.setHours(d.getHours() + 1, 0, 0, 0);
    else if (!c.minute.has(d.getMinutes())) d.setMinutes(d.getMinutes() + 1, 0, 0);
    else return d.getTime();
  }
  return null;
}

// ---- Triggers ----

// A trigger as stored, or a thrown Error whose message is fit for a 400.
export function normalizeTrigger(raw) {
  const kind = raw?.kind;
  if (kind === "daily") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw.time ?? "").trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('a daily trigger needs time "HH:MM" (24-hour)');
    return { kind, time: `${m[1].padStart(2, "0")}:${m[2]}` };
  }
  if (kind === "interval") {
    const minutes = Number(raw.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
      throw new Error("an interval trigger needs whole minutes between 1 and 10080");
    }
    return { kind, minutes };
  }
  if (kind === "cron") {
    const expr = String(raw.expr ?? "").trim().replace(/\s+/g, " ");
    const parsed = parseCron(expr);
    if (nextCron(parsed, Date.now()) === null) throw new Error(`cron "${expr}" never runs`);
    return { kind, expr };
  }
  if (kind === "event") {
    if (!EVENT_KINDS.includes(raw.event)) throw new Error(`an event trigger needs one of: ${EVENT_KINDS.join(", ")}`);
    const out = { kind, event: raw.event };
    if (typeof raw.runId === "string" && raw.runId.trim()) out.runId = raw.runId.trim();
    if (typeof raw.repo === "string" && raw.repo.trim()) out.repo = raw.repo.trim();
    return out;
  }
  throw new Error("trigger kind must be daily, interval, cron or event");
}

export function isSchedule(trigger) {
  return trigger?.kind === "daily" || trigger?.kind === "interval" || trigger?.kind === "cron";
}

// The next run strictly after `from`. For an interval the clock is the last
// run (or creation), so `from` is that moment, not "now". Null for an event
// trigger or a cron that never matches.
export function nextRun(trigger, from) {
  if (trigger?.kind === "daily") {
    const [h, m] = trigger.time.split(":").map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (trigger?.kind === "interval") return from + trigger.minutes * MINUTE;
  if (trigger?.kind === "cron") return nextCron(parseCron(trigger.expr), from);
  return null;
}

// What the scheduler does with one automation right now:
//   "fire"  it is due;
//   "skip"  it was due while the server was down, longer ago than the grace
//           window - reschedule without running (a week-old daily job must not
//           fire the moment the server comes back);
//   "wait"  not due.
// Only a startup pass skips. A late tick while running always fires: the
// server was up, so a few seconds late is the tick, not a missed run.
export function dueAction(automation, now, { startup = false, graceMinutes = 60 } = {}) {
  if (!automation.enabled || !isSchedule(automation.trigger)) return "wait";
  const due = automation.nextRunAt;
  if (typeof due !== "number" || due > now) return "wait";
  if (startup && now - due > Math.max(0, graceMinutes) * MINUTE) return "skip";
  return "fire";
}

export function describeTrigger(trigger) {
  switch (trigger?.kind) {
    case "daily":
      return `Every day at ${trigger.time}`;
    case "interval":
      return trigger.minutes === 1 ? "Every minute" : `Every ${trigger.minutes} minutes`;
    case "cron":
      return `Cron ${trigger.expr}`;
    case "event": {
      const filters = [trigger.runId && `run ${trigger.runId}`, trigger.repo && `repo ${trigger.repo}`].filter(Boolean);
      return `On ${trigger.event.replace("-", " ")}${filters.length ? ` (${filters.join(", ")})` : ""}`;
    }
    default:
      return "Unknown trigger";
  }
}
