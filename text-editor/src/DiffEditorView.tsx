// Monaco's diff editor, for the `editor` setting's "diff" capability — what
// the app opens when a Source Control row is clicked and this editor is
// selected. The git extension resolves both sides to text and hands them over
// through ctx.app.openDiff (see requests.ts for how the request reaches here);
// nothing in this file knows about git.
//
// The modified side is editable exactly when the request carries a `path` —
// a real working file. Otherwise it's index or HEAD content that exists
// nowhere on disk, and readOnlyReason (when the sender set one) says why the
// side is locked rather than leaving the user poking at an inert pane.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { saveFileText } from "./fileApi";
import { loadMonaco } from "./monacoLoader";
import type { CodeEditor, StandaloneDiffEditor, TextModel } from "./monacoNs";
import { languageFor } from "./models";
import { getDiffRequest, type DiffRequest } from "./requests";
import { hostAssetUrl, hostCloseViewerTab, hostThemeApi } from "./host";
import { onSettingsChange, vimEnabled } from "./settings";
import { useVimMode } from "./vim";

const DEFAULT_FONT_SIZE = 13;

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  setDirty?: (dirty: boolean) => void;
  fontSize?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function DiffEditorView({ filePath, active, toolbarTarget, setDirty, fontSize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<StandaloneDiffEditor | null>(null);
  // Only the modified pane gets vim, and only when it is editable; the original
  // side is read-only, where a modal layer would just swallow keys.
  const modifiedRef = useRef<CodeEditor | null>(null);
  const modelsRef = useRef<{ original: TextModel; modified: TextModel } | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const fontSizeRef = useRef(fontSize);
  const setDirtyRef = useRef(setDirty);
  fontSizeRef.current = fontSize;
  setDirtyRef.current = setDirty;

  // Read out of the registry once per path and kept here afterwards, so a
  // re-render never has to go back to a shared mutable map mid-life.
  const requestRef = useRef<{ key: string; value: DiffRequest | undefined }>({ key: "", value: undefined });
  if (requestRef.current.key !== filePath) {
    requestRef.current = { key: filePath, value: getDiffRequest(filePath) };
  }
  const request = requestRef.current.value;
  const editablePath = request?.modified.path;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  // Side-by-side on a desktop pane, inline where there isn't room for two
  // columns — and a toolbar toggle either way, as VS Code has.
  const [sideBySide, setSideBySide] = useState(() => !matchMedia("(pointer: coarse) and (hover: none)").matches);
  // See TextEditorView for why the editor is counted and the status node held
  // in state rather than read off a ref during render.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [vimOn, setVimOn] = useState(() => vimEnabled());
  const [vimStatusNode, setVimStatusNode] = useState<HTMLDivElement | null>(null);

  // Resolves true when the file is on disk — see TextEditorView's save for why
  // vim's `:wq` needs the answer.
  const save = useCallback(async (): Promise<boolean> => {
    const models = modelsRef.current;
    if (!models || !editablePath) return false;
    const content = models.modified.getValue();
    setSaving(true);
    setSaveError(null);
    try {
      await saveFileText(editablePath, content);
      setDirtyState(false);
      setDirtyRef.current?.(false);
      // The saved text is the new baseline: further edits are dirty again,
      // but this exact content isn't.
      savedTextRef.current = content;
      return true;
    } catch (err) {
      setSaveError(messageOf(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [editablePath]);

  const savedTextRef = useRef<string>("");

  useEffect(() => {
    saveRef.current = () => void save();
  }, [save]);

  useEffect(() => {
    let cancelled = false;
    let teardown: (() => void) | null = null;
    setLoading(true);
    setError(null);
    setSaveError(null);

    (async () => {
      try {
        if (!request) throw new Error("This diff is no longer available - reopen it from Source Control.");
        if (!hostAssetUrl || !hostThemeApi) throw new Error("The Text Editor extension is not active.");
        const monaco = await loadMonaco(hostAssetUrl, hostThemeApi);
        if (cancelled || !containerRef.current) return;

        // Language comes from whichever side names a real file; a label like
        // "HEAD" carries the extension too (see the server's diff-sides), but
        // the path is the reliable one.
        const language = languageFor(monaco, request.modified.path ?? request.modified.label);
        const original = monaco.editor.createModel(request.original.content, language);
        const modified = monaco.editor.createModel(request.modified.content, language);
        modelsRef.current = { original, modified };
        savedTextRef.current = request.modified.content;

        const editor = monaco.editor.createDiffEditor(containerRef.current, {
          automaticLayout: true,
          scrollBeyondLastLine: false,
          renderSideBySide: sideBySide,
          readOnly: !request.modified.path,
          originalEditable: false,
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--terminal-font").trim() || "monospace",
          fontSize: fontSizeRef.current ?? DEFAULT_FONT_SIZE,
          minimap: { enabled: false },
        });
        editor.setModel({ original, modified });
        editorRef.current = editor;

        if (request.modified.path) {
          modifiedRef.current = editor.getModifiedEditor();
          setEditorEpoch((n) => n + 1);
          editor.getModifiedEditor().addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
          const sub = modified.onDidChangeContent(() => {
            const isDirty = modified.getValue() !== savedTextRef.current;
            setDirtyState(isDirty);
            setDirtyRef.current?.(isDirty);
          });
          teardown = () => sub.dispose();
        }
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
      teardown?.();
      editorRef.current?.dispose();
      editorRef.current = null;
      modifiedRef.current = null;
      // The diff editor never owns models passed through setModel, so both are
      // this component's to dispose.
      modelsRef.current?.original.dispose();
      modelsRef.current?.modified.dispose();
      modelsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: fontSize ?? DEFAULT_FONT_SIZE });
  }, [fontSize]);

  useEffect(() => {
    if (active) editorRef.current?.layout();
  }, [active]);

  useEffect(() => onSettingsChange(() => setVimOn(vimEnabled())), []);

  useVimMode(
    modifiedRef.current,
    vimStatusNode,
    {
      save: () => save(),
      close: () => hostCloseViewerTab?.("diff", filePath),
      isDirty: () => dirty,
    },
    editorEpoch,
  );

  const readOnlyNote = !editablePath ? request?.modified.readOnlyReason : undefined;

  return (
    <div className={`text-editor-host${active ? "" : " hidden"}`}>
      {error && <div className="text-editor-status text-editor-error">{error}</div>}
      {!error && loading && <div className="text-editor-status">Loading editor…</div>}
      {!error && readOnlyNote && <div className="text-editor-status">{readOnlyNote}</div>}
      {!error && <div ref={containerRef} className="text-editor-monaco" />}
      {!error && vimOn && editablePath && <div ref={setVimStatusNode} className="text-editor-vim-status" />}
      {active &&
        toolbarTarget &&
        createPortal(
          <>
            {dirty && <span className="text-editor-dirty-dot" title="Unsaved changes" />}
            <button
              className="icon-button"
              title={sideBySide ? "Switch to inline view" : "Switch to side-by-side view"}
              onClick={() => setSideBySide((v) => !v)}
            >
              <Icon name={sideBySide ? "diff-single" : "diff-sidebyside"} />
            </button>
            {editablePath && (
              <button
                className="icon-button"
                title={saveError ? `Save failed: ${saveError}` : "Save (Ctrl+S)"}
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                <Icon name="save" />
              </button>
            )}
          </>,
          toolbarTarget,
        )}
    </div>
  );
}
