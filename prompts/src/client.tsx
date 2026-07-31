// prompts: a reusable editor tab for `.prompt.md` files.
//
// Three entry points, deliberately leaving the FILES-tree click alone (a
// plain click still opens nvim, and terminal "file:line" links keep their
// line jump — which a file-open interceptor would have swallowed):
//   • "Prompts: New Prompt" command  → an Untitled draft tab
//   • FILES-tree "Edit Prompt" item  → the editor for an existing prompt
//   • host-side re-opens of the same (viewer, path) reuse the same tab
//
// Refine and the first save's filename both go through this extension's own
// server hook to a local AI CLI; file content itself moves over the host's
// existing /api/download and /api/upload routes (no file routes here).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import { fetchFileText, fileExists, makeDir, NotFoundError, saveFileText } from "./fileApi";

const PROMPT_SUFFIX = ".prompt.md";
const DRAFT_BASENAME = `Untitled${PROMPT_SUFFIX}`;
const DEFAULT_DIRECTORY = "plans/prompts";

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
let refreshFiles: (() => void) | null = null;
let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;

const NO_CONTEXT: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
let activeContext: ActiveContext = NO_CONTEXT;

function promptsDir(): string {
  const raw = extSettings?.get("prompts.directory");
  const value = typeof raw === "string" ? raw.trim().replace(/^\/+|\/+$/g, "") : "";
  return value || DEFAULT_DIRECTORY;
}

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

// The draft tab's path for a given working directory. It encodes where the
// prompt will be saved, which is what lets one draft per session coexist
// (each gets its own tab) and what saveDraft reads back instead of trusting
// whichever session happens to be focused at Save time.
function draftPathFor(cwd: string): string {
  return `${cwd}/${promptsDir()}/${DRAFT_BASENAME}`;
}

function dirnameOf(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash <= 0 ? "/" : p.slice(0, slash);
}

// A draft tab is the one path this extension opens without a file behind it;
// its save flow (name it, write it elsewhere, then show the saved notice) is
// what distinguishes it from editing an existing prompt in place.
function isDraftPath(p: string): boolean {
  return basenameOf(p) === DRAFT_BASENAME;
}

// Fallback for naming a draft when the AI call fails: the prompt's own first
// words, reduced to the same slug shape the server enforces.
function slugFromContent(content: string): string {
  const words = content
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.join("-").slice(0, 60).replace(/-+$/g, "") || "untitled-prompt";
}

function sanitizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.(prompt\.)?md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- Server routes ----

async function callAi<T extends object>(route: string, content: string): Promise<T> {
  if (!serverFetch) throw new Error("extension not active");
  const res = await serverFetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  if (!body) throw new Error("empty response");
  return body;
}

async function refinePrompt(content: string): Promise<string> {
  const body = await callAi<{ text?: string }>("/refine", content);
  if (!body.text) throw new Error("no refined prompt returned");
  return body.text;
}

async function suggestName(content: string): Promise<string> {
  const body = await callAi<{ name?: string }>("/suggest-name", content);
  const name = sanitizeName(body.name ?? "");
  if (!name) throw new Error("no usable filename returned");
  return name;
}

// ---- Name dialog (collision / AI failure only) ----
// Mounted into a root this extension owns (host's react-dom/client via the
// build shim), so it works regardless of which tab is on screen.

function NameDialog({
  initialName,
  message,
  dir,
  resolve,
}: {
  initialName: string;
  message: string | null;
  dir: string;
  resolve: (name: string | null) => void;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(message);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    const clean = sanitizeName(name);
    if (!clean) {
      setError("Enter a name using letters, numbers, or hyphens.");
      return;
    }
    setChecking(true);
    setError(null);
    if (await fileExists(`${dir}/${clean}${PROMPT_SUFFIX}`)) {
      setChecking(false);
      setError(`"${clean}${PROMPT_SUFFIX}" already exists — pick another name.`);
      return;
    }
    resolve(clean);
  };

  return (
    <div
      className="prompts-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) resolve(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") resolve(null);
      }}
    >
      <div className="prompts-dialog" role="dialog" aria-label="Save prompt">
        <div className="prompts-dialog-title">Save prompt as</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="prompts-field">
            <span>File name</span>
            <div className="prompts-name-row">
              <input
                className="prompts-input"
                autoFocus
                value={name}
                disabled={checking}
                onChange={(e) => setName(e.target.value)}
              />
              <span className="prompts-suffix">{PROMPT_SUFFIX}</span>
            </div>
          </label>
          <div className="prompts-dialog-path">{dir}/</div>
          {error && <div className="prompts-error">{error}</div>}
          <div className="prompts-dialog-buttons">
            <button type="button" className="prompts-button" onClick={() => resolve(null)}>
              Cancel
            </button>
            <button type="submit" className="prompts-button primary" disabled={checking}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function askForName(initialName: string, message: string | null, dir: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (name: string | null) => {
      root.unmount();
      host.remove();
      resolvePromise(name);
    };
    root.render(<NameDialog initialName={initialName} message={message} dir={dir} resolve={done} />);
  });
}

