// One Monaco text model per file path, shared by every tab showing that path.
//
// Splitting an editor tab (Ctrl+\) mounts a second TextEditorView for the same
// file; both attach to the model kept here, so the two panes edit one document
// live — VS Code's split-editor behavior — instead of drifting apart until one
// overwrites the other. Dirty state therefore belongs to the *file*, not the
// tab: `listeners` fans model edits and saves out to every attached view, which
// each report to their own tab host.
//
// The registry owns the model's lifetime through ref-counting. Disposing a
// standalone editor never disposes a model passed in through `create`'s
// options (standaloneCodeEditor.js sets `_ownsModel = false` in that case), so
// releasing the last view here is what actually frees it — and makes the next
// open re-read the file from disk.
import type { MonacoNs, TextModel } from "./monacoNs";

export interface FileEntry {
  readonly filePath: string;
  /** Resolves with the shared model, or rejects with the load error. */
  ready: Promise<TextModel>;
  model: TextModel | null;
  /** Last known on-disk content: the baseline `dirty` is measured against. */
  savedText: string;
  refs: number;
  disposed: boolean;
  listeners: Set<() => void>;
}

const entries = new Map<string, FileEntry>();

// File extension -> Monaco language id, for the everyday cases where the
// mapping isn't just the extension itself. Anything not listed falls back to
// Monaco's own registered extensions (covering the ~80 bundled grammars), then
// to plain text.
const MONACO_LANGUAGE_FOR: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  txt: "plaintext",
};

export function extOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  const name = slash === -1 ? filePath : filePath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function languageFor(monaco: MonacoNs, filePath: string): string {
  const ext = extOf(filePath);
  const mapped = MONACO_LANGUAGE_FOR[ext];
  if (mapped) return mapped;
  if (ext) {
    const match = monaco.languages.getLanguages().find((lang) => lang.extensions?.includes(`.${ext}`));
    if (match) return match.id;
  }
  return "plaintext";
}

function notify(entry: FileEntry): void {
  for (const listener of [...entry.listeners]) listener();
}

export function isDirty(entry: FileEntry): boolean {
  return entry.model !== null && entry.model.getValue() !== entry.savedText;
}

/** Records a successful save as the new baseline and tells every attached view. */
export function markSaved(entry: FileEntry, text: string): void {
  entry.savedText = text;
  notify(entry);
}

/**
 * Attaches to (or creates) the shared entry for `filePath`. `load` runs only
 * for the first caller; later callers await the same promise, so a split pane
 * never re-fetches the file. Always pair with the returned `release`.
 */
export function acquireFile(
  monaco: MonacoNs,
  filePath: string,
  load: () => Promise<string>,
): { entry: FileEntry; release: () => void } {
  let entry = entries.get(filePath);
  if (!entry) {
    const created: FileEntry = {
      filePath,
      model: null,
      savedText: "",
      refs: 0,
      disposed: false,
      listeners: new Set(),
      // Assigned immediately below; the async body needs `created` in scope.
      ready: undefined as unknown as Promise<TextModel>,
    };
    created.ready = (async () => {
      const text = await load();
      if (created.disposed) throw new Error("The editor tab was closed while the file was loading.");
      const uri = monaco.Uri.file(filePath);
      // An existing model for this URI can only be an orphan from a previous
      // load whose disposal didn't run (the registry is the sole creator, and
      // it deletes its entry on release) — replace it rather than fail the
      // createModel call with "model already exists".
      monaco.editor.getModel(uri)?.dispose();
      const model = monaco.editor.createModel(text, languageFor(monaco, filePath), uri);
      if (created.disposed) {
        model.dispose();
        throw new Error("The editor tab was closed while the file was loading.");
      }
      created.model = model;
      created.savedText = text;
      model.onDidChangeContent(() => notify(created));
      return model;
    })();
    // A failed load must not strand a permanently-rejected entry in the map, or
    // re-opening the file would replay the old error without retrying.
    created.ready.catch(() => {
      if (entries.get(filePath) === created) entries.delete(filePath);
    });
    entries.set(filePath, created);
    entry = created;
  }

  const acquired = entry;
  acquired.refs++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    acquired.refs--;
    if (acquired.refs > 0) return;
    acquired.disposed = true;
    acquired.listeners.clear();
    acquired.model?.dispose();
    acquired.model = null;
    if (entries.get(filePath) === acquired) entries.delete(filePath);
  };
  return { entry: acquired, release };
}

/** Drops every shared model — for the extension's own deactivate(). */
export function disposeAllFiles(): void {
  for (const entry of entries.values()) {
    entry.disposed = true;
    entry.listeners.clear();
    entry.model?.dispose();
    entry.model = null;
  }
  entries.clear();
}
