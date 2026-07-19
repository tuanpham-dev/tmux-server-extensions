import { useEffect, useRef, useState, type PointerEvent } from "react";
import { sendWithInkSafeEnters, whenMatches } from "@tmux-server/engine-support";
import { parseSend, type TouchKey } from "./spec";
import { isVoiceInputSupported, VoiceInput } from "./voiceInput";

// The special-key top bar's button family — ported from
// extensions/touch-keys/src/TouchKeyBar.tsx, with CSS classes renamed
// .touch-key* -> .fk-key* so full-keyboard styles itself even when touch-keys
// is disabled. useTapHandlers and visibleKeys are exported for reuse by
// FullKeyboard.tsx (the QWERTY grid) and TopKeysEditor.tsx.

// Filters `keys` down to the ones that should render right now: `when`
// matched against currentCommand, and `send` successfully parsed (a key
// authored with a bad token, or still empty mid-edit in Settings, is
// skipped rather than rendered broken). `{mic}` is filtered out entirely on
// a browser without SpeechRecognition.
export function visibleKeys(
  keys: TouchKey[],
  currentCommand: string,
): { key: TouchKey; data: string }[] {
  const result: { key: TouchKey; data: string }[] = [];
  for (const key of keys) {
    if (!whenMatches(key.when, currentCommand)) continue;
    if (key.send === "{ctrl}") {
      result.push({ key, data: "" });
      continue;
    }
    if (key.send === "{mic}") {
      if (isVoiceInputSupported()) result.push({ key, data: "" });
      continue;
    }
    if (key.send === "{image}") {
      result.push({ key, data: "" });
      continue;
    }
    const parsed = parseSend(key.send);
    if ("error" in parsed || parsed.data === "") continue;
    result.push({ key, data: parsed.data });
  }
  return result;
}

// Pointer handlers that fire onTap only for a still tap. preventDefault on
// pointerdown keeps focus on the terminal's hidden textarea (so tapping a
// key never dismisses the on-screen keyboard), while the action itself waits
// for pointerup within a small movement threshold: when the bar overflows
// and the user swipes it, the browser's pan takes the pointer (pointercancel,
// no pointerup) — or the finger has moved — so the key the swipe started on
// doesn't send.
export function useTapHandlers(onTap: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      start.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10) onTap();
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}

// Arrow-key autorepeat timing — matches the grid's Backspace repeat.
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 40;

// The arrow keys, by their brace-token `send` — the keys that get hold-to-repeat.
export function isArrowSend(send: string): boolean {
  const s = send.trim().toLowerCase();
  return s === "{up}" || s === "{down}" || s === "{left}" || s === "{right}";
}

// Like useTapHandlers but with hold-to-repeat, for arrow keys: a quick still
// tap fires once on release (preserving the anti-swipe behavior of the
// scrollable bar); holding past REPEAT_DELAY_MS starts firing every
// REPEAT_INTERVAL_MS until release. A horizontal swipe (finger moves before the
// hold begins) cancels without firing, so panning the bar never sends an arrow.
export function useRepeatHandlers(onFire: () => void) {
  const state = useRef<{ x: number; y: number; fired: boolean } | null>(null);
  const timers = useRef<{ delay?: number; interval?: number }>({});
  const clearTimers = () => {
    window.clearTimeout(timers.current.delay);
    window.clearInterval(timers.current.interval);
    timers.current = {};
  };
  useEffect(() => clearTimers, []);
  const stop = () => {
    state.current = null;
    clearTimers();
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      e.preventDefault();
      state.current = { x: e.clientX, y: e.clientY, fired: false };
      timers.current.delay = window.setTimeout(() => {
        if (state.current) state.current.fired = true;
        onFire();
        timers.current.interval = window.setInterval(onFire, REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = state.current;
      if (!s || s.fired) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) >= 10) stop(); // swipe: cancel, no send
    },
    onPointerUp: (e: PointerEvent) => {
      const s = state.current;
      stop();
      // Quick still tap (repeat never started) fires once on release.
      if (s && !s.fired && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10) onFire();
    },
    onPointerCancel: stop,
    onPointerLeave: stop,
  };
}

// A `{mic}` key: toggles a VoiceInput session on tap, sending each final
// transcript through onTranscript. Its own component (unlike the stateless
// {ctrl} branch below) since it owns a VoiceInput instance's lifecycle —
// created once per mount, disposed on unmount.
function MicKeyButton({ label, onTranscript }: { label: string; onTranscript: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const voiceRef = useRef<VoiceInput | null>(null);
  // Ref-mirrored so the VoiceInput instance (created once, in the effect
  // below) always calls the latest onTranscript without needing to be
  // recreated whenever the parent re-renders with a new closure identity.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    const voice = new VoiceInput({
      onFinalResult: (text) => onTranscriptRef.current(text),
      onStateChange: setListening,
    });
    voiceRef.current = voice;
    return () => voice.dispose();
  }, []);

  const tap = useTapHandlers(() => voiceRef.current?.toggle());

  return (
    <button className={`fk-key fk-key-mic${listening ? " active" : ""}`} {...tap}>
      {label}
    </button>
  );
}

// An `{image}` key: opens the native file picker (photo library + camera on
// iOS/Android via accept="image/*") on tap, then hands the picked file to
// onUploadImage — the same upload pipeline desktop paste/drop use. The
// <input> stays hidden and permanently mounted; tap just proxies to its own
// click() (an <input type=file> can't be opened programmatically outside a
// user gesture, so this must fire from the same tap handler every other key
// uses).
function ImageKeyButton({ label, onUploadImage }: { label: string; onUploadImage: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const tap = useTapHandlers(() => inputRef.current?.click());

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onUploadImage(file);
        }}
      />
      <button className="fk-key fk-key-image" {...tap}>
        {label}
      </button>
    </>
  );
}

// One top-bar key button: the sticky-Ctrl toggle for send === "{ctrl}", the
// mic toggle for send === "{mic}", the image picker for send === "{image}",
// otherwise a plain send button. Pointer handlers (not onClick) via
// useTapHandlers so tapping a button never steals focus from the terminal's
// hidden textarea.
export function TouchKeyButton({
  touchKey,
  data,
  stickyCtrl,
  onToggleStickyCtrl,
  onSendInput,
  onSendVoiceText,
  onUploadImage,
}: {
  touchKey: TouchKey;
  data: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
  onSendVoiceText: (text: string) => void;
  onUploadImage: (file: File) => void;
}) {
  const isCtrl = touchKey.send === "{ctrl}";
  const fire = () => {
    if (isCtrl) onToggleStickyCtrl();
    else sendWithInkSafeEnters(data, onSendInput);
  };
  // Arrow keys hold-to-repeat; every other key is a single tap. Both hooks run
  // unconditionally (hook rules); the plain button below picks which to spread.
  const tap = useTapHandlers(fire);
  const repeat = useRepeatHandlers(fire);
  if (touchKey.send === "{mic}") {
    return <MicKeyButton label={touchKey.label} onTranscript={onSendVoiceText} />;
  }
  if (touchKey.send === "{image}") {
    return <ImageKeyButton label={touchKey.label} onUploadImage={onUploadImage} />;
  }
  if (isCtrl) {
    return (
      <button className={`fk-key fk-key-ctrl${stickyCtrl ? " active" : ""}`} {...tap}>
        {touchKey.label}
      </button>
    );
  }
  return (
    <button className="fk-key" {...(isArrowSend(touchKey.send) ? repeat : tap)}>
      {touchKey.label}
    </button>
  );
}
