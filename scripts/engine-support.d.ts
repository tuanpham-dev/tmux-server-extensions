// Types for the "@tmux-server/engine-support" runtime shim (see
// shims/engine-support.mjs) — the host's engine-support helpers, exposed to
// extension bundles the same way React is. Signatures mirror the host
// modules they re-export (client/src: mouseReports.ts, terminalLinks.ts,
// engines/types.ts, contrast.ts).
declare module "@tmux-server/engine-support" {
  export function cellFromPoint(
    x: number,
    y: number,
    rect: { left: number; top: number },
    charWidth: number,
    charHeight: number,
    cols: number,
    rows: number,
  ): { col: number; row: number };

  export interface Candidate {
    kind: "url" | "path";
    startIdx: number;
    endIdx: number;
    text: string;
    target: string;
    line?: number;
  }
  export function findCandidates(text: string): Candidate[];

  export function isOpenGesture(event: MouseEvent): boolean;
  export function openUrl(url: string): void;
  export const MAX_STITCH_LINES: number;

  export function markSyntheticSelectStart(event: MouseEvent): void;
  export function isSyntheticSelectStart(event: MouseEvent): boolean;

  export type Rgb = readonly [number, number, number];
  export function ensureContrastRatio(fg: Rgb, bg: Rgb, ratio: number): Rgb | undefined;

  // Terminal input utilities (client/src/lib/terminalInput.ts) — shared
  // with the touch-keys extension.
  export function whenMatches(when: string, command: string): boolean;
  export function sendWithInkSafeEnters(data: string, send: (chunk: string) => void): void;
}
