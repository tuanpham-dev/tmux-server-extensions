// The settings resolvers, which turn stored values into what the editor is
// actually configured with. Only the "auto" modes have logic worth pinning:
// they read a *second* setting, so a wrong answer there is a setting that
// silently does nothing.
import { strict as assert } from "node:assert";
import { test } from "node:test";

const src = await import("./settings.ts");
const { setSettingsApi, clearSettingsApi, lineNumbersMode, lineNumbersOption, vimEnabled } = src;

// Stands in for the host's settings API: a plain bag of values, plus the
// onDidChange the module subscribes to at wiring time.
function withSettings(values: Record<string, unknown>): void {
  clearSettingsApi();
  setSettingsApi({ get: (key: string) => values[key], onDidChange: () => () => {} });
}

test("lineNumbers falls back to auto for a missing or unknown value", () => {
  withSettings({});
  assert.equal(lineNumbersMode(), "auto");
  withSettings({ "textEditor.lineNumbers": "sideways" });
  assert.equal(lineNumbersMode(), "auto");
  // The pre-2.3.0 stored shape: the key simply isn't there yet.
  withSettings({ "textEditor.vim": true });
  assert.equal(lineNumbersMode(), "auto");
});

test("auto follows the vim setting", () => {
  withSettings({ "textEditor.lineNumbers": "auto", "textEditor.vim": true });
  assert.equal(lineNumbersOption(), "relative");
  withSettings({ "textEditor.lineNumbers": "auto", "textEditor.vim": false });
  assert.equal(lineNumbersOption(), "on");
  // vim unset is vim off, so an untouched install keeps absolute numbers.
  withSettings({});
  assert.equal(vimEnabled(), false);
  assert.equal(lineNumbersOption(), "on");
});

test("an explicit mode wins over vim in both directions", () => {
  for (const vim of [true, false]) {
    withSettings({ "textEditor.lineNumbers": "on", "textEditor.vim": vim });
    assert.equal(lineNumbersOption(), "on");
    withSettings({ "textEditor.lineNumbers": "relative", "textEditor.vim": vim });
    assert.equal(lineNumbersOption(), "relative");
    withSettings({ "textEditor.lineNumbers": "off", "textEditor.vim": vim });
    assert.equal(lineNumbersOption(), "off");
  }
});

test("every resolved value is one Monaco accepts", () => {
  const allowed = new Set(["on", "relative", "off"]);
  for (const mode of ["auto", "on", "relative", "off", undefined, "nonsense"]) {
    for (const vim of [true, false]) {
      withSettings({ "textEditor.lineNumbers": mode, "textEditor.vim": vim });
      assert.ok(allowed.has(lineNumbersOption()), `${String(mode)}/${vim} -> ${lineNumbersOption()}`);
    }
  }
});
