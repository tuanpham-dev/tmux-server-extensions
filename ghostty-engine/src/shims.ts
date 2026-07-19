// App-side shims over ghostty-web 0.4.0's CanvasRenderer for the display
// settings its options surface doesn't cover: lineHeight, letterSpacing, and
// minimumContrastRatio. Both shims lean on internals verified against the
// pinned dist source (ghostty-web is pinned to exactly 0.4.0 partly for
// this, alongside TerminalView's linkDetector.providers splice):
//
//  - Every geometry consumer — cell rects, glyph baseline, cursor,
//    selection's pixelToCell, FitAddon, TerminalView's mouse-report cell
//    math — reads the renderer's one private `metrics` {width, height,
//    baseline} object, refreshed only by remeasureFont(). Wrapping that
//    method and post-adjusting the measurement applies line height and
//    letter spacing coherently everywhere at once.
//
//  - renderCellText (a stable prototype method in the dist) picks the text
//    color from the cell's resolved RGB fields right before drawing.
//    Shadowing it per-instance and adjusting those fields first gives the
//    minimum-contrast behavior xterm implemented in its renderer; pass 1
//    (renderCellBackground) has already painted by then, and the cell pool
//    is refilled from WASM every frame, so the mutation can't leak.
import type { CanvasRenderer, GhosttyCell } from "ghostty-web";
import { ensureContrastRatio, type Rgb } from "@tmux-server/engine-support";

export interface RendererOverrides {
  // Multiplier on the measured cell height (1 = font-native).
  lineHeight: number;
  // Pixels added to the measured cell width (0 = font-native).
  letterSpacing: number;
  // 1 disables the contrast adjustment entirely.
  minimumContrastRatio: number;
  // Stroke width (px) added around every glyph — synthetic fractional
  // thickening for weights the font doesn't ship (0 = off). Background-like
  // glyphs (box drawing, powerline) are exempt, same as the contrast rule.
  textThickness: number;
}

export interface RendererShim {
  // Replaces the override values, clears the contrast cache, and re-measures
  // so the new metrics are live. Callers still need to resize/refit — they
  // own the terminal's cols/rows.
  setOverrides(next: RendererOverrides): void;
}

const BOLD = 1;
const INVISIBLE = 32;
const INVERSE = 16;

// xterm's renderers exempt "background-like" glyphs from minimum-contrast
// demands (its treatGlyphAsBackgroundColor): box-drawing/block elements
// (U+2500–U+259F) and powerline glyphs (U+E0A4–U+E0D6 area). These are
// deliberately-faint decorations — nvim indent guides (│), powerline
// separators, block fills — and force-lightening them makes indentation
// scaffolding glare instead of staying subtle.
function excludedFromContrast(codepoint: number): boolean {
  return (codepoint >= 9472 && codepoint <= 9631) || (codepoint >= 57508 && codepoint <= 57558);
}

// "#rrggbb" (the shape theme.ts produces) -> rgb triple; anything else maps
// to black, which the contrast shim already treats as "theme background".
export function parseHexColor(hex: string | undefined): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

interface RendererInternals {
  fontSize: number;
  fontFamily: string;
  cursorStyle: "block" | "underline" | "bar";
  theme: { cursor?: string; cursorAccent?: string; background?: string };
  ctx: CanvasRenderingContext2D;
  metrics: { width: number; height: number; baseline: number };
  currentBuffer?: {
    getLine(y: number): GhosttyCell[] | null;
    getGraphemeString?(row: number, col: number): string;
  };
  measureFont(): { width: number; height: number; baseline: number };
  remeasureFont(): void;
  renderCellText(cell: GhosttyCell, x: number, y: number): void;
  renderCursor(x: number, y: number): void;
}

const ITALIC = 2;

// ghostty-web 0.4.0's measureFont() Math.ceil()s the glyph advance to whole
// CSS pixels, silently padding every cell (IBM Plex Mono at 14px advances
// 8.4px -> 9px cells: +0.6px of artificial letter spacing per character).
// xterm.js's WebGL renderer — what this app shipped with — computed
// `Math.floor(charWidth * devicePixelRatio)` device pixels per cell
// (verified against @xterm/addon-webgl 0.18 source AND by pixel-measuring
// before/after screenshots: 16 vs 17 device px at dpr 2). Reproduce that
// exactly: exact advance, floored at device pixels. Fractional CSS cell
// widths are fine downstream (canvas fillText positions, selection/mouse
// cell math, and FitAddon all run off the same metrics value).
function deviceFlooredAdvance(internals: RendererInternals): number | null {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `${internals.fontSize}px ${internals.fontFamily}`;
  const advance = ctx.measureText("M").width;
  if (!(advance > 0)) return null;
  const dpr = window.devicePixelRatio || 1;
  return Math.floor(advance * dpr) / dpr;
}

