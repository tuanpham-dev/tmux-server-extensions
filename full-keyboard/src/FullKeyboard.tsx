import { useEffect, useRef, useState } from "react";
import type { TerminalAccessoryContext } from "./client";
import { readStyle, readSuppressMode, useFloatingOpen } from "./client";
import KeyboardSurface from "./KeyboardSurface";

interface Props {
  context: TerminalAccessoryContext;
  visible: boolean;
}

// Fixed mode: the keyboard docked below the terminal (the "bar" accessory slot,
// in normal flow, so the terminal shrinks above it). Renders only when the
// style setting is "fixed" and the terminal is the focused one. Suppresses the
// OS keyboard while shown (per setting). Its hooks run every render — including
// when style is "floating", where it stays inert and releases suppression —
// while the FloatingKeyboard overlay accessory takes over.
export default function FullKeyboard({ context, visible }: Props) {
  const style = readStyle();
  // Docked in fixed mode (always), and in "floating-docked" mode while the
  // floating toggle is open — where FloatingKeyboard renders only the movable
  // toggle and drives OS-keyboard suppression; this bar accessory just renders
  // the docked surface. See the suppression effect below.
  const floatingOpen = useFloatingOpen();
  const active = visible && (style === "fixed" || (style === "floating-docked" && floatingOpen));

  // context is a fresh object every TerminalView render; ref it so the
  // suppression effect depends only on the booleans, not on identity.
  const contextRef = useRef(context);
  contextRef.current = context;
  // Fixed mode is always docked when active, so "whenShown" and "always" behave
  // identically — hide unless the setting is "never".
  const suppress = active && readSuppressMode() !== "never";
  useEffect(() => {
    // Only fixed mode drives suppression from here; in floating mode this
    // component is inert and the cleanup (on the style flip) releases it.
    if (style !== "fixed") return;
    contextRef.current.setSoftKeyboardSuppressed(suppress);
    return () => contextRef.current.setSoftKeyboardSuppressed(false);
  }, [style, suppress]);

  // Re-render on a terminal-body resize (rotation, sidebar toggle) so the
  // full-bleed offset below is re-measured from the live rect.
  const containerRef = context.containerRef;
  const [, bumpForResize] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bumpForResize((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  if (!active) return null;

  // The docked surface stretches to the terminal-host content box, which is
  // inset from the screen (its 8px left padding plus whatever chrome offsets the
  // terminal area). Pull it left by that full offset — the terminal body's own
  // distance from the screen edge — so the keyboard spans edge to edge. The
  // flex stretch widens it back to fill, rather than shifting it off-screen.
  const bodyLeft = containerRef.current?.getBoundingClientRect().left ?? 0;
  return <KeyboardSurface context={context} style={{ marginLeft: `${-bodyLeft}px` }} />;
}
