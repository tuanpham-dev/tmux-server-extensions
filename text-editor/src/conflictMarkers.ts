// Conflict-marker parsing, ported from tmux-server's
// extensions/git-scm/conflictModel.mjs (same repo family, MIT) and kept
// behaviourally identical — the two have to agree about where a block starts
// and ends, or this editor and the git panel's own resolver would disagree
// about the same file.
//
// Differences from that original: it works in *line numbers* rather than array
// slices, because Monaco addresses everything by 1-based line, and it resolves
// one block at a time (Monaco's undo stack is the "buffer, then persist" model
// here, where the git panel keeps a separate resolutions map).
//
// Handles both marker styles: the default two-way set and diff3/zdiff3's
// three-way set with an extra "|||||||" base section (git's
// merge.conflictStyle). A trailing "\r" is stripped before comparing so a CRLF
// file is recognized the same as an LF one, while the stored line text keeps
// its original bytes.

export type ResolutionChoice = "ours" | "theirs" | "both";

export interface ConflictBlock {
  /** 1-based line of the "<<<<<<<" header. */
  startLine: number;
  /** 1-based line of the ">>>>>>>" footer. */
  endLine: number;
  oursLabel: string;
  theirsLabel: string;
  /** 1-based inclusive line ranges of each section's content. */
  ours: { from: number; to: number };
  theirs: { from: number; to: number };
  base?: { from: number; to: number };
  /** 1-based line of the "=======" separator. */
  separatorLine: number;
  /** 1-based line of the "|||||||" base header, when the file uses diff3. */
  baseHeaderLine?: number;
}

function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Every conflict block in `text`, in document order. A malformed block (no
 * "=======" or no ">>>>>>>") ends the scan rather than guessing a boundary —
 * the same bailout the original parser makes.
 */
export function findConflicts(text: string): ConflictBlock[] {
  const lines = text.split("\n");
  const blocks: ConflictBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    if (!stripCR(lines[i]).startsWith("<<<<<<< ")) {
      i++;
      continue;
    }
    const start = i;
    const oursLabel = stripCR(lines[i]).slice("<<<<<<< ".length);
    i++;
    const oursStart = i;
    while (i < lines.length && !stripCR(lines[i]).startsWith("|||||||") && stripCR(lines[i]) !== "=======") i++;
    const oursEnd = i - 1;

    let baseRange: { from: number; to: number } | undefined;
    let baseHeader: number | undefined;
    if (i < lines.length && stripCR(lines[i]).startsWith("|||||||")) {
      baseHeader = i;
      i++;
      const baseStart = i;
      while (i < lines.length && stripCR(lines[i]) !== "=======") i++;
      baseRange = { from: baseStart + 1, to: i };
    }

    if (i >= lines.length) break;
    const separator = i;
    i++;

    const theirsStart = i;
    while (i < lines.length && !stripCR(lines[i]).startsWith(">>>>>>> ")) i++;
    if (i >= lines.length) break;
    const theirsEnd = i - 1;
    const theirsLabel = stripCR(lines[i]).slice(">>>>>>> ".length);

    blocks.push({
      startLine: start + 1,
      endLine: i + 1,
      oursLabel,
      theirsLabel,
      ours: { from: oursStart + 1, to: oursEnd + 1 },
      theirs: { from: theirsStart + 1, to: theirsEnd + 1 },
      ...(baseRange ? { base: baseRange } : {}),
      separatorLine: separator + 1,
      ...(baseHeader !== undefined ? { baseHeaderLine: baseHeader + 1 } : {}),
    });
    i++;
  }

  return blocks;
}

/** The lines a block collapses to for `choice`, markers and base dropped. */
export function resolvedLines(text: string, block: ConflictBlock, choice: ResolutionChoice): string[] {
  const lines = text.split("\n");
  const slice = (range: { from: number; to: number }) =>
    range.to < range.from ? [] : lines.slice(range.from - 1, range.to);
  if (choice === "ours") return slice(block.ours);
  if (choice === "theirs") return slice(block.theirs);
  return [...slice(block.ours), ...slice(block.theirs)];
}
