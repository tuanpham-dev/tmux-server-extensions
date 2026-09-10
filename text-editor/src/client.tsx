// text-editor: a Monaco-based file viewer — the VS Code editor, with its find
// widget, multi-cursor, folding and IntelliSense — plus save-back to disk, for
// a quick edit without a round-trip through nvim. Registered "preview" by
// default (a FILES click still opens nvim; this is reached via the hover
// Preview icon, the context menu, or Shift+Enter); textEditor.openOnClick
// switches it to "default" mode instead.
//
// Only this file and its small siblings are loaded eagerly at activation.
// Monaco itself arrives from dist/chunks/monaco.js the first time a tab mounts
// (monacoLoader.ts), and each language service's worker is fetched by Monaco on
// demand from dist/workers/ — so the cost of having this extension enabled but
// unused is a few KB.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import Icon from "./Icon";
import { downloadUrl, fetchFileText, saveFileText } from "./fileApi";
import { loadMonaco, refreshTheme, unloadMonaco, type ThemeApi } from "./monacoLoader";
import type { StandaloneEditor } from "./monacoNs";
import { acquireFile, disposeAllFiles, isDirty, markSaved, type FileEntry } from "./models";
import type { TokenColorRule } from "./shikiTheme";
import {
  registerDiffRequest,
  registerMergeRequest,
  setFileRequest,
  takeFileRequest,
  type DiffRequest,
  type MergeRequest,
} from "./requests";
import DiffEditorView from "./DiffEditorView";
import MergeView from "./MergeView";
import { clearHost, hostAssetUrl, hostCanPreview, hostOpenPreview, hostThemeApi, setHost } from "./host";
import { clearSettingsApi, minimapEnabled, onSettingsChange, setSettingsApi } from "./settings";

const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FONT_SIZE = 13;

// Monaco asks for a worker by language-service label; anything unlisted (the
// plain editor services: diff, links, word-based suggestions) gets the core
// editor worker.
const WORKER_FOR: Record<string, string> = {
  json: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  handlebars: "html",
  razor: "html",
  typescript: "ts",
  javascript: "ts",
};

