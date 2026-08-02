// The supported gestures and their command mapping. Three swipe directions
// (a bottom strip has no meaningful "down") plus two stationary gestures the
// strip is otherwise idle for. Each gesture maps to a command id runnable via
// ctx.app.executeCommand; "" means the gesture is unbound.
export type SwipeDirection = "left" | "right" | "up";
export type OneHandGesture = SwipeDirection | "doubleTap" | "longPress";

// Every gesture key, in settings-picker order. Iterated by readActions so a
// new gesture only has to be added here and to DEFAULT_ACTIONS.
export const GESTURES: OneHandGesture[] = ["left", "right", "up", "doubleTap", "longPress"];

// Shipped defaults (carousel-style: swipe left advances to the next tab).
// The two tap gestures ship UNBOUND — they arrived after the swipes, and
// silently binding them would change behavior under existing users' thumbs.
// Fully remappable in the settings picker.
export const DEFAULT_ACTIONS: Record<OneHandGesture, string> = {
  left: "tab.next",
  right: "tab.previous",
  up: "quickSwitcher.toggle",
  doubleTap: "",
  longPress: "",
};

// The gesture map persists as a JSON string setting (extension configuration
// is scalar-only). A malformed or partial stored value falls back per-key to
// the defaults rather than dropping a gesture — mirrors full-keyboard's
// tolerant readTopKeys parse, and is what lets a map stored before the tap
// gestures existed keep working untouched.
export function readActions(raw: unknown): Record<OneHandGesture, string> {
  const result: Record<OneHandGesture, string> = { ...DEFAULT_ACTIONS };
  if (typeof raw !== "string" || !raw.trim()) return result;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      for (const gesture of GESTURES) {
        const v = (parsed as Record<string, unknown>)[gesture];
        if (typeof v === "string") result[gesture] = v;
      }
    }
  } catch {
    // fall through to defaults
  }
  return result;
}
