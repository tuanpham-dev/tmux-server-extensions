// agent-tasks' durable store: one JSON document at
// <config>/tmux-server/agent-tasks/store.json, plus archive.json beside it for
// runs that finished long ago.
//
// Discipline, all of it load-bearing:
//   - every write is temp-then-rename at 0600, so a crash mid-write leaves the
//     previous document, never half of a new one;
//   - writes go through one promise chain, so two concurrent update() calls
//     cannot read the same document and have the second silently drop the
//     first's change;
//   - a missing or corrupt file loads as an empty document rather than
//     failing activation - the corrupt file is kept aside, not overwritten;
//   - every save prunes messages to the newest 500 per run and moves runs
//     that are fully terminal and older than `archiveAfterDays` out to
//     archive.json (model.mjs decides both).
//
// The config dir is a parameter (the extension passes XDG_CONFIG_HOME's
// tmux-server dir; tests pass a mkdtemp) so nothing here knows where the real
// profile lives.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyDocument, insertRun, normalizeDocument, pruneMessages, splitArchivable } from "./model.mjs";

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

async function readJson(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { value: null, corrupt: false };
    throw err;
  }
  try {
    return { value: JSON.parse(raw), corrupt: false };
  } catch {
    return { value: null, corrupt: true };
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  // writeFile's mode is masked by the umask; chmod is not.
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

function clone(value) {
  return structuredClone(value);
}

// options:
//   archiveAfterDays  number, or a function returning one (read per save, so
//                     a settings change applies without re-creating the store)
//   now               clock, for tests
//   onChange          (before, after) after every successful save
export function createStore(configDir, options = {}) {
  const dir = path.join(configDir, "agent-tasks");
  const storePath = path.join(dir, "store.json");
  const archivePath = path.join(dir, "archive.json");
  const now = options.now ?? (() => Date.now());
  const listeners = new Set();
  if (options.onChange) listeners.add(options.onChange);

  let doc = null;
  let queue = Promise.resolve();

  async function archiveDays() {
    const value = typeof options.archiveAfterDays === "function" ? await options.archiveAfterDays() : options.archiveAfterDays;
    const days = Number(value);
    return Number.isFinite(days) && days > 0 ? days : 30;
  }

  async function ensureLoaded() {
    if (doc) return doc;
    const { value, corrupt } = await readJson(storePath);
    if (corrupt) {
      // Keep the evidence; the next save would otherwise replace it.
      await rename(storePath, `${storePath}.corrupt-${now()}`).catch(() => {});
    }
    doc = normalizeDocument(value);
    return doc;
  }

  async function readArchive() {
    const { value } = await readJson(archivePath);
    const runs = value && typeof value === "object" && value.runs && typeof value.runs === "object" ? value.runs : {};
    return { version: 1, runs };
  }

  // Serializes `task` behind every earlier write. A failed task rejects its
  // own caller but never poisons the chain for the next one.
  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  async function persist(next) {
    pruneMessages(next);
    const archived = splitArchivable(next, now(), await archiveDays());
    if (Object.keys(archived).length > 0) {
      const archive = await readArchive();
      for (const [runId, entry] of Object.entries(archived)) archive.runs[runId] = { ...entry, archivedAt: now() };
      await writeJsonAtomic(archivePath, archive);
    }
    await writeJsonAtomic(storePath, next);
  }

  function notify(before, after) {
    for (const listener of listeners) {
      try {
        listener(before, after);
      } catch (err) {
        console.error("agent-tasks: store listener threw:", err);
      }
    }
  }

  return {
    storePath,
    archivePath,

    // A snapshot of the current document. Callers never get the live object,
    // so nothing can mutate state outside update().
    async get() {
      await queue;
      return clone(await ensureLoaded());
    },

    // fn(draft) mutates a copy of the document and returns any value; the
    // copy is saved and becomes the document only if fn does not throw. fn
    // may be async. Resolves with fn's return value.
    update(fn) {
      return enqueue(async () => {
        const before = await ensureLoaded();
        const draft = clone(before);
        const result = await fn(draft);
        await persist(draft);
        doc = draft;
        notify(before, draft);
        return result;
      });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    loadArchive() {
      return enqueue(() => readArchive());
    },

    // Moves one archived run back into the live document. Its activity clock
    // restarts, or the very next save would archive it again.
    restoreRun(runId) {
      return enqueue(async () => {
        const archive = await readArchive();
        const entry = archive.runs[runId];
        if (!entry?.run) return null;
        const before = await ensureLoaded();
        const draft = clone(before);
        const { archivedAt: _archivedAt, ...rest } = entry;
        insertRun(draft, { ...rest, run: { ...rest.run, updatedAt: now(), restoredAt: now() } });
        delete archive.runs[runId];
        await writeJsonAtomic(storePath, draft);
        await writeJsonAtomic(archivePath, archive);
        doc = draft;
        notify(before, draft);
        return draft.runs[runId];
      });
    },

    // Drops every live run, task, dispatch, gate and message. The archive is
    // left alone.
    reset() {
      return enqueue(async () => {
        const before = await ensureLoaded();
        const draft = emptyDocument();
        await writeJsonAtomic(storePath, draft);
        doc = draft;
        notify(before, draft);
      });
    },
  };
}
