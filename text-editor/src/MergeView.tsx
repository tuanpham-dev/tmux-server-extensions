// Inline merge-conflict resolution, for the `editor` setting's "merge"
// capability. This is VS Code's built-in behaviour rather than its four-pane
// merge editor: the *working file* opens as an ordinary editable document,
// markers and all, with each conflict block tinted and a row of actions above
// it — Accept Current Change / Accept Incoming Change / Accept Both Changes /
// Compare Changes, the same four commands VS Code's merge-conflict extension
// contributes.
//
// Accepting rewrites the block through Monaco's own edit stack, so undo works
// and nothing reaches disk until Save. "Mark as Resolved" only lights up once
// the file has no markers left and is saved; it calls back into whoever opened
// the merge (git-scm stages the path).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { saveFileText } from "./fileApi";
import { loadMonaco } from "./monacoLoader";
import type { MonacoNs, StandaloneEditor, TextModel } from "./monacoNs";
import { acquireFile, isDirty, markSaved, type FileEntry } from "./models";
import { getMergeRequest, type MergeRequest } from "./requests";
import { findConflicts, resolvedLines, type ConflictBlock, type ResolutionChoice } from "./conflictMarkers";
import { hostAssetUrl, hostCloseViewerTab, hostOpenDiff, hostThemeApi } from "./host";
import { lineNumbersOption, onSettingsChange, vimEnabled } from "./settings";
import { useVimMode } from "./vim";

const DEFAULT_FONT_SIZE = 13;
// Re-scanning on every keystroke would rebuild decorations mid-word; this is
// the same "let it settle" interval the highlighter uses.
const RESCAN_DEBOUNCE_MS = 150;

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

