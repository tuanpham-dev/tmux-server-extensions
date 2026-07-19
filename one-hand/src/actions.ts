// The three supported swipe directions and their command mapping. Only
// left/right/up are supported (a bottom strip has no meaningful "down"). Each
// direction maps to a command id runnable via ctx.app.executeCommand; "" means
// the direction is unbound.
export type SwipeDirection = "left" | "right" | "up";

// Shipped defaults (carousel-style: swipe left advances to the next tab).
// Fully remappable in the settings picker.
export const DEFAULT_ACTIONS: Record<SwipeDirection, string> = {
  left: "tab.next",
  right: "tab.previous",
  up: "quickSwitcher.toggle",
};

// The direction map persists as a JSON string setting (extension configuration
// is scalar-only). A malformed or partial stored value falls back per-key to
// the defaults rather than dropping a direction — mirrors full-keyboard's
// tolerant readTopKeys parse.
export function readActions(raw: unknown): Record<SwipeDirection, string> {
  const result: Record<SwipeDirection, string> = { ...DEFAULT_ACTIONS };
  if (typeof raw !== "string" || !raw.trim()) return result;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      for (const dir of ["left", "right", "up"] as const) {
        const v = (parsed as Record<string, unknown>)[dir];
        if (typeof v === "string") result[dir] = v;
      }
    }
  } catch {
    // fall through to defaults
  }
  return result;
}
