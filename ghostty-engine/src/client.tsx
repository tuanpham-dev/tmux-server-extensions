// ghostty-engine: the ghostty-web (WASM) terminal engine, installable from
// the registry. When it isn't installed the app falls back to the required,
// bundled xterm-engine. See src/engine.ts and src/shims.ts (the CanvasRenderer
// display-setting shims that moved with it).
import type { CreateTerminalEngine } from "./terminalEngineTypes";
import { createGhosttyEngine } from "./engine";

interface ExtensionContext {
  registerTerminalEngine(engine: { id: string; label: string; create: CreateTerminalEngine }): void;
}

export function activate(ctx: ExtensionContext): void {
  ctx.registerTerminalEngine({ id: "ghostty", label: "Ghostty", create: createGhosttyEngine });
}

export function deactivate(): void {
  // Nothing to tear down: the engine registry entry is removed by the host,
  // and live engine instances are disposed by their own TerminalViews.
}
