// The Monaco namespace type, in one place so every module can talk about
// `monaco.*` without a runtime import of the package — Monaco itself ships in
// the lazily-fetched dist/chunks/monaco.js bundle (see monacoLoader.ts), and a
// value import here would pull all ~5MB of it back into the eager client.js.
// `import type` is erased by esbuild, so this file costs nothing at runtime.
import type * as monacoNs from "monaco-editor";

export type MonacoNs = typeof monacoNs;
export type TextModel = monacoNs.editor.ITextModel;
export type StandaloneEditor = monacoNs.editor.IStandaloneCodeEditor;
export type TokenizerState = monacoNs.languages.IState;
export type StandaloneDiffEditor = monacoNs.editor.IStandaloneDiffEditor;
// The common base of both the standalone editor and the two panes inside a
// diff editor. Vim attaches to any of them, so it talks in this type.
export type CodeEditor = monacoNs.editor.ICodeEditor;
