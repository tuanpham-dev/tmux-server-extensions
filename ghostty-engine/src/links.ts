// ghostty-web link-provider adapter — moved from core terminalLinks.ts
// (whose generic candidate detection stayed core, shared via the
// @tmux-server/engine-support shim) when the engine became this extension.
import type { ILink, ILinkProvider, Terminal } from "ghostty-web";
import { findCandidates, isOpenGesture, MAX_STITCH_LINES } from "@tmux-server/engine-support";

// ghostty-web calls provideLinks once per hovered *row*, but a long line can
// wrap across several rows and a path/URL can span the wrap boundary. Walk to
// the start of the logical line, then concatenate every wrapped row's full
// (unwrapped-width) text so buffer-index math stays a fixed `cols`-wide
// stride per row.
export function stitchLine(term: Terminal, y: number): { text: string; startLine: number } | null {
  const buffer = term.buffer.active;
  let startLine = y;
  for (let i = 0; i < MAX_STITCH_LINES && buffer.getLine(startLine)?.isWrapped; i++) {
    startLine--;
  }
  const cols = term.cols;
  const parts: string[] = [];
  let endLine = startLine;
  for (let i = 0; i < MAX_STITCH_LINES; i++) {
    const line = buffer.getLine(endLine);
    if (!line) break;
    parts.push(line.translateToString(false, 0, cols));
    const next = buffer.getLine(endLine + 1);
    if (!next?.isWrapped) break;
    endLine++;
  }
  if (!parts.length) return null;
  return { text: parts.join(""), startLine };
}

// 0-based buffer-index -> 0-based ILink buffer position. Unlike xterm (whose
// IBufferCellPosition contract is 1-based), ghostty-web's LinkDetector
// compares range coordinates raw against the 0-based col/row it derives from
// the pointer (isPositionInLink: start.y <= y <= end.y, start.x <= x <= end.x
// inclusive), so no +1 conversion here. `rowOffset` shifts screen-relative
// rows back into the caller's scrollback-offset space — see provideLinks.
function indexToPosition(
  startLine: number,
  cols: number,
  idx: number,
  rowOffset: number,
): { x: number; y: number } {
  return { y: rowOffset + startLine + Math.floor(idx / cols), x: idx % cols };
}

export interface TerminalLinksHandlers {
  resolvePaths: (paths: string[]) => Promise<(string | null)[]>;
  onOpenUrl: (url: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFileSecondary: (path: string, line?: number) => void;
  // Fired with the ILink under the pointer (or null on leave), so the
  // terminal's own mouse-mode interception (see TerminalView's onCapture)
  // can activate it directly without letting a ctrl+click reach tmux.
  onHoverChange: (link: ILink | null) => void;
}

export function buildLinkProvider(term: Terminal, handlers: TerminalLinksHandlers): ILinkProvider {
  return {
    // ghostty-web 0.4.0's hover/click paths pass `y` offset by the local
    // scrollback length (handleClick: `w = scrollbackLen + viewportRow`),
    // but IBuffer.getLine() indexes the visible screen from 0 — an upstream
    // inconsistency (its own built-in providers mis-look-up the same way;
    // verified empirically against a buffer with scrollback). Convert to a
    // screen row here and emit ranges back in the caller's offset space so
    // isPositionInLink's raw comparison matches. Rows inside scrollback
    // history get no links — under tmux the local viewport never scrolls
    // anyway (tmux owns scrollback).
    provideLinks(y, callback) {
      const rowOffset = term.getScrollbackLength();
      const screenY = y - rowOffset;
      if (screenY < 0 || screenY >= term.rows) {
        callback(undefined);
        return;
      }
      const stitched = stitchLine(term, screenY);
      if (!stitched) {
        callback(undefined);
        return;
      }
      const { text, startLine } = stitched;
      const candidates = findCandidates(text);
      if (!candidates.length) {
        callback(undefined);
        return;
      }

      const pathCandidates = candidates.filter((c) => c.kind === "path");
      const resolve = pathCandidates.length
        ? handlers.resolvePaths(pathCandidates.map((c) => c.target))
        : Promise.resolve<(string | null)[]>([]);

      resolve
        .then((resolved) => {
          const links: ILink[] = [];
          let pathIdx = 0;
          for (const c of candidates) {
            let openTarget: string | undefined = c.target;
            let line: number | undefined = c.line;
            if (c.kind === "path") {
              openTarget = resolved[pathIdx] ?? undefined;
              pathIdx++;
              if (!openTarget) continue; // not a real file — no link
            }
            const range = {
              start: indexToPosition(startLine, term.cols, c.startIdx, rowOffset),
              end: indexToPosition(startLine, term.cols, c.endIdx - 1, rowOffset),
            };
            const kind = c.kind;
            const target = openTarget;
            // `link` is referenced from within its own hover closure below —
            // safe because it only runs later, once the object (and this
            // const binding) is fully initialized. ghostty-web has no
            // decorations field (its renderer underlines the hovered range
            // itself) and signals leave as hover(false) rather than a
            // separate callback.
            const link: ILink = {
              range,
              text: c.text,
              activate(event) {
                if (!isOpenGesture(event)) return;
                if (kind === "url") {
                  handlers.onOpenUrl(target);
                } else if (event.shiftKey) {
                  // Ctrl (or Cmd) is already required to reach here via
                  // isOpenGesture above, so this is Ctrl+Shift+click (Cmd+
                  // Shift+click on mac) — the secondary-open modifier, same
                  // as everywhere else in the app.
                  handlers.onOpenFileSecondary(target, line);
                } else {
                  handlers.onOpenFile(target, line);
                }
              },
              hover: (isHovered) => handlers.onHoverChange(isHovered ? link : null),
            };
            links.push(link);
          }
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  };
}
