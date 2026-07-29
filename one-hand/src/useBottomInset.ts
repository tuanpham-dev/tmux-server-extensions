import { useEffect, useState, type RefObject } from "react";

// The height currently occupied at the bottom of the editor by a docked
// on-screen keyboard (the touch-keys / full-keyboard "bar" placement) in the
// active terminal — so the swipe strip can sit ABOVE the keyboard rather than
// over it. Returns 0 on non-terminal tabs and whenever no keyboard is docked.
//
// Derived without coupling to any keyboard extension: a docked bar renders
// below .terminal-body in the terminal-host flex column (see TerminalView), so
// the gap between the visible .terminal-body's bottom and the overlay layer's
// bottom IS the docked keyboard's height (and also clears a bottom panel, which
// sits below the terminal content host the same way). We watch:
//   - the visible .terminal-body (ResizeObserver) — keyboard show/hide, rotation
//   - the content hosts' visibility + add/remove (MutationObserver) — tab switches
// Both are scoped to layout-only targets, never the terminal's own DOM, so a
// busy terminal doesn't spam re-measures.
export function useBottomInset(layerRef: RefObject<HTMLDivElement | null>): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const layer = layerRef.current;
    const main = layer?.parentElement ?? null; // .main
    if (!layer || !main) return;

    let raf = 0;
    let observedBody: Element | null = null;
    const bodyRO = new ResizeObserver(() => schedule());
    const mainRO = new ResizeObserver(() => schedule());
    const hostMO = new MutationObserver(() => {
      attachHostObservers(); // hosts may have been added/removed on a tab open/close
      schedule();
    });

    // First visible terminal body (a split can show several; the first in DOM
    // order is a fine approximation for a single full-width bottom strip).
    const visibleBody = (): Element | null =>
      main.querySelector(".terminal-host:not(.hidden) > .terminal-body");

    let settleTimer = 0;
    const measure = () => {
      // While the page is scrolled (Android's focus-reveal scroll during the
      // on-screen-keyboard transition, before App pins back to 0,0), client
      // rects mix two coordinate systems: the layer (normal flow) is shifted
      // by the scroll, the position:fixed content hosts are not — any inset
      // derived from that pair is garbage. Keep the last good value; the
      // corrective scroll fires the scroll listener below and we re-measure
      // the settled geometry.
      if (window.scrollX !== 0 || window.scrollY !== 0) return;
      const body = visibleBody();
      if (body !== observedBody) {
        if (observedBody) bodyRO.unobserve(observedBody);
        if (body) bodyRO.observe(body);
        observedBody = body;
      }
      let next = 0;
      if (body) {
        const layerBottom = layer.getBoundingClientRect().bottom;
        const bodyBottom = body.getBoundingClientRect().bottom;
        next = Math.max(0, Math.round(layerBottom - bodyBottom));
      }
      setInset((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
      // Trailing re-measure: the keyboard open/close sequence ends with
      // scroll-only and position-only phases that fire none of the observers
      // (ResizeObserver reacts to sizes, the MutationObserver to attributes),
      // so a measure taken mid-transition would otherwise be the last word.
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(measure, 300);
    };

    // Tab switches toggle a .split-content-host's inline display; opening or
    // closing a tab adds/removes a host. Observe just those (childList on .main,
    // the style attribute on each host) — never the terminal-internal subtree.
    function attachHostObservers() {
      hostMO.disconnect();
      hostMO.observe(main!, { childList: true });
      main!
        .querySelectorAll(".split-content-host")
        .forEach((h) => hostMO.observe(h, { attributes: true, attributeFilter: ["style"] }));
    }

    mainRO.observe(main); // sidebar toggle, rotation
    attachHostObservers();
    // The on-screen-keyboard transition (interactive-widget=resizes-content
    // on Android) moves through viewport resizes, a browser focus-reveal
    // scroll, and the host's corrective scrollTo(0,0) — the scroll phases
    // change positions but no sizes, so only these listeners see them.
    // Capture-phase scroll also catches scrollable inner containers.
    const onViewportChange = () => schedule();
    window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      window.removeEventListener("scroll", onViewportChange, { capture: true });
      window.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      bodyRO.disconnect();
      mainRO.disconnect();
      hostMO.disconnect();
    };
  }, [layerRef]);
  return inset;
}
