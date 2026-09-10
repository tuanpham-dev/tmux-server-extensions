// Vim keybindings, off unless `textEditor.vim` says otherwise.
//
// monaco-vim does the modal work (it is CodeMirror's vim engine adapted to
// Monaco); this module owns the parts that are ours: when to attach, when to
// tear down, and what `:w` and `:q` should actually do in an app where a
// "buffer" is a tab.
//
// The Ex commands are the awkward part. `Vim.defineEx` writes to global state,
// so there is exactly one `:w` handler no matter how many editors are open,
// and it has to work out which buffer the user meant. It asks, at the moment
// the command runs, which of the editors running vim has focus, rather than
// tracking focus as it moves: an Ex command can only be typed into a focused
// editor, so the answer is correct by construction, with no listener to miss
// and no stale reference that could make `:w` save the wrong file.
import { useEffect } from "react";
import { getLoadedChunk, type ExParams, type VimAdapter } from "./monacoLoader";
import type { CodeEditor } from "./monacoNs";
import { onSettingsChange, vimEnabled } from "./settings";

export interface VimActions {
  /** Saves; resolves false when the save failed, so `:wq` can refuse to close. */
  save: () => Promise<boolean>;
  /** Closes this view's tab. */
  close: () => void;
  /** Unsaved changes — what `:q` refuses over and `:q!` ignores. */
  isDirty: () => boolean;
}

// Actions for every editor currently running vim, keyed by the editor itself,
// so the global Ex handlers can look up whichever one has focus.
const actionsByEditor = new Map<CodeEditor, VimActions>();

let exCommandsRegistered = false;

// The actions of the editor the user is typing the Ex command into. Null when
// nothing is focused or that editor isn't running vim — in which case the
// command quietly does nothing, which beats acting on an arbitrary buffer.
function focusedActions(): VimActions | null {
  // The map is scanned rather than monaco.editor.getEditors(): the panes inside
  // a diff editor are not reliably listed there, and every editor running vim
  // is a key here anyway.
  for (const [editor, actions] of actionsByEditor) {
    if (editor.hasTextFocus()) return actions;
  }
  return null;
}

/**
 * Whether the user typed the command with a `!`. monaco-vim parses `:q!` as the
 * command `q` with the bang left in the raw input rather than handing it to the
 * handler, so it is read back off `params.input` — the line as typed, minus the
 * leading colon, e.g. `q!` or `1,5w`.
 */
function hasBang(params: ExParams | undefined): boolean {
  return /^\s*(?:[^a-zA-Z]*\s*)?[a-zA-Z]+!/.test(params?.input ?? "");
}

function registerExCommands(): void {
  if (exCommandsRegistered) return;
  const vim = getLoadedChunk()?.VimMode?.Vim;
  if (!vim) return;
  exCommandsRegistered = true;

  // Note the shape: defineEx insists the short form be a prefix of the long
  // one, so `q!` cannot be registered as a command of its own — it is `quit`
  // with a bang, exactly as in vim, and hasBang() digs it back out.
  vim.defineEx("write", "w", () => {
    void focusedActions()?.save();
  });

  // Vim refuses to quit a modified buffer, and so does this: the host's
  // closeViewerTab has no confirmation of its own, so without the check `:q`
  // would be a silent way to lose edits.
  vim.defineEx("quit", "q", (cm, params) => {
    const actions = focusedActions();
    if (!actions) return;
    if (actions.isDirty() && !hasBang(params)) {
      // Through monaco-vim's own notification slot, not by writing to the
      // status node: the node holds the mode indicator and the Ex input, and
      // overwriting it would tear out elements the status bar still holds
      // references to.
      cm.openNotification("E37: No write since last change (add ! to override)");
      return;
    }
    actions.close();
  });

  // `:wq` closes only if the write actually landed. The views report save
  // failures in their toolbar rather than throwing, so without checking, a
  // failed write here would close the tab and take the edits with it.
  const writeQuit = () => {
    const actions = focusedActions();
    if (!actions) return;
    void actions.save().then((saved) => {
      if (saved) actions.close();
    });
  };
  vim.defineEx("wq", "wq", writeQuit);
  vim.defineEx("xit", "x", writeQuit);
}

/**
 * Attaches vim to `editor` while the setting is on, and re-attaches when it is
 * toggled — no reload needed. `statusNode` is where monaco-vim draws the mode
 * line, the `:` prompt and search input; without it the mode is invisible and
 * Ex commands can't be typed at all.
 *
 * Pass a null editor (a read-only diff side, an editor that hasn't been created
 * yet) and this does nothing.
 */
export function useVimMode(
  editor: CodeEditor | null,
  statusNode: HTMLElement | null,
  actions: VimActions,
  // Bumped by the caller when `editor` is replaced, since a ref's .current
  // changing is invisible to React's dependency comparison.
  editorKey: unknown,
): void {
  useEffect(() => {
    if (!editor || !statusNode) return;
    let adapter: VimAdapter | null = null;

    const attach = () => {
      const chunk = getLoadedChunk();
      if (adapter || !chunk || !vimEnabled()) return;
      registerExCommands();
      actionsByEditor.set(editor, actions);
      adapter = chunk.initVimMode(editor, statusNode);
    };

    const detach = () => {
      adapter?.dispose();
      adapter = null;
      actionsByEditor.delete(editor);
      // Each attach builds a fresh StatusBar that appends its spans to this
      // node without clearing it first, so leaving the old ones behind would
      // stack a second mode indicator on every toggle.
      statusNode.textContent = "";
    };

    attach();
    const unsubscribe = onSettingsChange(() => {
      if (vimEnabled()) attach();
      else detach();
    });

    return () => {
      unsubscribe();
      detach();
    };
    // `actions` is rebuilt every render by its callers; re-attaching vim on
    // each keystroke would be absurd, so the effect deliberately keys on the
    // editor identity instead and reads the latest actions through the map,
    // which attach() refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, statusNode, editorKey]);

  // Keep the map pointing at the current render's closures without
  // re-attaching, so `:w` always saves through the live save function.
  useEffect(() => {
    if (editor && actionsByEditor.has(editor)) actionsByEditor.set(editor, actions);
  });
}
