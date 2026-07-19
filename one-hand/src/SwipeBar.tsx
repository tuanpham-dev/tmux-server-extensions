import { useRef } from "react";
import type { SwipeDirection } from "./actions";

interface Props {
  visible: boolean;
  // Distance (px) to lift the strip off the editor's bottom edge, so it sits
  // above a docked on-screen keyboard rather than over it. 0 = flush bottom.
  bottomOffset: number;
  onSwipe: (dir: SwipeDirection) => void;
}

// Minimum pointer travel (px) before a movement counts as a swipe rather than
// a tap. Deliberate enough to avoid accidental fires, short enough for a thumb
// flick — a single constant, easy to retune.
const SWIPE_THRESHOLD = 48;

// A transparent strip pinned to the bottom edge of the editor (see style.css).
// It recognizes a left / right / up flick and reports the direction; the parent
// maps it to a command. Only left/right/up are meaningful for a bottom strip,
// so a downward flick is ignored. touch-action:none (in CSS) stops the browser
// from consuming the gesture as a scroll.
export default function SwipeBar({ visible, bottomOffset, onSwipe }: Props) {
  const start = useRef<{ x: number; y: number } | null>(null);

  if (!visible) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    // Only track primary pointer gestures (a single finger / left button).
    if (!e.isPrimary) return;
    start.current = { x: e.clientX, y: e.clientY };
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

  const finish = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (Math.max(ax, ay) < SWIPE_THRESHOLD) return; // a tap, not a swipe
    if (ax >= ay) {
      onSwipe(dx < 0 ? "left" : "right");
    } else if (dy < 0) {
      onSwipe("up"); // upward only; downward is unsupported on a bottom strip
    }
  };

  return (
    <div
      className="one-hand-swipe-bar"
      style={{ bottom: `${bottomOffset}px` }}
      onPointerDown={onPointerDown}
      onPointerUp={finish}
      onPointerCancel={() => {
        start.current = null;
      }}
    >
      <div className="one-hand-swipe-grabber" />
    </div>
  );
}
