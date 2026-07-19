// full-keyboard: a full on-screen QWERTY keyboard for mobile, docked below the
// terminal under a customizable special-key top bar. Ordinary builtin:
// disabling it is the legitimate "I don't want the on-screen keyboard" choice.
// Renders on the terminal-accessory "bar" extension point; its top-bar layout
// editor renders on the settings-component point. Machinery (parser, key
// buttons, voice input, editor) is copied from touch-keys rather than shared —
// see plans/full-keyboard-extension.md.
import { useEffect, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import { DEFAULT_TOP_KEYS, type TouchKey } from "./spec";
import FullKeyboard from "./FullKeyboard";
import FloatingKeyboard from "./FloatingKeyboard";
import TopKeysEditor from "./TopKeysEditor";

// ---- Module-level host bridge ----

interface SettingsApi {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  onDidChange(cb: () => void): () => void;
}

let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;

// One host subscription fanned out to local component listeners, so every
// consumer re-reads on a Settings edit (including another device's, via the
// server-synced doc).
const settingsListeners = new Set<() => void>();

export function readShow(): "auto" | "always" | "never" {
  const v = extSettings?.get("fullKeyboard.show");
  return v === "always" || v === "never" ? v : "auto";
}

// When to hide the OS keyboard. "whenShown" (default): while the keyboard is on
// screen (fixed: always; floating: only when expanded). "always": whenever the
// terminal is focused (floating: even when the toggle is collapsed). "never":
// keep the OS keyboard. Accepts the legacy boolean value (true -> whenShown,
// false -> never) so an older stored setting still resolves sensibly.
export type SuppressMode = "never" | "whenShown" | "always";

export function readSuppressMode(): SuppressMode {
  const v = extSettings?.get("fullKeyboard.suppressSoftKeyboard");
  if (v === "never" || v === false) return "never";
  if (v === "always") return "always";
  return "whenShown";
}

export function readStyle(): "fixed" | "floating" | "floating-docked" {
  const v = extSettings?.get("fullKeyboard.style");
  return v === "floating" || v === "floating-docked" ? v : "fixed";
}

// Shared open/closed state for the floating toggle. In "floating-docked" mode
// the movable toggle (FloatingKeyboard, overlay slot) and the docked keyboard
// it shows (FullKeyboard, bar slot) are separate accessory components, so this
// module-level flag is their single source of truth. Device-local UI state,
// not a persisted setting.
let floatingOpen = false;
const floatingOpenListeners = new Set<() => void>();
export function getFloatingOpen(): boolean {
  return floatingOpen;
}
export function setFloatingOpen(v: boolean): void {
  if (floatingOpen === v) return;
  floatingOpen = v;
  for (const cb of floatingOpenListeners) cb();
}
export function useFloatingOpen(): boolean {
  const [, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    floatingOpenListeners.add(cb);
    return () => {
      floatingOpenListeners.delete(cb);
    };
  }, []);
  return floatingOpen;
}

// The top-bar layout persists as a JSON string setting (extension
// configuration properties are scalar-only); a malformed stored value falls
// back to the defaults rather than rendering a broken bar.
export function readTopKeys(): TouchKey[] {
  const raw = extSettings?.get("fullKeyboard.topKeys");
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_TOP_KEYS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (k) =>
          typeof k === "object" &&
          k !== null &&
          typeof (k as TouchKey).label === "string" &&
          typeof (k as TouchKey).send === "string" &&
          typeof (k as TouchKey).when === "string",
      )
    ) {
      return parsed as TouchKey[];
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_TOP_KEYS;
}

export function writeTopKeys(keys: TouchKey[]): void {
  extSettings?.set("fullKeyboard.topKeys", JSON.stringify(keys));
}

// Re-render nudge for components reading the settings above.
export function useFullKeyboardSettingsTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    settingsListeners.add(cb);
    return () => {
      settingsListeners.delete(cb);
    };
  }, []);
  return tick;
}

// ---- Accessory ----

interface TerminalAccessoryContext {
  focused: boolean;
  mobilePointer: boolean;
  command: string;
  stickyCtrl: boolean;
  toggleStickyCtrl(): void;
  sendInput(data: string): void;
  sendText(text: string): void;
  uploadImage(file: File): void;
  uploadImages(files: File[]): void;
  setSoftKeyboardSuppressed(suppressed: boolean): void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

// Whether the keyboard should render right now: only for the focused terminal,
// gated by the show setting ("auto" means real phones/tablets only).
export function isVisible(ctx: TerminalAccessoryContext): boolean {
  const show = readShow();
  return ctx.focused && (show === "always" || (show === "auto" && ctx.mobilePointer));
}

// Both placements register unconditionally; each renders null unless the style
// setting selects it, so flipping fixed <-> floating applies live without
// re-registration. Fixed uses the "bar" slot (docked, in flow); floating uses
// the "overlay" slot (absolute, inside the terminal body, so it doesn't shrink
// the terminal).
function BarAccessory({ context }: { context: TerminalAccessoryContext }) {
  useFullKeyboardSettingsTick();
  return <FullKeyboard context={context} visible={isVisible(context)} />;
}

function OverlayAccessory({ context }: { context: TerminalAccessoryContext }) {
  useFullKeyboardSettingsTick();
  return <FloatingKeyboard context={context} visible={isVisible(context)} />;
}

// ---- Activation ----

interface ExtensionContext {
  registerTerminalAccessory(accessory: {
    id: string;
    placement: "bar" | "overlay";
    component: (props: { context: TerminalAccessoryContext }) => ReturnType<typeof BarAccessory>;
  }): void;
  registerSettingsComponent(component: { id: string; component: typeof TopKeysEditor }): void;
  settings: SettingsApi;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  removeSettingsListener = ctx.settings.onDidChange(() => {
    for (const cb of settingsListeners) cb();
  });
  ctx.registerTerminalAccessory({ id: "keyboard", placement: "bar", component: BarAccessory });
  ctx.registerTerminalAccessory({ id: "keyboard-floating", placement: "overlay", component: OverlayAccessory });
  ctx.registerSettingsComponent({ id: "top-keys-editor", component: TopKeysEditor });
}

export function deactivate(): void {
  removeSettingsListener?.();
  removeSettingsListener = null;
  removeStylesheet?.();
  removeStylesheet = null;
  extSettings = null;
  settingsListeners.clear();
}

export type { TerminalAccessoryContext };
