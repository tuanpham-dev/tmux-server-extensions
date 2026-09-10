// This extension's own settings, and live updates for them.
//
// Viewers are registered by class rather than constructed with ctx, so they
// reach settings the same way they reach the host: through this module, wired
// once at activation. `onDidChange` fires for edits made in Settings or on
// another device, so an open editor re-applies without a reload.
export type MinimapMode = "auto" | "on" | "off";

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let api: SettingsApi | null = null;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

export function setSettingsApi(next: SettingsApi): void {
  api = next;
  unsubscribe = next.onDidChange(() => {
    for (const listener of [...listeners]) listener();
  });
}

export function clearSettingsApi(): void {
  unsubscribe?.();
  unsubscribe = null;
  listeners.clear();
  api = null;
}

/** Subscribe to any settings change; returns an unsubscribe function. */
export function onSettingsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function minimapMode(): MinimapMode {
  const raw = api?.get("textEditor.minimap");
  return raw === "on" || raw === "off" ? raw : "auto";
}

/**
 * Whether a file editor should draw the minimap right now. "auto" keeps the
 * original rule: useful on a desktop pane, dead weight on a phone-width one.
 */
export function minimapEnabled(): boolean {
  const mode = minimapMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !matchMedia("(pointer: coarse) and (hover: none)").matches;
}
