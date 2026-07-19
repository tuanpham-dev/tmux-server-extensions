// one-hand: a transparent swipe bar pinned to the bottom of the editor, on
// every tab, for one-handed operation on mobile. Renders on the app-global
// overlay extension point (registerAppOverlay) so it's visible over any tab —
// not just terminals — and runs commands through ctx.app.executeCommand. Its
// per-direction command picker renders on the settings-component point.
import { useEffect, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import { readActions, type SwipeDirection } from "./actions";
import SwipeBar from "./SwipeBar";
import SwipeSettings from "./SwipeSettings";
import { useBottomInset } from "./useBottomInset";

// ---- Module-level host bridge ----

interface SettingsApi {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  onDidChange(cb: () => void): () => void;
}

interface AppApi {
  executeCommand(commandId: string): void;
  getCommands(): { id: string; label: string }[];
}

let extSettings: SettingsApi | null = null;
let appApi: AppApi | null = null;
let removeStylesheet: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;

// One host subscription fanned out to local component listeners, so every
// consumer re-reads on a Settings edit (including another device's, via the
// server-synced doc).
const settingsListeners = new Set<() => void>();

export function readShow(): "auto" | "always" | "never" {
  const v = extSettings?.get("oneHand.show");
  return v === "always" || v === "never" ? v : "auto";
}

// The direction→command map, resolved from the oneHand.actions JSON string
// setting (falls back per-key to the defaults — see actions.readActions).
export function readActionsSetting(): Record<SwipeDirection, string> {
  return readActions(extSettings?.get("oneHand.actions"));
}

export function writeActions(map: Record<SwipeDirection, string>): void {
  extSettings?.set("oneHand.actions", JSON.stringify(map));
}

// Runnable commands the host reports (ctx.app.getCommands) — for the settings
// picker's dropdowns. Empty until activate() stashes the app API.
export function listCommands(): { id: string; label: string }[] {
  return appApi?.getCommands() ?? [];
}

function runCommand(commandId: string): void {
  appApi?.executeCommand(commandId);
}

// Re-render nudge for components reading the settings above.
export function useOneHandSettingsTick(): number {
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

// ---- App overlay ----

interface AppOverlayContext {
  mobilePointer: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

// Whether the swipe bar should render right now, gated by the show setting
// ("auto" means real phones/tablets only). No per-terminal "focused" concept —
// the bar is app-global.
function isVisible(ctx: AppOverlayContext): boolean {
  const show = readShow();
  return show === "always" || (show === "auto" && ctx.mobilePointer);
}

function OneHandOverlay({ context }: { context: AppOverlayContext }) {
  useOneHandSettingsTick();
  // Lift the strip above a docked on-screen keyboard in the active terminal so
  // it sits above the keys, not over them (0 on non-terminal tabs).
  const bottomOffset = useBottomInset(context.containerRef);
  const actions = readActionsSetting();
  const onSwipe = (dir: SwipeDirection) => {
    const commandId = actions[dir];
    if (commandId) runCommand(commandId);
  };
  return <SwipeBar visible={isVisible(context)} bottomOffset={bottomOffset} onSwipe={onSwipe} />;
}

// ---- Activation ----

interface ExtensionContext {
  registerAppOverlay(overlay: {
    id: string;
    component: (props: { context: AppOverlayContext }) => ReturnType<typeof OneHandOverlay>;
  }): void;
  registerSettingsComponent(component: { id: string; component: typeof SwipeSettings }): void;
  settings: SettingsApi;
  app: AppApi;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  extSettings = ctx.settings;
  appApi = ctx.app;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  removeSettingsListener = ctx.settings.onDidChange(() => {
    for (const cb of settingsListeners) cb();
  });
  ctx.registerAppOverlay({ id: "swipe-bar", component: OneHandOverlay });
  ctx.registerSettingsComponent({ id: "swipe-actions", component: SwipeSettings });
}

export function deactivate(): void {
  removeSettingsListener?.();
  removeSettingsListener = null;
  removeStylesheet?.();
  removeStylesheet = null;
  extSettings = null;
  appApi = null;
  settingsListeners.clear();
}

export type { AppOverlayContext };