async function headSize(filePath: string): Promise<number | null> {
  try {
    const res = await fetch(downloadUrl(filePath), { method: "HEAD" });
    const len = res.headers.get("content-length");
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes("\0");
}

// The guards run before the model is created, so a refusal never leaves a
// half-loaded editor behind — and because they live in the loader passed to
// acquireFile, a second tab on the same path inherits the same verdict.
async function loadFileText(filePath: string): Promise<string> {
  const size = await headSize(filePath);
  if (size !== null && size > MAX_BYTES) {
    throw new Error("File is too large to edit here (over 2MB) — open it in another viewer.");
  }
  const text = await fetchFileText(filePath);
  if (looksBinary(text)) {
    throw new Error("This file looks binary — open it in another viewer.");
  }
  return text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  setDirty?: (dirty: boolean) => void;
  fontSize?: number;
  // Bumped by the host each time an explicit open re-targets this already-open
  // tab — how a second "file:line" jump into the same file arrives.
  reloadKey?: number;
}

function TextEditorView({ filePath, active, toolbarTarget, setDirty, fontSize, reloadKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<StandaloneEditor | null>(null);
  const entryRef = useRef<FileEntry | null>(null);
  const saveRef = useRef<() => void>(() => {});
  // Read inside the mount effect, which deliberately doesn't re-run for these:
  // a font-size change updates options in place, and the host's setDirty
  // identity must never be able to force a reload of the file.
  const fontSizeRef = useRef(fontSize);
  const setDirtyRef = useRef(setDirty);
  fontSizeRef.current = fontSize;
  setDirtyRef.current = setDirty;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);

  // Whether some other extension can render this file — Markdown, JSON/YAML,
  // CSV. In a tmux pane there was nowhere to put this; a tab has a toolbar.
  const canPreview = hostCanPreview?.(filePath) ?? false;

  const save = useCallback(async () => {
    const entry = entryRef.current;
    if (!entry?.model) return;
    const content = entry.model.getValue();
    setSaving(true);
    setSaveError(null);
    try {
      await saveFileText(filePath, content);
      // Shared baseline: a save in either split pane clears the dirty flag in
      // both, since they are the same document.
      markSaved(entry, content);
    } catch (err) {
      setSaveError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }, [filePath]);

  useEffect(() => {
    saveRef.current = () => void save();
  }, [save]);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    let teardownEditor: (() => void) | null = null;
    setLoading(true);
    setError(null);
    setSaveError(null);

    (async () => {
      try {
        if (!hostAssetUrl || !hostThemeApi) throw new Error("The Text Editor extension is not active.");
        const monaco = await loadMonaco(hostAssetUrl, hostThemeApi);
        if (cancelled) return;

        const acquired = acquireFile(monaco, filePath, () => loadFileText(filePath));
        release = acquired.release;
        entryRef.current = acquired.entry;
        const model = await acquired.entry.ready;
        if (cancelled || !containerRef.current) return;

        const editor = monaco.editor.create(containerRef.current, {
          model,
          // The host keeps inactive tabs mounted but hidden, so the editor has
          // no size until its tab is revealed; automaticLayout picks that up
          // (the `active` effect below re-measures immediately as a belt-and-
          // braces for the reveal frame).
          automaticLayout: true,
          scrollBeyondLastLine: false,
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--terminal-font").trim() || "monospace",
          fontSize: fontSizeRef.current ?? DEFAULT_FONT_SIZE,
          minimap: { enabled: minimapEnabled() },
          renderWhitespace: "selection",
        });
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());

        // A "file:line" open (terminal ctrl+click, a quick-switcher jump)
        // parks its line number in requests.ts — the viewer path alone can't
        // carry it. Also re-read on reloadKey below, since re-opening an
        // already-open tab is how a second jump arrives.
        const jump = takeFileRequest(filePath)?.line;
        if (jump !== undefined) {
          editor.revealLineInCenter(jump);
          editor.setPosition({ lineNumber: jump, column: 1 });
        }

        const sync = () => {
          const nowDirty = isDirty(acquired.entry);
          setDirtyState(nowDirty);
          setDirtyRef.current?.(nowDirty);
        };
        acquired.entry.listeners.add(sync);
        sync();

        teardownEditor = () => {
          acquired.entry.listeners.delete(sync);
          editor.dispose();
        };
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(messageOf(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      teardownEditor?.();
      editorRef.current = null;
      entryRef.current = null;
      release?.();
    };
  }, [filePath]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: fontSize ?? DEFAULT_FONT_SIZE });
  }, [fontSize]);

  useEffect(() => {
    if (active) editorRef.current?.layout();
  }, [active]);

  // Settings → Text Editor → Minimap applies to open tabs immediately, the
  // same way a theme change does.
  useEffect(
    () =>
      onSettingsChange(() => {
        editorRef.current?.updateOptions({ minimap: { enabled: minimapEnabled() } });
      }),
    [],
  );

  // A re-open of this same tab (see reloadKey) may carry a fresh line to jump
  // to; the mount effect above handles the first one.
  useEffect(() => {
    const jump = takeFileRequest(filePath)?.line;
    const editor = editorRef.current;
    if (jump === undefined || !editor) return;
    editor.revealLineInCenter(jump);
    editor.setPosition({ lineNumber: jump, column: 1 });
  }, [filePath, reloadKey]);

  return (
    <div className={`text-editor-host${active ? "" : " hidden"}`}>
      {error && <div className="text-editor-status text-editor-error">{error}</div>}
      {!error && loading && <div className="text-editor-status">Loading editor…</div>}
      {!error && <div ref={containerRef} className="text-editor-monaco" />}
      {active &&
        toolbarTarget &&
        createPortal(
          <>
            {dirty && <span className="text-editor-dirty-dot" title="Unsaved changes" />}
            {canPreview && (
              <button
                className="icon-button"
                title="Open Preview"
                onClick={() => hostOpenPreview?.(filePath)}
              >
                <Icon name="open-preview" />
              </button>
            )}
            <button
              className="icon-button"
              title={saveError ? `Save failed: ${saveError}` : "Save (Ctrl+S)"}
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              <Icon name="save" />
            </button>
          </>,
          toolbarTarget,
        )}
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerFileViewer(v: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: typeof TextEditorView | typeof DiffEditorView | typeof MergeView;
  }): void;
  // Present only on hosts that support the pluggable `editor` setting — this
  // extension feature-detects it and falls back to being a preview viewer,
  // which is all it ever was before.
  registerEditor?(editor: {
    id: string;
    label: string;
    capabilities: ("file" | "diff" | "merge")[];
    openFile(path: string, line?: number): Promise<void>;
    openDiff?(req: DiffRequest): Promise<void>;
    openMerge?(req: MergeRequest): Promise<void>;
  }): void;
  assetUrl(relPath: string): string;
  settings: {
    get(key: string): unknown;
    onDidChange(cb: () => void): () => void;
  };
  app: ThemeApi & {
    onDidChangeColorTheme(cb: () => void): () => void;
    openViewerTab?(viewerId: string, path: string, opts?: { title?: string }): void;
    canPreview?(path: string): boolean;
    openPreview?(path: string): void;
    openDiff?(req: DiffRequest): Promise<boolean>;
  };
}