export function applyRendererOverrides(
  renderer: CanvasRenderer,
  initial: RendererOverrides,
  themeBackground: Rgb,
): RendererShim {
  const internals = renderer as unknown as RendererInternals;
  let overrides = initial;

  // ---- lineHeight / letterSpacing: wrap measureFont ----
  // Every metrics refresh in 0.4.0 funnels through `this.measureFont()`
  // (the constructor, setFontSize, setFontFamily, and remeasureFont all
  // assign its return value), so shadowing it per-instance covers every
  // re-measure path, including the option-Proxy font changes.
  const originalMeasure = internals.measureFont.bind(renderer);
  internals.measureFont = () => {
    const m = originalMeasure();
    const extraHeight = Math.round(m.height * overrides.lineHeight) - m.height;
    if (extraHeight !== 0) {
      m.height += extraHeight;
      // Keep glyphs vertically centered in the taller (or shorter) cell.
      m.baseline += Math.round(extraHeight / 2);
    }
    // Undo upstream's ceil-to-CSS-pixel cell padding (see
    // deviceFlooredAdvance), then apply the user's letter spacing
    // unrounded — the Settings control steps by 0.5px.
    const advance = deviceFlooredAdvance(internals);
    if (advance !== null) m.width = advance;
    m.width += overrides.letterSpacing;
    return m;
  };
  // The constructor already measured before this shim existed — refresh.
  internals.remeasureFont();

  // ---- minimumContrastRatio: shadow renderCellText ----
  // Cache adjusted colors per (text, background, ratio-generation) — the
  // key packs both 24-bit colors into one exact double (2^48 < 2^53).
  // Value: adjusted 24-bit color, or -1 for "already meets the ratio".
  let contrastCache = new Map<number, number>();
  const proto = Object.getPrototypeOf(renderer) as RendererInternals;
  const originalRenderCellText = proto.renderCellText;
  if (typeof originalRenderCellText === "function") {
    internals.renderCellText = function (cell: GhosttyCell, x: number, y: number) {
      if (
        overrides.minimumContrastRatio > 1 &&
        !(cell.flags & INVISIBLE) &&
        !excludedFromContrast(cell.codepoint)
      ) {
        const inverse = (cell.flags & INVERSE) !== 0;
        const tr = inverse ? cell.bg_r : cell.fg_r;
        const tg = inverse ? cell.bg_g : cell.fg_g;
        const tb = inverse ? cell.bg_b : cell.fg_b;
        let br = inverse ? cell.fg_r : cell.bg_r;
        let bg = inverse ? cell.fg_g : cell.bg_g;
        let bb = inverse ? cell.fg_b : cell.bg_b;
        // Pass 1 skips painting pure-black backgrounds, letting the theme
        // background show through — contrast against what's actually there.
        if (br === 0 && bg === 0 && bb === 0) [br, bg, bb] = themeBackground;
        const key = (tr << 16 | tg << 8 | tb) * 0x1000000 + (br << 16 | bg << 8 | bb);
        let packed = contrastCache.get(key);
        if (packed === undefined) {
          const adjusted = ensureContrastRatio([tr, tg, tb], [br, bg, bb], overrides.minimumContrastRatio);
          packed = adjusted ? (adjusted[0] << 16) | (adjusted[1] << 8) | adjusted[2] : -1;
          contrastCache.set(key, packed);
        }
        if (packed !== -1) {
          const ar = (packed >> 16) & 0xff;
          const ag = (packed >> 8) & 0xff;
          const ab = packed & 0xff;
          if (inverse) {
            cell.bg_r = ar; cell.bg_g = ag; cell.bg_b = ab;
          } else {
            cell.fg_r = ar; cell.fg_g = ag; cell.fg_b = ab;
          }
        }
      }
      strokeNextFill =
        overrides.textThickness > 0 && !excludedFromContrast(cell.codepoint);
      const result = originalRenderCellText.call(this, cell, x, y);
      strokeNextFill = false;
      return result;
    };
  }

  // ---- textThickness: stroke glyphs after they're filled ----
  // renderCellText draws each glyph with one ctx.fillText; re-stroking the
  // same text in the same color fattens every stem by lineWidth px —
  // synthetic fractional weight for fonts that only ship fixed weights.
  // Wrapping ctx.fillText (armed per-cell by the renderCellText shadow
  // above, so cursor/box-drawing/powerline draws stay untouched) reuses the
  // exact string, position, font, and color without duplicating the
  // renderer's layout logic.
  let strokeNextFill = false;
  const ctx2d = internals.ctx;
  if (ctx2d) {
    const originalFillText = ctx2d.fillText.bind(ctx2d);
    ctx2d.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
      if (maxWidth === undefined) originalFillText(text, x, y);
      else originalFillText(text, x, y, maxWidth);
      if (strokeNextFill && overrides.textThickness > 0) {
        ctx2d.lineWidth = overrides.textThickness;
        ctx2d.lineJoin = "round";
        ctx2d.strokeStyle = ctx2d.fillStyle as string;
        ctx2d.strokeText(text, x, y);
      }
    };
  }

  // ---- block cursor: repaint the glyph the cursor covers ----
  // Upstream's renderCursor fills a solid rect and stops — the character
  // under a block cursor disappears. xterm repaints it in cursorAccent;
  // do the same from the current buffer (underline/bar cursors don't
  // cover the glyph, so they need nothing).
  const originalRenderCursor = (Object.getPrototypeOf(renderer) as RendererInternals)
    .renderCursor;
  if (typeof originalRenderCursor === "function") {
    internals.renderCursor = function (x: number, y: number) {
      originalRenderCursor.call(this, x, y);
      if (internals.cursorStyle !== "block") return;
      const cells = internals.currentBuffer?.getLine(y);
      const cell = cells?.[x];
      if (!cell || !cell.codepoint) return;
      const m = internals.metrics;
      let style = "";
      if (cell.flags & ITALIC) style += "italic ";
      if (cell.flags & BOLD) style += "bold ";
      ctx2d.font = `${style}${internals.fontSize}px ${internals.fontFamily}`;
      ctx2d.fillStyle =
        internals.theme.cursorAccent ?? internals.theme.background ?? "#000000";
      const text =
        cell.grapheme_len > 0 && internals.currentBuffer?.getGraphemeString
          ? internals.currentBuffer.getGraphemeString(y, x)
          : String.fromCodePoint(cell.codepoint);
      ctx2d.fillText(text, x * m.width, y * m.height + m.baseline);
    };
  }

  return {
    setOverrides(next: RendererOverrides) {
      overrides = next;
      contrastCache = new Map();
      internals.remeasureFont();
    },
  };
}
