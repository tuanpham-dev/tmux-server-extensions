// automations' durable store: <config>/tmux-server/automations/automations.json.
// Same discipline as agent-tasks' store - temp-then-rename at 0600, one
// promise chain for writes, a missing or corrupt file loads empty (the
// corrupt one kept aside) - so a scheduler tick and a panel edit landing
// together can never drop each other's change.
//
// Document: { version: 1, automations: { [id]: entry } }, where an entry is
//   { id, name, enabled, trigger, action, repo,
//     createdAt, updatedAt, lastRunAt, lastResult, lastStatus, nextRunAt, runCount }
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function newAutomationId() {
  return `auto_${randomBytes(6).toString("hex")}`;
}

function emptyDocument() {
  return { version: 1, automations: {} };
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export function createAutomationStore(configDir) {
  const file = path.join(configDir, "automations", "automations.json");
  let doc = null;
  let queue = Promise.resolve();

  async function ensureLoaded() {
    if (doc) return doc;
    let raw = null;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    doc = emptyDocument();
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.automations && typeof parsed.automations === "object" && !Array.isArray(parsed.automations)) {
          doc.automations = parsed.automations;
        }
      } catch {
        await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      }
    }
    return doc;
  }

  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  return {
    file,

    async list() {
      await queue;
      const current = await ensureLoaded();
      return structuredClone(Object.values(current.automations)).sort((a, b) => a.createdAt - b.createdAt);
    },

    async get(id) {
      await queue;
      const current = await ensureLoaded();
      return current.automations[id] ? structuredClone(current.automations[id]) : null;
    },

    // fn(draft) mutates a copy; saved and adopted only if fn does not throw.
    update(fn) {
      return enqueue(async () => {
        const draft = structuredClone(await ensureLoaded());
        const result = await fn(draft);
        await writeJsonAtomic(file, draft);
        doc = draft;
        return result;
      });
    },
  };
}