// ---- Editor ----

interface FileViewerHostProps {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
  setDirty?: (dirty: boolean) => void;
  fontSize?: number;
}

// Where a just-saved draft parks: the tab can't close itself (extensions have
// no close-tab API), so it goes clean and read-only with a pointer to the
// real file instead of silently keeping a duplicate of its content.
interface SavedState {
  path: string;
  name: string;
}

function PromptEditor({ filePath, active, toolbarTarget, openInEditor, setDirty, fontSize }: FileViewerHostProps) {
  const draft = isDraftPath(filePath);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState<null | "refine" | "save">(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedState | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Read inside async flows that must not act on a stale render's value.
  const contentRef = useRef(content);
  contentRef.current = content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const text = await fetchFileText(filePath);
      setContent(text);
      setError(null);
    } catch (err) {
      if (err instanceof NotFoundError) {
        // The draft path is never written, and a prompt can also be opened
        // before it exists — both mean "start empty", not an error.
        setContent("");
        setError(null);
      } else {
        setError(errorText(err));
      }
    } finally {
      setLoading(false);
      setDirtyState(false);
    }
  }, [filePath]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setDirty?.(dirty);
  }, [dirty, setDirty]);

  // Reload-on-focus: coming back to a clean tab picks up edits made in nvim
  // (or by an agent) since it was last read. Never while dirty — the user's
  // unsaved text always wins — and never over a draft or a saved notice,
  // which have no file behind them.
  const wasActive = useRef(active);
  useEffect(() => {
    const becameActive = active && !wasActive.current;
    wasActive.current = active;
    if (becameActive && !dirtyRef.current && !draft && !saved) void load();
  }, [active, draft, saved, load]);

  const update = (text: string) => {
    setContent(text);
    setDirtyState(true);
    setSaved(null);
    setSavedAt(null);
  };

  const refine = async () => {
    const text = contentRef.current.trim();
    if (!text || busy) return;
    setBusy("refine");
    setError(null);
    try {
      const refined = await refinePrompt(text);
      setContent(refined);
      setDirtyState(true);
      setSaved(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  // Writes to `target`, then reports it. Shared by both save paths so the
  // directory-creation and refresh behavior can't drift between them.
  const writeTo = async (target: string) => {
    const dir = dirnameOf(target);
    // mkdir -p the target's own directory (the host's mkdir route resolves
    // <parent>/<name> and creates the whole chain), so a first save into a
    // not-yet-existing prompts folder works. Derived from the path itself,
    // never from the active session: a draft opened for another tab group
    // must land in *that* group's directory, whichever session is focused
    // when Save is pressed.
    await makeDir(dirnameOf(dir), basenameOf(dir));
    await saveFileText(target, contentRef.current);
    refreshFiles?.();
  };

  const saveDraft = async () => {
    // The draft's own path carries the directory it was opened for — see
    // the New Prompt command and the tab-group menu item, which both build
    // it from a specific session's cwd.
    const dir = dirnameOf(filePath);
    if (dir === "/" || !dir) {
      setError("No active session — open a terminal tab so the prompt has a directory to save into.");
      return;
    }
    const text = contentRef.current;

    // Ask the AI for a name; fall back to the prompt's own first words. Only
    // a clean, unused name saves straight through — anything else routes to
    // the dialog so the user names it themselves.
    let name: string | null = null;
    let dialogMessage: string | null = null;
    try {
      name = await suggestName(text);
    } catch (err) {
      name = slugFromContent(text);
      dialogMessage = `Couldn't get a suggested name (${errorText(err)}). Pick one yourself.`;
    }
    if (!dialogMessage && (await fileExists(`${dir}/${name}${PROMPT_SUFFIX}`))) {
      dialogMessage = `"${name}${PROMPT_SUFFIX}" already exists — pick another name.`;
    }
    if (dialogMessage) {
      const chosen = await askForName(name, dialogMessage, dir);
      if (!chosen) return;
      name = chosen;
    }

    const target = `${dir}/${name}${PROMPT_SUFFIX}`;
    await writeTo(target);
    // The draft tab stays open (no close-tab API) — park it on a notice
    // naming the file, clean so closing it never prompts, and open the real
    // file in its own tab.
    setDirtyState(false);
    setSaved({ path: target, name: `${name}${PROMPT_SUFFIX}` });
    openViewerTab?.("promptEditor", target);
  };

  const save = async () => {
    if (busy || !contentRef.current.trim()) return;
    setBusy("save");
    setError(null);
    try {
      if (draft) {
        await saveDraft();
      } else {
        await writeTo(filePath);
        setDirtyState(false);
        setSavedAt(new Date().toLocaleTimeString());
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const dismissSaved = () => {
    setSaved(null);
    setSavedAt(null);
    setContent("");
    setDirtyState(false);
  };

  const toolbar = (
    <>
      <button
        className="icon-button"
        title="Refine this prompt with AI"
        disabled={busy !== null || !content.trim() || saved !== null}
        onClick={() => void refine()}
      >
        {busy === "refine" ? "Refining…" : "Refine"}
      </button>
      <button
        className="icon-button"
        title="Save"
        disabled={busy !== null || !content.trim() || saved !== null || (!dirty && !draft)}
        onClick={() => void save()}
      >
        {busy === "save" ? "Saving…" : "Save"}
      </button>
      {!draft && (
        <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
          Open in Editor
        </button>
      )}
    </>
  );

  return (
    <div className="prompts-editor" style={fontSize ? { fontSize: `${fontSize}px` } : undefined}>
      {active && toolbarTarget && createPortal(toolbar, toolbarTarget)}
      <div className="prompts-editor-header">
        <span className="prompts-editor-path">
          {saved ? "Prompt saved" : draft ? "New prompt (unsaved)" : filePath}
        </span>
        {dirty && <span className="prompts-badge">unsaved</span>}
        {savedAt && !dirty && <span className="prompts-badge saved">saved {savedAt}</span>}
      </div>
      {error && <div className="prompts-error prompts-error-bar">{error}</div>}
      {saved ? (
        <div className="prompts-saved-notice">
          <div className="prompts-saved-title">Saved as {saved.name}</div>
          <div className="prompts-saved-path">{saved.path}</div>
          <p className="prompts-saved-hint">
            It's open in its own tab now. This draft tab can be closed, or reused for another prompt.
          </p>
          <button className="prompts-button primary" onClick={dismissSaved}>
            Write another prompt
          </button>
        </div>
      ) : (
        <textarea
          className="prompts-textarea"
          value={content}
          disabled={loading || busy === "refine"}
          spellCheck={false}
          placeholder={
            loading ? "Loading…" : "Write your prompt here, then press Refine to have the AI tighten it up."
          }
          onChange={(e) => update(e.target.value)}
        />
      )}
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerCommand(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    editorFallback?: boolean;
    component: ComponentType<FileViewerHostProps>;
  }): void;
  // Host API added alongside this extension (tmux-server core): contributes
  // an item to the FILES-tree context menu. Optional so an older host simply
  // loses the "Edit Prompt" entry instead of failing to activate.
  registerFileMenuItem?(item: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    isVisible: (path: string, isDir: boolean) => boolean;
    onClick: (path: string) => void;
  }): void;
  // Likewise optional: a tab group's chip menu. ctx is { sessionName, cwd },
  // cwd being that session's active window's directory.
  registerTabGroupMenuItem?(item: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    isVisible: (ctx: { sessionName: string; cwd: string | null }) => boolean;
    onClick: (ctx: { sessionName: string; cwd: string | null }) => void;
  }): void;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
    refreshFiles(): void;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  openViewerTab = ctx.app.openViewerTab.bind(ctx.app);
  refreshFiles = ctx.app.refreshFiles.bind(ctx.app);
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  // extensions: [] — never matched from a file extension; every open goes
  // through openViewerTab, so plain FILES-tree clicks keep their existing
  // behavior (nvim for .md) and the markdown preview stays reachable.
  ctx.registerFileViewer({
    id: "promptEditor",
    extensions: [],
    component: PromptEditor,
  });

  ctx.registerCommand({
    id: "newPrompt",
    label: "Prompts: New Prompt",
    run: () => {
      const cwd = activeContext.cwd;
      // With no active session there's nowhere to save: open the draft
      // anyway, at a path whose missing directory makes the editor explain
      // that in context — this extension has no toast API of its own.
      openViewerTab?.("promptEditor", cwd ? draftPathFor(cwd) : `/${DRAFT_BASENAME}`, {
        title: "New Prompt",
      });
    },
  });

  ctx.registerFileMenuItem?.({
    id: "edit",
    label: "Edit Prompt",
    icon: "edit",
    isVisible: (path, isDir) => !isDir && path.endsWith(PROMPT_SUFFIX),
    onClick: (path) => openViewerTab?.("promptEditor", path),
  });

  // Same action from a tab group's chip menu, but scoped to that group's own
  // session rather than whichever one is focused — the draft path carries
  // the directory, so saving lands in that session's tree.
  ctx.registerTabGroupMenuItem?.({
    id: "newPromptHere",
    label: "New Prompt Here",
    icon: "add",
    isVisible: ({ cwd }) => Boolean(cwd),
    onClick: ({ cwd }) => {
      if (cwd) openViewerTab?.("promptEditor", draftPathFor(cwd), { title: "New Prompt" });
    },
  });

  activeContext = ctx.app.getActiveContext();
  removeContextListener = ctx.app.onDidChangeContext((next) => {
    activeContext = next;
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  removeContextListener?.();
  removeContextListener = null;
  serverFetch = null;
  openViewerTab = null;
  refreshFiles = null;
  extSettings = null;
  activeContext = NO_CONTEXT;
}
