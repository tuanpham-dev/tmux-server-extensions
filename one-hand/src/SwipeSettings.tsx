import { DEFAULT_ACTIONS, type SwipeDirection } from "./actions";
import { listCommands, readActionsSetting, useOneHandSettingsTick, writeActions } from "./client";

const DIRECTIONS: { dir: SwipeDirection; label: string }[] = [
  { dir: "left", label: "Swipe left" },
  { dir: "right", label: "Swipe right" },
  { dir: "up", label: "Swipe up" },
];

// The picker rendered inside this extension's Settings section
// (registerSettingsComponent): one dropdown per swipe direction, listing every
// runnable command the host reports (ctx.app.getCommands) plus a "None" entry.
// Persists to oneHand.actions via writeActions.
export default function SwipeSettings() {
  useOneHandSettingsTick();
  const actions = readActionsSetting();
  // Snapshot of runnable commands, sorted by label for a scannable list.
  const commands = [...listCommands()].sort((a, b) => a.label.localeCompare(b.label));

  const setDir = (dir: SwipeDirection, commandId: string) => {
    writeActions({ ...actions, [dir]: commandId });
  };

  return (
    <div className="one-hand-settings">
      <p className="one-hand-settings-hint">
        Swipe over the transparent bar at the bottom of the editor to run a command. Choose one per
        direction, or “None” to disable it.
      </p>
      {DIRECTIONS.map(({ dir, label }) => (
        <label key={dir} className="one-hand-settings-row">
          <span className="one-hand-settings-label">{label}</span>
          <select
            className="one-hand-settings-select"
            value={actions[dir]}
            onChange={(e) => setDir(dir, e.target.value)}
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
