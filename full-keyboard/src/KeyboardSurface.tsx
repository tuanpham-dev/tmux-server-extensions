import { useEffect, useRef, useState, type PointerEvent } from "react";
import { sendWithInkSafeEnters } from "@tmux-server/engine-support";
import type { TerminalAccessoryContext } from "./client";
import { readTopKeys } from "./client";
import { TouchKeyButton, useTapHandlers, visibleKeys } from "./keyButtons";
import {
  LETTER_PAGE,
  SYMBOL_PAGE_1,
  SYMBOL_PAGE_2,
  resolveLabel,
  resolveSend,
  type KeyDef,
  type Mods,
  type PageId,
} from "./layout";

// The keyboard's visible surface: the special-key top bar over the QWERTY grid,
// owning the one-shot modifier and page state. Reused by both the fixed (docked)
// and floating (overlay) modes — the mode wrappers add visibility, layout, and
// OS-keyboard suppression around it.

const NO_MODS: Mods = { shift: false, ctrl: false, alt: false };

// Backspace autorepeat timing: hold past the delay, then repeat at the
// interval until release — matching a hardware keyboard's typematic feel.
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 40;

// A top-bar Ctrl / Alt key: a one-shot modifier for the QWERTY grid. Unlike a
// {ctrl} top key (which toggles the host's sticky-Ctrl, applied only to
// natively-typed input), this drives the keyboard's own mod state so it
// actually modifies the grid's taps. Styled as a bar key, active when armed.
function ModKey({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  const tap = useTapHandlers(onToggle);
  return (
    <button className={`fk-key fk-key-ctrl${active ? " active" : ""}`} {...tap}>
      {label}
    </button>
  );
}

// The special-key top bar: the grid's Ctrl/Alt one-shot modifiers, followed by
// the customizable Touch-Keys-style key row (Esc/Tab/arrows/^C/mic/image by
// default). Reuses keyButtons' visibleKeys/TouchKeyButton so
// {ctrl}/{mic}/{image}/when-gating behave identically to Touch Keys. Ctrl/Alt
// live here (not on the grid) to match the reference layout — the grid keeps
// only Shift, matching a phone keyboard.
function TopBar({
  context,
  mods,
  onToggleMod,
}: {
  context: TerminalAccessoryContext;
  mods: Mods;
  onToggleMod: (m: "ctrl" | "alt") => void;
}) {
  const shown = visibleKeys(readTopKeys(), context.command);
  return (
    <div className="fk-key-bar">
      <ModKey label="Ctrl" active={mods.ctrl} onToggle={() => onToggleMod("ctrl")} />
      <ModKey label="Alt" active={mods.alt} onToggle={() => onToggleMod("alt")} />
      {shown.map(({ key, data }, i) => (
        <TouchKeyButton
          key={i}
          touchKey={key}
          data={data}
          stickyCtrl={context.stickyCtrl}
          onToggleStickyCtrl={context.toggleStickyCtrl}
          onSendInput={context.sendInput}
          onSendVoiceText={context.sendText}
          onUploadImages={context.uploadImages}
        />
      ))}
    </div>
  );
}

function keyStyle(key: KeyDef): React.CSSProperties {
  return { flexGrow: key.width ?? 1 };
}

// A modifier / utility key reads as secondary (dimmer face); plain character
// and space keys use the default face.
function isModStyled(kind: KeyDef["kind"]): boolean {
  return kind === "shift" || kind === "ctrl" || kind === "alt" || kind === "page" || kind === "enter";
}

// One grid key that sends on a still tap (the same pointerdown-preventDefault
// pattern the top bar uses, so a tap never steals terminal focus). Backspace
// is handled by its own component below (autorepeat), never here.
function GridKey({ keyDef, mods, onPress }: { keyDef: KeyDef; mods: Mods; onPress: (key: KeyDef) => void }) {
  const tap = useTapHandlers(() => onPress(keyDef));
  const kind = keyDef.kind ?? "char";
  const armed =
    (kind === "shift" && mods.shift) || (kind === "ctrl" && mods.ctrl) || (kind === "alt" && mods.alt);
  return (
    <button
      className={`fk-keyboard-key${isModStyled(keyDef.kind) ? " fk-mod" : ""}${armed ? " active" : ""}`}
      style={keyStyle(keyDef)}
      {...tap}
    >
      {resolveLabel(keyDef, mods)}
    </button>
  );
}

// Backspace: sends DEL immediately on press, then repeats after a hold. Its own
// pointer handler (not useTapHandlers, which fires on pointerup) so the repeat
// runs while held; preventDefault on pointerdown keeps terminal focus. Sends
// nothing on release — pointerup only stops the repeat.
function BackspaceKey({ keyDef, onRepeat }: { keyDef: KeyDef; onRepeat: () => void }) {
  const timers = useRef<{ delay?: number; interval?: number }>({});
  const clear = () => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.interval);
    timers.current = {};
  };
  useEffect(() => clear, []);
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    onRepeat();
    timers.current.delay = window.setTimeout(() => {
      timers.current.interval = window.setInterval(onRepeat, REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  };
  return (
    <button
      className="fk-keyboard-key fk-mod"
      style={keyStyle(keyDef)}
      onPointerDown={onPointerDown}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
    >
      {keyDef.label}
    </button>
  );
}

// The top bar + QWERTY grid, with one-shot Shift/Ctrl/Alt, the two symbol pages,
// and Backspace autorepeat. Stateless w.r.t. visibility/placement — the mode
// wrappers decide when and where to render it. `style` carries the mode's
// full-bleed offset (a negative margin-left that widens the surface out to the
// screen edge past the terminal area's inset).
export default function KeyboardSurface({
  context,
  style,
}: {
  context: TerminalAccessoryContext;
  style?: React.CSSProperties;
}) {
  const [mods, setMods] = useState<Mods>(NO_MODS);
  const [page, setPage] = useState<PageId>("letters");

  const toggleMod = (m: "ctrl" | "alt") => setMods((prev) => ({ ...prev, [m]: !prev[m] }));

  const press = (key: KeyDef) => {
    const kind = key.kind ?? "char";
    if (kind === "shift") return setMods((m) => ({ ...m, shift: !m.shift }));
    if (kind === "page") return setPage(key.target ?? "letters");
    // char / space / enter — resolve to bytes, then disarm one-shot modifiers.
    sendWithInkSafeEnters(resolveSend(key, mods), context.sendInput);
    if (mods.shift || mods.ctrl || mods.alt) setMods(NO_MODS);
  };

  const sendBackspace = () => context.sendInput("\x7f");

  const rows = page === "letters" ? LETTER_PAGE : page === "symbols1" ? SYMBOL_PAGE_1 : SYMBOL_PAGE_2;

  return (
    <div className="fk-surface" style={style}>
      <TopBar context={context} mods={mods} onToggleMod={toggleMod} />
      <div className="fk-keyboard">
        {rows.map((row, r) => (
          <div className="fk-keyboard-row" key={r}>
            {row.map((key, c) => {
              const kind = key.kind ?? "char";
              if (kind === "spacer") {
                // A non-interactive gap that staggers the row — occupies its
                // width but renders nothing tappable.
                return <div key={c} className="fk-keyboard-spacer" style={{ flex: `${key.width ?? 1} 1 0` }} aria-hidden="true" />;
              }
              if (kind === "backspace") return <BackspaceKey key={c} keyDef={key} onRepeat={sendBackspace} />;
              return <GridKey key={c} keyDef={key} mods={mods} onPress={press} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
