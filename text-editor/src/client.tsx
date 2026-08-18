// text-editor: a CodeMirror-based file viewer with syntax highlighting and
// save-back to disk — for a quick edit without a round-trip through nvim.
// Registered "preview" by default (a FILES click still opens nvim; this is
// reached via the hover Preview icon, the context menu, or Shift+Enter);
// textEditor.openOnClick switches it to "default" mode instead.
//
// Grammar bundling: only the everyday languages (js/ts(x), json, css,
// html, markdown, python) are imported and inlined — @codemirror/language-
// data was tried and dropped: this build pipeline has no code-splitting
// (esbuild bundles a single dist/client.js per extension, no outdir+
// splitting), so a dynamic import() of it still gets inlined synchronously
// and its "languages" array statically pulls in ~30 legacy-mode/lang-*
// packages regardless (measured: 2.7MB bundle, vs ~500KB without it). A
// file outside the inline set just renders as plain text — a reasonable,
// honest degradation, not a broken viewer.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import Icon from "./Icon";
import { downloadUrl, fetchFileText, saveFileText } from "./fileApi";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import type { LanguageSupport } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

const MAX_BYTES = 2 * 1024 * 1024;

const INLINE_LANGS: Record<string, () => LanguageSupport> = {
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  css: () => css(),
  html: () => html(),
  htm: () => html(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
};

function extOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  const name = slash === -1 ? filePath : filePath.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

// A file extension outside INLINE_LANGS renders as plain text — see the
// module comment on why this build doesn't lazy-load a broader language set.
function languageFor(filePath: string): LanguageSupport | null {
  const ext = extOf(filePath);
  const inline = INLINE_LANGS[ext];
  return inline ? inline() : null;
}

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

function cmTheme(fontSize?: number) {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: fontSize ? `${fontSize}px` : "var(--terminal-font-size, 13px)",
      backgroundColor: "var(--bg)",
      color: "var(--fg)",
    },
    ".cm-content": {
      fontFamily: "var(--terminal-font, monospace)",
      caretColor: "var(--fg)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--sidebar-header-bg)",
      color: "var(--fg-inactive)",
      border: "none",
    },
    "&.cm-focused": { outline: "none" },
    "&.cm-editor": { height: "100%" },
    ".cm-scroller": { overflow: "auto" },
  });
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
  const viewRef = useRef<EditorView | null>(null);
  const originalRef = useRef<string>("");
  const saveRef = useRef<() => void>(() => {});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);

  const save = useCallback(async () => {
    if (!viewRef.current) return;
    const content = viewRef.current.state.doc.toString();
    setSaving(true);
    setSaveError(null);
    try {
      await saveFileText(filePath, content);
      originalRef.current = content;
      setDirtyState(false);
      setDirty?.(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [filePath, setDirty]);

  useEffect(() => {
    saveRef.current = () => void save();
  }, [save]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaveError(null);

    (async () => {
      const size = await headSize(filePath);
      if (size !== null && size > MAX_BYTES) {
        if (!cancelled) {
          setError("File is too large to edit here (over 2MB) — open it in another viewer.");
          setLoading(false);
        }
        return;
      }
      let text: string;
      try {
        text = await fetchFileText(filePath);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
        return;
      }
      if (looksBinary(text)) {
        if (!cancelled) {
          setError("This file looks binary — open it in another viewer.");
          setLoading(false);
        }
        return;
      }
      const langExt = languageFor(filePath);
      if (cancelled || !containerRef.current) return;

      originalRef.current = text;
      const state = EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          ...(langExt ? [langExt] : []),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                saveRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const isDirty = update.state.doc.toString() !== originalRef.current;
            setDirtyState(isDirty);
            setDirty?.(isDirty);
          }),
          cmTheme(fontSize),
        ],
      });
      viewRef.current?.destroy();
      viewRef.current = new EditorView({ state, parent: containerRef.current });
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fontSize]);

  return (
    <div className={`text-editor-host${active ? "" : " hidden"}`}>
      {error && <div className="text-editor-status text-editor-error">{error}</div>}
      {!error && loading && <div className="text-editor-status">Loading…</div>}
      {!error && <div ref={containerRef} className="text-editor-cm" />}
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

export function activate(ctx: ExtensionContext): void {
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
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
  removeStylesheet?.();
  removeStylesheet = null;
}