// Only used on a host too old to have the `editor` setting, where this
// extension can't *be* the editor and falls back to being a preview viewer —
// see activate(). Omits the extensions that already have a dedicated bundled
// preview (json/yml/yaml, md/markdown, html/htm, csv/tsv): a user-installed
// viewer beats a bundled one, so claiming those would shadow the richer
// built-ins.
const LEGACY_PREVIEW_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "less", "py", "go", "rs", "sh", "bash", "zsh",
  "txt", "toml", "ini", "conf", "java", "c", "h", "cpp", "hpp", "cs", "rb", "php", "sql", "lua", "swift",
  "kt", "pl", "graphql", "vue", "ps1", "zig", "ex", "exs", "hs", "clj", "scala", "dart", "jl", "groovy",
  "gradle", "cmake", "vim", "tex", "prisma", "sol", "erl", "xml", "proto", "diff", "patch",
];

let removeStylesheet: (() => void) | null = null;
let unsubscribeTheme: (() => void) | null = null;

export function activate(ctx: ExtensionContext): void {
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  setSettingsApi(ctx.settings);
  // Viewers are registered by class, so they reach the host through host.ts
  // rather than a prop — see that module.
  setHost({
    assetUrl: ctx.assetUrl,
    themeApi: ctx.app,
    openDiff: ctx.app.openDiff,
    canPreview: ctx.app.canPreview,
    openPreview: ctx.app.openPreview,
  });

  // Monaco spawns its language-service workers itself; this is the only hook it
  // gives for saying where the scripts live. They're same-origin (the host's
  // extension file route) and built as ES modules, so no blob/importScripts
  // shim is needed.
  (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      const name = WORKER_FOR[label] ?? "editor";
      return new Worker(ctx.assetUrl(`dist/workers/${name}.worker.js`), { type: "module" });
    },
  };

  // Re-tokenizes and recolors every open editor in place; a no-op until the
  // first editor tab has actually loaded Monaco.
  unsubscribeTheme = ctx.app.onDidChangeColorTheme(() => refreshTheme(ctx.app));

  if (typeof ctx.registerEditor === "function") {
    // The host owns routing entirely. Selected in Settings → Editor, this
    // editor gets every file the app would otherwise send to nvim; not
    // selected, it gets nothing — exactly the deal nvim itself has. So the
    // viewers below claim no file extensions and are reached only through
    // openViewerTab, from the callbacks here.
    ctx.registerEditor({
      id: "monaco",
      label: "Monaco (Text Editor)",
      capabilities: ["file", "diff", "merge"],
      openFile: async (path, line) => {
        if (line !== undefined) setFileRequest(path, { line });
        ctx.app.openViewerTab?.("textEditor", path);
      },
      openDiff: async (req: DiffRequest) => {
        // The tab's "path" is a minted key: a diff has no single path, and
        // one key per open means two diffs of the same file coexist.
        ctx.app.openViewerTab?.("diff", registerDiffRequest(req), { title: req.title });
      },
      openMerge: async (req: MergeRequest) => {
        ctx.app.openViewerTab?.("merge", registerMergeRequest(req), { title: req.title });
      },
    });
    ctx.registerFileViewer({ id: "textEditor", extensions: [], component: TextEditorView });
    ctx.registerFileViewer({ id: "diff", extensions: [], component: DiffEditorView });
    ctx.registerFileViewer({ id: "merge", extensions: [], component: MergeView });
    return;
  }

  // Host with no `editor` setting: nothing can select this editor, so fall
  // back to what it was before — a preview viewer reached through the
  // FILES-tree hover icon, the "Preview" menu item, or Shift+Enter.
  ctx.registerFileViewer({
    id: "textEditor",
    extensions: LEGACY_PREVIEW_EXTENSIONS,
    mode: "preview",
    component: TextEditorView,
  });
}

export function deactivate(): void {
  unsubscribeTheme?.();
  unsubscribeTheme = null;
  removeStylesheet?.();
  removeStylesheet = null;
  disposeAllFiles();
  unloadMonaco();
  delete (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment;
  clearHost();
  clearSettingsApi();
}

export type { TokenColorRule };