async function loadWorkingFile(path: string): Promise<string> {
  const res = await fetch(`/api/download?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

export default function MergeView({ filePath, active, toolbarTarget, setDirty, fontSize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<StandaloneEditor | null>(null);
  const entryRef = useRef<FileEntry | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const fontSizeRef = useRef(fontSize);
  const setDirtyRef = useRef(setDirty);
  fontSizeRef.current = fontSize;
  setDirtyRef.current = setDirty;

  // Read once per path and kept here afterwards, same as DiffEditorView.
  const requestRef = useRef<{ key: string; value: MergeRequest | undefined }>({ key: "", value: undefined });
  if (requestRef.current.key !== filePath) {
    requestRef.current = { key: filePath, value: getMergeRequest(filePath) };
  }
  const request = requestRef.current.value;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [resolving, setResolving] = useState(false);
  // See TextEditorView for why the editor is counted and the status node held
  // in state rather than read off a ref during render.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [vimOn, setVimOn] = useState(() => vimEnabled());
  const [vimStatusNode, setVimStatusNode] = useState<HTMLDivElement | null>(null);

  // Resolves true when the file is on disk — see TextEditorView's save for why
  // vim's `:wq` needs the answer.
  const save = useCallback(async (): Promise<boolean> => {
    const entry = entryRef.current;
    if (!entry?.model) return false;
    const content = entry.model.getValue();
    setSaving(true);
    setSaveError(null);
    try {
      await saveFileText(entry.filePath, content);
      markSaved(entry, content);
      return true;
    } catch (err) {
      setSaveError(messageOf(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

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
        if (!request) throw new Error("This merge is no longer available — reopen it from Source Control.");
        if (!hostAssetUrl || !hostThemeApi) throw new Error("The Text Editor extension is not active.");
        const monaco = await loadMonaco(hostAssetUrl, hostThemeApi);
        if (cancelled) return;

        const acquired = acquireFile(monaco, request.path, () => loadWorkingFile(request.path));
        entryRef.current = acquired.entry;
        const model = await acquired.entry.ready;
        if (cancelled || !containerRef.current) {
          acquired.release();
          return;
        }

        const editor = monaco.editor.create(containerRef.current, {
          model,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--terminal-font").trim() || "monospace",
          fontSize: fontSizeRef.current ?? DEFAULT_FONT_SIZE,
          minimap: { enabled: false },
          lineNumbers: lineNumbersOption(),
          // The lenses are the point of this view; without this Monaco hides
          // them behind the "show more" affordance on narrow panes.
          codeLens: true,
        });
        editorRef.current = editor;
        setEditorEpoch((n) => n + 1);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());

        const disposers = wireConflictUi(monaco, editor, model, request, setRemaining);

        const sync = () => {
          const nowDirty = isDirty(acquired.entry);
          setDirtyState(nowDirty);
          setDirtyRef.current?.(nowDirty);
        };
        acquired.entry.listeners.add(sync);
        sync();

        teardown = () => {
          acquired.entry.listeners.delete(sync);
          for (const d of disposers) d();
          editor.dispose();
          acquired.release();
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
      teardown?.();
      editorRef.current = null;
      entryRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: fontSize ?? DEFAULT_FONT_SIZE });
  }, [fontSize]);

  useEffect(() => {
    if (active) editorRef.current?.layout();
  }, [active]);

  useEffect(
    () =>
      onSettingsChange(() => {
        editorRef.current?.updateOptions({ lineNumbers: lineNumbersOption() });
        setVimOn(vimEnabled());
      }),
    [],
  );

  useVimMode(
    editorRef.current,
    vimStatusNode,
    {
      save: () => save(),
      close: () => hostCloseViewerTab?.("merge", filePath),
      isDirty: () => dirty,
    },
    editorEpoch,
  );

  const acceptAll = useCallback((choice: ResolutionChoice) => {
    const model = entryRef.current?.model;
    if (!model) return;
    // Last block first: rewriting one shifts every line below it, and applying
    // in reverse keeps the earlier ranges valid.
    const blocks = findConflicts(model.getValue()).reverse();
    for (const block of blocks) applyResolution(model, block, choice);
  }, []);

  const markResolved = useCallback(async () => {
    if (!request) return;
    setResolving(true);
    try {
      await request.markResolved();
    } catch (err) {
      setSaveError(messageOf(err));
    } finally {
      setResolving(false);
    }
  }, [request]);

  const canMarkResolved = remaining === 0 && !dirty && !saving && !resolving;

  return (
    <div className={`text-editor-host${active ? "" : " hidden"}`}>
      {error && <div className="text-editor-status text-editor-error">{error}</div>}
      {!error && loading && <div className="text-editor-status">Loading editor…</div>}
      {!error && !loading && (
        <div className="text-editor-status">
          {remaining === 0
            ? dirty
              ? "All conflicts resolved — save to continue."
              : "All conflicts resolved."
            : `${remaining} conflict${remaining === 1 ? "" : "s"} remaining.`}
        </div>
      )}
      {!error && <div ref={containerRef} className="text-editor-monaco" />}
      {!error && vimOn && <div ref={setVimStatusNode} className="text-editor-vim-status" />}
      {active &&
        toolbarTarget &&
        createPortal(
          <>
            {dirty && <span className="text-editor-dirty-dot" title="Unsaved changes" />}
            <button className="icon-button" title="Accept all current changes" onClick={() => acceptAll("ours")}>
              <Icon name="check" />
            </button>
            <button className="icon-button" title="Accept all incoming changes" onClick={() => acceptAll("theirs")}>
              <Icon name="check-all" />
            </button>
            <button
              className="icon-button"
              title={saveError ? `Save failed: ${saveError}` : "Save (Ctrl+S)"}
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              <Icon name="save" />
            </button>
            <button
              className="icon-button"
              title={
                remaining > 0
                  ? "Resolve every conflict first"
                  : dirty
                    ? "Save first"
                    : "Mark as Resolved (stage this file)"
              }
              disabled={!canMarkResolved}
              onClick={() => void markResolved()}
            >
              <Icon name="git-merge" />
            </button>
          </>,
          toolbarTarget,
        )}
    </div>
  );
}

// Replaces one block with the chosen side, as a single undoable edit.
function applyResolution(model: TextModel, block: ConflictBlock, choice: ResolutionChoice): void {
  const text = model.getValue();
  const replacement = resolvedLines(text, block, choice);
  const endColumn = model.getLineMaxColumn(Math.min(block.endLine, model.getLineCount()));
  model.pushEditOperations(
    null,
    [
      {
        range: {
          startLineNumber: block.startLine,
          startColumn: 1,
          endLineNumber: block.endLine,
          endColumn,
        },
        text: replacement.join("\n"),
      },
    ],
    () => null,
  );
}

// Decorations + CodeLens for every conflict block, kept in step with the
// document. Returns disposers for everything it registered.
function wireConflictUi(
  monaco: MonacoNs,
  editor: StandaloneEditor,
  model: TextModel,
  request: MergeRequest,
  onRemaining: (n: number) => void,
): Array<() => void> {
  let blocks: ConflictBlock[] = [];
  let decorations: string[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;

  // Command ids are per editor instance, so two merge tabs never share them.
  const accept = (choice: ResolutionChoice) =>
    editor.addCommand(0, (_ctx, startLine: number) => {
      const block = blocks.find((b) => b.startLine === startLine);
      if (block) applyResolution(model, block, choice);
    }) ?? "";
  const acceptCurrent = accept("ours");
  const acceptIncoming = accept("theirs");
  const acceptBoth = accept("both");
  const compare =
    editor.addCommand(0, () => {
      void hostOpenDiff?.({
        title: `${request.title} (Current ↔ Incoming)`,
        original: request.ours,
        modified: request.theirs,
      });
    }) ?? "";

  const lensProvider = monaco.languages.registerCodeLensProvider(
    // Every language: a conflicted file can be anything, and the provider
    // filters by model below so no other tab ever sees these lenses.
    { pattern: "**/*" },
    {
      provideCodeLenses(target) {
        if (target.uri.toString() !== model.uri.toString()) return { lenses: [], dispose: () => {} };
        const lenses = blocks.flatMap((block) => {
          const range = {
            startLineNumber: block.startLine,
            startColumn: 1,
            endLineNumber: block.startLine,
            endColumn: 1,
          };
          return [
            { range, command: { id: acceptCurrent, title: "Accept Current Change", arguments: [block.startLine] } },
            { range, command: { id: acceptIncoming, title: "Accept Incoming Change", arguments: [block.startLine] } },
            { range, command: { id: acceptBoth, title: "Accept Both Changes", arguments: [block.startLine] } },
            ...(hostOpenDiff ? [{ range, command: { id: compare, title: "Compare Changes", arguments: [] } }] : []),
          ];
        });
        return { lenses, dispose: () => {} };
      },
    },
  );

  const rescan = () => {
    blocks = findConflicts(model.getValue());
    onRemaining(blocks.length);

    const lineCount = model.getLineCount();
    const clamp = (n: number) => Math.min(Math.max(n, 1), lineCount);
    const band = (from: number, to: number, className: string) =>
      to < from
        ? []
        : [
            {
              range: new monaco.Range(clamp(from), 1, clamp(to), model.getLineMaxColumn(clamp(to))),
              options: { isWholeLine: true, className },
            },
          ];

    const next = blocks.flatMap((block) => [
      ...band(block.startLine, block.startLine, "text-editor-merge-current-header"),
      ...band(block.ours.from, block.ours.to, "text-editor-merge-current"),
      ...(block.baseHeaderLine ? band(block.baseHeaderLine, block.baseHeaderLine, "text-editor-merge-base-header") : []),
      ...(block.base ? band(block.base.from, block.base.to, "text-editor-merge-base") : []),
      ...band(block.separatorLine, block.separatorLine, "text-editor-merge-incoming-header"),
      ...band(block.theirs.from, block.theirs.to, "text-editor-merge-incoming"),
      ...band(block.endLine, block.endLine, "text-editor-merge-incoming-header"),
    ]);
    decorations = model.deltaDecorations(decorations, next);
  };

  rescan();
  const sub = model.onDidChangeContent(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      rescan();
    }, RESCAN_DEBOUNCE_MS);
  });

  return [
    () => {
      if (debounce) clearTimeout(debounce);
      sub.dispose();
      lensProvider.dispose();
      model.deltaDecorations(decorations, []);
    },
  ];
}
