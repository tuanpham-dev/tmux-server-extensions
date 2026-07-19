import { useEffect, useRef, useState } from "react";
import type { TerminalAccessoryContext } from "./client";
import { getFloatingOpen, readStyle, readSuppressMode, setFloatingOpen, useFloatingOpen } from "./client";
import KeyboardSurface from "./KeyboardSurface";

interface Props {
  context: TerminalAccessoryContext;
  visible: boolean;
}

const STORAGE_KEY = "fullKeyboardFabPos";
const TOGGLE_SIZE = 44;
const DRAG_THRESHOLD = 6;
// Gap between the toggle and the keyboard panel it opens.
const PANEL_GAP = 8;

interface FabPos {
  // Fraction (0-1) of container width/height for the toggle's center —
  // resize-proportional so orientation changes don't strand it off-screen.
  // Device-specific, so localStorage only (never the synced settings doc).
  xFrac: number;
  yFrac: number;
}

// Default to the upper-right so the collapsed toggle sits clear of the keyboard
// panel, which fills the bottom when expanded.
const DEFAULT_POS: FabPos = { xFrac: 0.92, yFrac: 0.12 };

function loadPos(): FabPos {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    if (typeof parsed.xFrac === "number" && typeof parsed.yFrac === "number") return parsed as FabPos;
  } catch {
    // fall through to default
  }
  return DEFAULT_POS;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// Floating mode: a draggable ⌨ toggle over the terminal. Tap it to show the full
// keyboard as a bottom overlay that does NOT shrink the terminal; tap again to
// collapse back to just the toggle, freeing the screen. Drag it to reposition.
// The OS keyboard is suppressed only while expanded (per setting) — collapsed,
// the native keyboard stays available. Renders only when the style setting is
// "floating" and the terminal is focused; inert (and releasing suppression) in
// fixed mode, where FullKeyboard's bar accessory takes over.
export default function FloatingKeyboard({ context, visible }: Props) {
  const style = readStyle();
  const active = (style === "floating" || style === "floating-docked") && visible;
  // In "floating-docked" the toggle shows/hides the docked keyboard (rendered
  // by FullKeyboard in the bar slot) rather than the overlay panel below.
  const docked = style === "floating-docked";

  const [pos, setPos] = useState<FabPos>(loadPos);
  const expanded = useFloatingOpen();
  const dragState = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  // Bumped by the ResizeObserver so a container resize (rotation, sidebar
  // toggle) re-derives the toggle's pixel position from the live rect.
  const [, bumpForResize] = useState(0);

  const containerRef = context.containerRef;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bumpForResize((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // context is a fresh object every render; ref it so the suppression effect
  // depends only on the boolean, not on identity.
  const contextRef = useRef(context);
  contextRef.current = context;
  // "always" hides the OS keyboard whenever the toggle is visible (even
  // collapsed, so the toggle is the only keyboard); "whenShown" hides it only
  // while expanded (collapsed keeps the OS keyboard available); "never" never
  // hides it.
  const suppressMode = readSuppressMode();
  const suppress = active && suppressMode !== "never" && (suppressMode === "always" || expanded);
  useEffect(() => {
    // The floating toggle drives suppression for both its modes (overlay and
    // docked) since it's the always-present component; in fixed mode this is
    // inert and the cleanup (on the style flip) releases it.
    if (style === "fixed") return;
    contextRef.current.setSoftKeyboardSuppressed(suppress);
    return () => contextRef.current.setSoftKeyboardSuppressed(false);
  }, [style, suppress]);

  if (!active) return null;

  const rect = containerRef.current?.getBoundingClientRect();
  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;
  // The terminal body is inset from the screen's left edge (terminal-host
  // padding + chrome); pull the panel left by that much so it spans edge to
  // edge (right is already flush, right: 0).
  const bodyLeft = rect?.left ?? 0;
  const half = TOGGLE_SIZE / 2;
  const centerX = width ? clamp(pos.xFrac * width, half, width - half) : 0;
  const centerY = height ? clamp(pos.yFrac * height, half, height - half) : 0;

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag || !rect) return;
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD) drag.moved = true;
    if (!drag.moved) return;
    const nx = clamp(e.clientX - rect.left, half, width - half);
    const ny = clamp(e.clientY - rect.top, half, height - half);
    setPos({ xFrac: width ? nx / width : DEFAULT_POS.xFrac, yFrac: height ? ny / height : DEFAULT_POS.yFrac });
  };

  const handlePointerUp = () => {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag) return;
    if (drag.moved) {
      setPos((p) => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
        return p;
      });
    } else {
      // A still tap toggles the keyboard (getter avoids a stale closure value).
      setFloatingOpen(!getFloatingOpen());
    }
  };

  // Open the keyboard on whichever side of the toggle has more room: above it
  // when the toggle sits in the lower half, below it when in the upper half —
  // so the panel grows away from the nearer edge and stays adjacent to the
  // toggle. Full width either way; only the vertical anchor flips.
  const openUp = centerY > height / 2;
  const panelStyle: React.CSSProperties = {
    left: `${-bodyLeft}px`,
    right: 0,
    ...(openUp
      ? { bottom: `${height - centerY + half + PANEL_GAP}px` }
      : { top: `${centerY + half + PANEL_GAP}px` }),
  };

  return (
    <>
      {expanded && !docked && (
        <div className="fk-floating-panel" style={panelStyle}>
          <KeyboardSurface context={context} />
        </div>
      )}
      <button
        className={`fk-fab${expanded ? " active" : ""}`}
        style={{ left: `${centerX - half}px`, top: `${centerY - half}px` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        ⌨
      </button>
    </>
  );
}
