// ghostty-web implementation of the TerminalEngine seam — moved verbatim
// from core client/src/engines/ghostty.ts when both engines became bundled
// extensions. Nothing outside this extension may import "ghostty-web" or
// its renderer shims.
import { FitAddon, init as initGhostty, Terminal } from "ghostty-web";
import {
  applyRendererOverrides,
  parseHexColor,
  type RendererShim,
} from "./shims";
import { cellFromPoint, markSyntheticSelectStart } from "@tmux-server/engine-support";
import { buildLinkProvider, stitchLine } from "./links";
import type {
  CellPosition,
  TerminalEngineHandle,
  TerminalEngineOptions,
  TerminalEngineSettings,
} from "./terminalEngineTypes";

// ghostty-web's terminal core is WASM; init() compiles/instantiates the
// (bundle-inlined) module once, shared by every Terminal instance.
// Memoized here (rather than gating the whole app on it in main.tsx) so
// the app renders immediately and only whichever engine is actually
// selected pays this cost, on its own first use.
let ghosttyReady: Promise<void> | null = null;
function ensureGhosttyReady(): Promise<void> {
  if (!ghosttyReady) ghosttyReady = initGhostty();
  return ghosttyReady;
}

export async function createGhosttyEngine(options: TerminalEngineOptions): Promise<TerminalEngineHandle> {
  await ensureGhosttyReady();
  const {
    screen,
    settings: initialSettings,
    theme,
    isVisible,
    onData,
    resolvePaths,
    onOpenUrl,
    onOpenFile,
    onOpenFileSecondary,
    onLinkHoverChange,
  } = options;

  let disposed = false;

  const term = new Terminal({
    cursorBlink: initialSettings.cursorBlink,
    cursorStyle: initialSettings.cursorStyle,
    fontSize: initialSettings.fontSize,
    fontFamily: initialSettings.fontFamily,
    // Full theme application (incl. the ANSI-16 palette baked into the
    // WASM terminal config) only happens at construction — runtime theme
    // swaps are unsupported by ghostty-web 0.4.0, so TerminalView remounts
    // the whole engine on a theme change instead.
    theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  // ghostty-web 0.4.0's SelectionManager registers an anonymous document
  // "mousedown" listener (its mouseDownTarget tracker) during open() but
  // never removes it in dispose() — every terminal ever opened would leak
  // its renderer/WASM graph via that listener's closure until the page
  // reloads. Capture it here (this intercept is strictly synchronous
  // around open(), nothing else runs in between) and remove it ourselves
  // in dispose() below.
  const leakedMousedownListeners: [EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
  const realAddEventListener = document.addEventListener;
  document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    if (type === "mousedown") leakedMousedownListeners.push([listener, opts]);
    return realAddEventListener.call(document, type, listener, opts);
  }) as typeof document.addEventListener;
  term.open(screen);
  document.addEventListener = realAddEventListener;

  // ghostty-web's open() makes the screen div contenteditable and leaves
  // it focused (its trailing this.focus()). On touch devices that arms the
  // on-screen keyboard: Android pops it on ANY later touch of a focused
  // editable — swipes included, no focus() call involved. Blurring after
  // open() proved insufficient — the div ended up focused again through
  // native paths — so remove editability itself: a focused non-editable
  // div cannot summon the keyboard. Typing is unaffected on touch — the
  // hidden textarea is the IME target and its key/composition/beforeinput
  // events bubble to this container where ghostty's InputHandler and the
  // Android bridge below listen.
  if (window.matchMedia("(pointer: coarse)").matches) {
    screen.removeAttribute("contenteditable");
    screen.removeAttribute("role");
    screen.blur();
  }

  // Display settings ghostty-web has no options for — lineHeight,
  // letterSpacing, minimumContrastRatio, textThickness — applied by
  // shimming the renderer (ghosttyShims.ts). The shim re-measures
  // immediately; resize the canvas to the current grid so the adjusted
  // metrics are live before the first fit.
  const rendererShim: RendererShim = applyRendererOverrides(
    term.renderer!,
    {
      lineHeight: initialSettings.lineHeight,
      letterSpacing: initialSettings.letterSpacing,
      minimumContrastRatio: initialSettings.minimumContrastRatio,
      textThickness: initialSettings.textThickness,
    },
    parseHexColor(theme.background),
  );

  // Bounce fontFamily to run ghostty's handleFontChange — the only public
  // path that both resizes the canvas to the (now shimmed) metrics AND
  // force-renders. A bare renderer.resize() clears the canvas without
  // repainting (the dirty tracker still says clean).
  const bounceFont = () => {
    const family = term.options.fontFamily;
    term.options.fontFamily = `${family} `;
    term.options.fontFamily = family;
  };
  bounceFont();

  // ghostty-web drives an unconditional requestAnimationFrame loop
  // (startRenderLoop): every terminal repaints every frame for as long as
  // it exists, whether or not it is on screen. Browsers only THROTTLE
  // background tabs (~20fps) rather than stopping them, and a terminal on
  // an inactive editor tab keeps painting too. Skip the paint when there is
  // nothing to look at — output still streams into the WASM terminal and
  // marks its rows dirty, so reveal() below can force-render without a
  // stale frame being shown.
  //
  // Also this engine's ONLY source of render-completion notifications:
  // ghostty-web 0.4.0's own `term.onRender` is dead code — its backing
  // emitter is constructed and exposed but `.fire()` is never called
  // anywhere in the bundle (confirmed by reading the shipped source; a
  // bare Terminal never fires it even after real writes). Fan out from
  // here instead, since this wrapper already runs on every actual paint.
  const renderListeners = new Set<() => void>();
  const renderer = term.renderer!;
  const originalRender = renderer.render.bind(renderer);
  renderer.render = ((...args: Parameters<typeof originalRender>) => {
    if (disposed) return;
    if (!isVisible() || document.hidden) return;
    const result = originalRender(...args);
    for (const cb of renderListeners) cb();
    return result;
  }) as typeof renderer.render;

  if (import.meta.env.DEV) {
    // Debug handles for devtools poking (e.g. term.getMode(1002) while
    // QA-ing mouse forwarding, or shim overrides while QA-ing display
    // settings) — point at the most recently mounted terminal; never
    // present in production builds.
    (window as unknown as { __term?: Terminal }).__term = term;
    (window as unknown as { __termShim?: RendererShim }).__termShim = rendererShim;
  }

  // Ctrl+click (Cmd+click on Mac) links: URLs and local file paths
  // detected by terminalLinks.ts's own regex provider. Activation is gated
  // on the modifier by the caller's mouse-capture layer, which reads
  // onLinkHoverChange's activate callback. (OSC 8 hyperlinks are dropped:
  // ghostty-web 0.4.0 stubs getHyperlinkUri() to null.)
  //
  // ghostty-web's link hover callback is hover(isHovered: boolean) with no
  // MouseEvent, so the tooltip is positioned from a dedicated mousemove
  // tracker here rather than reusing the caller's own gesture listeners.
  const lastMouse = { x: 0, y: 0 };
  const onTooltipMouseMove = (e: MouseEvent) => {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
  };
  screen.addEventListener("mousemove", onTooltipMouseMove);
  const hoverTooltip = document.createElement("div");
  hoverTooltip.className = "terminal-link-tooltip";
  term.element?.appendChild(hoverTooltip);
  const showTooltip = (text: string) => {
    const hostRect = term.element?.getBoundingClientRect();
    if (!hostRect) return;
    hoverTooltip.textContent = text;
    hoverTooltip.style.left = `${lastMouse.x - hostRect.left + 12}px`;
    hoverTooltip.style.top = `${lastMouse.y - hostRect.top + 16}px`;
    hoverTooltip.style.display = "block";
  };
  const hideTooltip = () => {
    hoverTooltip.style.display = "none";
  };

  // ghostty-web auto-registers its own OSC8LinkProvider (dead in 0.4.0)
  // and UrlRegexProvider (no modifier gate, wins getLinkAt over later
  // providers, bypasses the hover tooltip). Both would starve the app's
  // provider, so clear the detector and register ours as the only one.
  // Reaches into a private field — ghostty-web is pinned to exactly 0.4.0
  // partly for this.
  (term as unknown as { linkDetector?: { providers: unknown[] } }).linkDetector?.providers.splice(0);

  term.registerLinkProvider(
    buildLinkProvider(term, {
      resolvePaths,
      onOpenUrl,
      onOpenFile,
      onOpenFileSecondary,
      onHoverChange: (link) => {
        if (link) {
          showTooltip(link.text);
          onLinkHoverChange((e) => link.activate(e));
        } else {
          hideTooltip();
          onLinkHoverChange(null);
        }
      },
    }),
  );

  const dataSub = term.onData(onData);

  // Android soft-keyboard bridge. Mobile IMEs report almost every key as
  // keydown keyCode 229 — which ghostty-web's InputHandler deliberately
  // ignores — and deliver the actual text as a beforeinput on the focused
  // editable; both bubble through `screen`. 0.4.0 has no beforeinput
  // handling at all, so without this bridge every character typed on
  // Android is silently dropped. Upstream added the equivalent handler
  // after 0.4.0 (handleBeforeInput in lib/input-handler.ts on main); this
  // mirrors its inputType mapping and its value+time de-dup of an
  // insertText that echoes a just-committed composition — drop the bridge
  // when a release ships it. Events during composition are skipped:
  // ghostty already forwards the committed text on compositionend. Desktop
  // typing can't double-send: every keydown InputHandler forwards is
  // preventDefault()ed, so it never produces a beforeinput.
  //
  // insertCompositionText / insertFromComposition join the same case as
  // insertText: Gboard (and other predictive keyboards) commit a composed
  // word — including its auto-appended trailing space — through one of
  // these two inputTypes rather than insertText, even for plain English
  // typing with no real IME composition involved. Only reachable once
  // isComposing is false (the guard below), so this can't intercept a
  // still-in-progress composition, only its committed result — the same
  // text ghostty's own compositionend handler already forwarded once, so
  // the existing de-dup guard still applies. Before this, every word
  // committed this way (which is most Android typing) was silently
  // dropped by the `default: return` below — the space was just the most
  // visible casualty, since it sits at the boundary of every word commit.
  let lastCompositionData = "";
  let lastCompositionTime = 0;
  const onCompositionEnd = (e: CompositionEvent) => {
    // Runs after ghostty's own compositionend handler (registered earlier
    // on the same element), which has already read e.data and forwarded
    // it — clearing here can't lose input. Composition text is the one
    // insertion the blanket preventDefault can't cancel, so it
    // accumulates in the hidden textarea; ghostty only cleans the
    // container's text nodes, never textarea.value. Left in place, the
    // IME treats the previous command as context and re-composes against
    // its last word, committing data that repeats already-sent text. Same
    // reset xterm.js does after every commit.
    if (term.textarea) term.textarea.value = "";
    if (!e.data) return;
    lastCompositionData = e.data;
    lastCompositionTime = performance.now();
  };
  const onBeforeInput = (e: InputEvent) => {
    if (e.isComposing) return;
    let out: string | null;
    switch (e.inputType) {
      case "insertText":
      case "insertReplacementText":
      case "insertCompositionText":
      case "insertFromComposition":
        out = e.data ? e.data.replace(/\n/g, "\r") : null;
        break;
      case "insertLineBreak":
      case "insertParagraph":
        out = "\r";
        break;
      case "deleteContentBackward":
        out = "\x7f";
        break;
      case "deleteContentForward":
        out = "\x1b[3~";
        break;
      default:
        return;
    }
    e.preventDefault();
    if (out === null) return;
    if (
      e.data !== null &&
      e.data === lastCompositionData &&
      performance.now() - lastCompositionTime < 100
    ) {
      lastCompositionData = "";
      return;
    }
    onData(out);
  };
  // Predictive keyboards deliver nothing through onData/beforeinput at all
  // until a word actually commits — compositionupdate is the only signal
  // available for previewing the in-progress word before then. `data` here
  // is the composition's current full text (not a delta), matching what
  // compositionend/onCompositionEnd above already reads the same way.
  let composingHandler: ((text: string | null) => void) | null = null;
  const onCompositionUpdate = (e: CompositionEvent) => composingHandler?.(e.data);
  const onCompositionEndForPreview = () => composingHandler?.(null);
  screen.addEventListener("compositionend", onCompositionEnd);
  screen.addEventListener("compositionend", onCompositionEndForPreview);
  screen.addEventListener("compositionupdate", onCompositionUpdate);
  screen.addEventListener("beforeinput", onBeforeInput);

  const cellFromPointOnEngine = (clientX: number, clientY: number): CellPosition => {
    const r = term.renderer!;
    return cellFromPoint(
      clientX,
      clientY,
      r.getCanvas().getBoundingClientRect(),
      r.charWidth,
      r.charHeight,
      term.cols,
      term.rows,
    );
  };

  const handle: TerminalEngineHandle = {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (data) => term.write(data),
    focus: () => term.focus(),
    focusInput: () => term.textarea?.focus(),
    setSoftKeyboardSuppressed: (suppressed) => {
      // inputmode="none" is the standard "focusable but no virtual
      // keyboard" mechanism — hardware/app-drawn input still lands in the
      // textarea's key events.
      if (!term.textarea) return;
      if (suppressed) term.textarea.setAttribute("inputmode", "none");
      else term.textarea.removeAttribute("inputmode");
    },
    getSelection: () => term.getSelection(),
    clearSelection: () => term.clearSelection(),
    clear: () => term.clear(),
    // The one synthetic event left (down from the xterm era's
    // press/release replay pairs): a threshold-crossed plain drag starts
    // ghostty's local selection by re-dispatching a mousedown on the
    // canvas at the original press point — SelectionManager's listeners
    // don't gate on isTrusted — after which the real mousemove stream
    // extends the selection natively (and its mouseup handler finalizes +
    // copies it). Marked so the caller's onCapture passes it through
    // instead of re-swallowing it: dispatching on the canvas still
    // capture-descends through the screen div.
    beginLocalSelection: (clientX, clientY) => {
      const canvas = term.renderer?.getCanvas();
      if (!canvas) return;
      const synthetic = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: 1,
        clientX,
        clientY,
        button: 0,
        buttons: 1,
      });
      markSyntheticSelectStart(synthetic);
      canvas.dispatchEvent(synthetic);
    },
    // Spike finding (mobile-touch-select-copy-open.md): term.select() clamps
    // its row argument to rows-1, so it silently can't reach any visible row
    // once real scrollback exists — unusable here. Replays the full
    // mousedown/mousemove/mouseup gesture on the canvas instead (same
    // mechanism as beginLocalSelection above, extended to a synthetic
    // mousemove + mouseup so the selection both extends to the end cell and
    // finalizes without a real drag). All three marked so onCapture passes
    // them through.
    selectCells: (col, row, length) => {
      const r = term.renderer!;
      const canvas = r.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const cols = term.cols;
      const endLinear = row * cols + col + length - 1;
      const endCol = endLinear % cols;
      const endRow = Math.floor(endLinear / cols);
      const pixelOf = (c: number, rw: number) => ({
        x: rect.left + (c + 0.5) * r.charWidth,
        y: rect.top + (rw + 0.5) * r.charHeight,
      });
      const start = pixelOf(col, row);
      const end = pixelOf(endCol, endRow);
      const dispatch = (type: string, x: number, y: number, buttons: number) => {
        const ev = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          detail: 1,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
        });
        markSyntheticSelectStart(ev);
        canvas.dispatchEvent(ev);
      };
      dispatch("mousedown", start.x, start.y, 1);
      dispatch("mousemove", end.x, end.y, 1);
      dispatch("mouseup", end.x, end.y, 0);
    },
    readStitchedLine: (row) => stitchLine(term, row),
    cellFromPoint: cellFromPointOnEngine,
    getCharHeight: () => term.renderer!.charHeight,
    getMode: (mode) => term.getMode(mode),
    fit: () => {
      if (disposed) return null;
      if (screen.clientWidth === 0 || screen.clientHeight === 0) return null;
      fit.fit();
      return { cols: term.cols, rows: term.rows };
    },
    // Repaint everything that changed while the paint was suppressed. The
    // fontFamily bounce is the one public path that both re-sizes the
    // canvas to the shimmed metrics AND force-renders, which is exactly
    // what a terminal returning to screen needs.
    reveal: () => {
      if (disposed) return;
      bounceFont();
    },
    setSettings: (s: TerminalEngineSettings) => {
      term.options.fontFamily = s.fontFamily;
      term.options.fontSize = s.fontSize;
      term.options.cursorStyle = s.cursorStyle;
      term.options.cursorBlink = s.cursorBlink;
      rendererShim.setOverrides({
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        minimumContrastRatio: s.minimumContrastRatio,
        textThickness: s.textThickness,
      });
      // Same rationale as the construction-time bounce: handleFontChange
      // is the one public path that re-sizes AND force-renders with the
      // shimmed metrics — a shim-only change (e.g. contrast ratio) must
      // repaint even though no terminal cell went dirty.
      bounceFont();
    },
    // A newly-loaded extension font needs a re-measure even though
    // options.fontFamily was already set to its name (while the face was
    // still loading, so glyphs rendered in whatever fallback matched
    // first) — ghostty's option Proxy only reacts to an actual value
    // *change*, so reassigning the same string is a no-op; bounceFont
    // forces it.
    refreshFonts: () => bounceFont(),
    // ghostty-web's custom key/wheel handler semantics are INVERTED from
    // xterm.js: a truthy return means "handled — preventDefault and skip
    // the terminal's own encoding", which already matches this interface's
    // convention 1:1, so no translation is needed here (xterm's adapter
    // will need one).
    onKeyEvent: (handler) => {
      term.attachCustomKeyEventHandler((e) => handler(e));
    },
    // attachCustomWheelEventHandler SETS the one handler (it doesn't
    // stack) — the caller is expected to register exactly one.
    onWheelEvent: (handler) => {
      term.attachCustomWheelEventHandler((e) => handler(e));
    },
    onComposingChange: (handler) => {
      composingHandler = handler;
    },
    dispatchSyntheticWheel: (init) => {
      term.renderer?.getCanvas().dispatchEvent(new WheelEvent("wheel", init));
    },
    // Screen-relative → buffer index. The offset is derived from the
    // buffer object itself (length − rows: the screen is the buffer's
    // last page) and NOT from term.getScrollbackLength() — after lines
    // scroll off and get discarded (this app runs with no local
    // scrollback; tmux owns it), ghostty-web's scrollback counter keeps
    // counting lines the buffer no longer holds (seen live: counter 6
    // with length == rows == 50), which shifted every read 6 rows down
    // and dragged the local-echo overlay 6 rows up the screen.
    readLine: (row) => {
      const buf = term.buffer.active;
      const idx = Math.max(0, buf.length - term.rows) + row;
      const line = buf.getLine(idx);
      if (!line) return "";
      return line.translateToString(true, 0, term.cols);
    },
    getCursor: () => ({ col: term.buffer.active.cursorX, row: term.buffer.active.cursorY }),
    // Always false: this app never scrolls ghostty locally — tmux owns all
    // scrollback, and a touch-swipe/wheel scrolls tmux copy-mode, not this
    // terminal (its own scrollback is the phantom counter readLine's
    // comment above describes). viewportY still drifts nonzero when the
    // swipe gesture's synthetic wheels hit ghostty's default handler, and
    // it never comes back — one swipe then permanently hid the local-echo
    // overlay AND disabled its word-flush (anchorIsStable can only be set
    // by a render that actually runs), caught live on a phone as "typing
    // shows nothing until Enter".
    isScrolledUp: () => false,
    // term.renderer's own charWidth/charHeight already reflect the shim's
    // lineHeight/letterSpacing overrides — the shim works by patching the
    // renderer's internal measureFont(), so every public metric derived
    // from it (including these) is already adjusted, same as
    // cellFromPointOnEngine/getCharHeight above rely on.
    getCellMetrics: () => ({ width: term.renderer!.charWidth, height: term.renderer!.charHeight }),
    onRender: (cb) => {
      renderListeners.add(cb);
      return () => renderListeners.delete(cb);
    },
    dispose: () => {
      disposed = true;
      screen.removeEventListener("mousemove", onTooltipMouseMove);
      screen.removeEventListener("compositionend", onCompositionEnd);
      screen.removeEventListener("compositionend", onCompositionEndForPreview);
      screen.removeEventListener("compositionupdate", onCompositionUpdate);
      screen.removeEventListener("beforeinput", onBeforeInput);
      dataSub.dispose();
      renderListeners.clear();
      hoverTooltip.remove();
      term.dispose();
      for (const [listener, opts] of leakedMousedownListeners) {
        document.removeEventListener("mousedown", listener, opts);
      }
    },
  };

  return handle;
}
