import { useMemo } from "react";
import { DEFAULT_ACTIONS, type OneHandGesture } from "./actions";
import { listCommands, readActionsSetting, useOneHandSettingsTick, writeActions } from "./client";

const GESTURES: { gesture: OneHandGesture; label: string }[] = [
  { gesture: "left", label: "Swipe left" },
  { gesture: "right", label: "Swipe right" },
  { gesture: "up", label: "Swipe up" },
  { gesture: "doubleTap", label: "Double tap" },
  { gesture: "longPress", label: "Long press" },
];

// The picker rendered inside this extension's Settings section
// (registerSettingsComponent): one dropdown per gesture, listing every
// runnable command the host reports (ctx.app.getCommands) plus a "None" entry.
// Persists to oneHand.actions via writeActions.
export default function SwipeSettings() {
  useOneHandSettingsTick();
  const actions = readActionsSetting();
  // Snapshot of runnable commands, sorted by label for a scannable list.
  // Memoized so the settings-tick re-render (on any oneHand.* change) doesn't
  // re-copy + re-sort the whole command list each time. Commands are
  // registered at startup, before this panel opens, so an empty dep list is
  // safe.
  const commands = useMemo(() => [...listCommands()].sort((a, b) => a.label.localeCompare(b.label)), []);

  const setGesture = (gesture: OneHandGesture, commandId: string) => {
    writeActions({ ...actions, [gesture]: commandId });
  };

  return (
    <div className="one-hand-settings">
      <p className="one-hand-settings-hint">
        Swipe, double-tap, or press and hold the transparent bar at the bottom of the editor to run a
        command. Choose one per gesture, or “None” to disable it. Double tap and long press ship
        unbound; a single tap never runs anything.
      </p>
      {GESTURES.map(({ gesture, label }) => (
        <label key={gesture} className="one-hand-settings-row">
          <span className="one-hand-settings-label">{label}</span>
          <select
            className="one-hand-settings-select"
            value={actions[gesture]}
            onChange={(e) => setGesture(gesture, e.target.value)}
          >
            <option value="">None</option>
            {commands.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button className="one-hand-settings-restore" onClick={() => writeActions({ ...DEFAULT_ACTIONS })}>
        Restore defaults
      </button>
    </div>
  );
}
