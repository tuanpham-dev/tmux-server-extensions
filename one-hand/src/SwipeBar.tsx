import { useEffect, useRef } from "react";
import type { OneHandGesture } from "./actions";

interface Props {
  visible: boolean;
  // Distance (px) to lift the strip off the editor's bottom edge, so it sits
  // above a docked on-screen keyboard rather than over it. 0 = flush bottom.
  bottomOffset: number;
  onGesture: (gesture: OneHandGesture) => void;
}

// Minimum pointer travel (px) before a movement counts as a swipe rather than
// a tap. Deliberate enough to avoid accidental fires, short enough for a thumb
// flick — a single constant, easy to retune.
const SWIPE_THRESHOLD = 48;
// How long the pointer must stay down (and near where it landed) to count as
// a long press rather than a tap.
const LONG_PRESS_MS = 500;
// How soon after a tap a second tap still counts as a double tap.
const DOUBLE_TAP_MS = 300;
// Drift (px) still treated as stationary — fingers never hold perfectly still.
const TAP_SLOP = 10;

// A transparent strip pinned to the bottom edge of the editor (see style.css).
// It recognizes a left / right / up flick, a double tap, and a long press, and
// reports which; the parent maps each to a command. Only left/right/up are
// meaningful for a bottom strip, so a downward flick is ignored, and a single
// tap deliberately does nothing — the strip sits under the terminal, where a
// stray tap must stay harmless.
export default function SwipeBar({ visible, bottomOffset, onGesture }: Props) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when a long press already fired for this pointer, so the pointerup
  // that follows doesn't also register as a tap or a swipe.
  const consumed = useRef(false);
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);

  const clearHold = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  // A pending hold timer must not outlive the component: the overlay unmounts
  // when the extension is disabled or the show setting flips, and a stray fire
  // would run a command with no strip on screen.
  useEffect(() => clearHold, []);

  if (!visible) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    // Only track primary pointer gestures (a single finger / left button).
    if (!e.isPrimary) return;
    start.current = { x: e.clientX, y: e.clientY };
    consumed.current = false;
    clearHold();
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      if (!start.current) return;
      consumed.current = true;
      // The strip is transparent, so a hold has no visual feedback at all —
      // a short buzz is the only signal that it fired. Feature-detected:
      // absent on desktop and on iOS Safari.
      navigator.vibrate?.(10);
      onGesture("longPress");
    }, LONG_PRESS_MS);
    // Capture so pointerup still lands here if the finger drifts off the strip
    // mid-swipe. Guarded: setPointerCapture throws (NotFoundError) if the
    // pointer is already gone — the swipe still resolves from the tracked
    // start point regardless, so a failed capture is non-fatal.
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // non-fatal — see above
    }
    // Suppress native gestures (text selection, scroll start) on the strip.
    e.preventDefault();
  };

  // Drifting past the slop turns the gesture into a swipe, so the pending long
  // press is cancelled — otherwise a slow drag would fire both.
  const onPointerMove = (e: React.PointerEvent) => {
    if (holdTimer.current === null) return;
    const s = start.current;
    if (!s) return;
    if (Math.abs(e.clientX - s.x) > TAP_SLOP || Math.abs(e.clientY - s.y) > TAP_SLOP) clearHold();
  };

  const finish = (e: React.PointerEvent) => {
    clearHold();
    const s = start.current;
    start.current = null;
    if (!s || consumed.current) return; // long press already handled this pointer
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);

    if (Math.max(ax, ay) < SWIPE_THRESHOLD) {
      // A tap. Only the second one in quick succession does anything — a
      // single tap stays unbound (see the component comment).
      const now = e.timeStamp;
      const prev = lastTap.current;
      const near =
        prev &&
        Math.abs(e.clientX - prev.x) <= TAP_SLOP * 3 &&
        Math.abs(e.clientY - prev.y) <= TAP_SLOP * 3;
      if (prev && near && now - prev.at <= DOUBLE_TAP_MS) {
        lastTap.current = null; // a third tap starts a fresh pair
        onGesture("doubleTap");
      } else {
        lastTap.current = { x: e.clientX, y: e.clientY, at: now };
      }
      return;
    }

    lastTap.current = null; // a swipe breaks any pending double-tap pair
    if (ax >= ay) {
      onGesture(dx < 0 ? "left" : "right");
    } else if (dy < 0) {
      onGesture("up"); // upward only; downward is unsupported on a bottom strip
    }
  };

  const cancel = () => {
    clearHold();
    start.current = null;
  };

  return (
    <div
      className="one-hand-swipe-bar"
      // A swipe here is a free horizontal drag the host's flick-to-toggle-
      // sidebar gesture would otherwise also act on (the strip isn't a
      // horizontal scroller, so its opt-out walk can't detect it) — a left/
      // right swipe would run its command AND open/close the sidebar.
      data-no-sidebar-swipe=""
      style={{ bottom: `${bottomOffset}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={cancel}
    >
      <div className="one-hand-swipe-grabber" />
    </div>
  );
}
