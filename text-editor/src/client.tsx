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
}

function TextEditorView({ filePath, active, toolbarTarget, setDirty, fontSize }: Props) {
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
          // A minimap is dead weight on a phone-width tab.
          minimap: { enabled: !matchMedia("(pointer: coarse) and (hover: none)").matches },
          renderWhitespace: "selection",
        });
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());

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

interface SettingsApi {
  get(key: string): unknown;
}

interface ExtensionContext {
  registerFileViewer(v: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: typeof TextEditorView;
  }): void;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: ThemeApi & {
    onDidChangeColorTheme(cb: () => void): () => void;
  };
}

// Deliberately excludes extensions with an existing dedicated bundled viewer
// (json/yml/yaml -> json-preview, md/markdown -> markdown-preview, html/htm
// -> live-preview, csv/tsv -> csv-preview) — a user-installed extension's
// same-extension viewer wins over a bundled one (docs/EXTENSION_API.md), so
// claiming those here would silently shadow the richer built-in previews.
// Add them back via the textEditor.extensions setting if you'd rather have
// plain-text editing for one of them.
const DEFAULT_EXTENSIONS = "ts,tsx,js,jsx,mjs,cjs,css,py,go,rs,sh,txt,toml";

function parseExtensions(raw: unknown): string[] {
  const csv = typeof raw === "string" && raw.trim() ? raw : DEFAULT_EXTENSIONS;
  return csv
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

let removeStylesheet: (() => void) | null = null;
let unsubscribeTheme: (() => void) | null = null;
// Captured at activation, same as removeStylesheet above — TextEditorView is
// registered once via registerFileViewer (not passed ctx as a prop), so the
// component reaches the host's asset resolver and theme API through these.
let hostAssetUrl: ((relPath: string) => string) | null = null;
let hostThemeApi: ThemeApi | null = null;

export function activate(ctx: ExtensionContext): void {
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  hostAssetUrl = ctx.assetUrl;
  hostThemeApi = ctx.app;

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

  const extensions = parseExtensions(ctx.settings.get("textEditor.extensions"));
  const openOnClick = ctx.settings.get("textEditor.openOnClick") === true;
  ctx.registerFileViewer({
    id: "textEditor",
    extensions,
    mode: openOnClick ? "default" : "preview",
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
  hostAssetUrl = null;
  hostThemeApi = null;
}

export type { TokenColorRule };
