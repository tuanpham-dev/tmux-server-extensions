// Pure usage-aggregation functions for the Claude usage panel (T16/T17) —
// ccusage-style floating 5-hour blocks over Claude Code's own transcript
// JSONL files. No I/O here; server.js reads files and calls these. Verified
// field shapes against a real transcript on this machine: assistant entries
// carry message.id, top-level requestId, message.model, message.usage
// {input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens}, and an ISO timestamp string.

// Parses one transcript's raw JSONL text into usage entries. Dedupes by
// message.id + requestId when both are present (a retried request re-logs
// the same message.id under a fresh line, or vice versa — pairing both
// catches either case; an entry missing one of the two id fields is kept
// as-is rather than risking under-counting). A malformed/truncated line
// (mid-write) or a non-assistant/no-usage entry just contributes nothing.
export function parseUsageLines(jsonlText) {
  const seen = new Set();
  const out = [];
  for (const raw of jsonlText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object" || obj.type !== "assistant") continue;
    const msg = obj.message;
    if (!msg || typeof msg !== "object" || !msg.usage) continue;
    const usage = msg.usage;

    const msgId = typeof msg.id === "string" ? msg.id : null;
    const requestId = typeof obj.requestId === "string" ? obj.requestId : null;
    if (msgId && requestId) {
      const key = `${msgId}|${requestId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    const timestamp = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) continue;

    out.push({
      timestamp,
      model: typeof msg.model === "string" ? msg.model : "unknown",
      input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      cacheRead: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
      cacheCreation: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0,
    });
  }
  return out;
}

function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function addInto(totals, e) {
  totals.input += e.input;
  totals.output += e.output;
  totals.cacheRead += e.cacheRead;
  totals.cacheCreation += e.cacheCreation;
}

// Floating blocks: a new block starts whenever an entry is blockMs or more
// after the current block's start (ccusage's convention), anchored to the
// top of the hour containing its first entry — not to the entry's own
// timestamp — so a block's displayed start reads as a clean wall-clock hour.
// `now` (caller-supplied — Date.now() is unavailable in workflow scripts,
// and passing it explicitly keeps this function pure and testable) decides
// which block, if any, is flagged current.
export function blocksFor(entries, now, blockMs = 5 * 60 * 60 * 1000) {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);

  const blocks = [];
  let current = null;
  for (const e of sorted) {
    if (!current || e.timestamp >= current.start + blockMs) {
      const anchor = new Date(e.timestamp);
      anchor.setMinutes(0, 0, 0);
      current = {
        start: anchor.getTime(),
        end: anchor.getTime() + blockMs,
        perModel: {},
        total: emptyTotals(),
        firstAt: e.timestamp,
        lastAt: e.timestamp,
      };
      blocks.push(current);
    }
    current.lastAt = e.timestamp;
    const perModel = current.perModel[e.model] ?? (current.perModel[e.model] = emptyTotals());
    addInto(perModel, e);
    addInto(current.total, e);
  }

  return blocks.map((b) => ({ ...b, isCurrent: now >= b.start && now < b.end }));
}
