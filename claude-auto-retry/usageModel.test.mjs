import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUsageLines, blocksFor } from "./usageModel.mjs";

function assistantLine({ id, requestId, model, timestamp, input, output, cacheRead, cacheCreation }) {
  return JSON.stringify({
    type: "assistant",
    requestId,
    timestamp,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    },
  });
}

describe("parseUsageLines", () => {
  it("parses a well-formed assistant line", () => {
    const line = assistantLine({
      id: "msg_1",
      requestId: "req_1",
      model: "claude-fable-5",
      timestamp: "2026-08-18T18:00:00.000Z",
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheCreation: 3,
    });
    const entries = parseUsageLines(line);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, "claude-fable-5");
    assert.equal(entries[0].input, 10);
    assert.equal(entries[0].output, 20);
    assert.equal(entries[0].cacheRead, 5);
    assert.equal(entries[0].cacheCreation, 3);
    assert.equal(entries[0].timestamp, Date.parse("2026-08-18T18:00:00.000Z"));
  });

  it("dedupes by message.id + requestId", () => {
    const line = assistantLine({
      id: "msg_dup",
      requestId: "req_dup",
      model: "claude-fable-5",
      timestamp: "2026-08-18T18:00:00.000Z",
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheCreation: 0,
    });
    const entries = parseUsageLines([line, line, line].join("\n"));
    assert.equal(entries.length, 1);
  });

  it("keeps entries whose id or requestId is missing (no false-dedup)", () => {
    const a = assistantLine({
      id: null,
      requestId: "req_a",
      model: "claude-fable-5",
      timestamp: "2026-08-18T18:00:00.000Z",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheCreation: 0,
    });
    const b = assistantLine({
      id: null,
      requestId: "req_b",
      model: "claude-fable-5",
      timestamp: "2026-08-18T18:01:00.000Z",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheCreation: 0,
    });
    const entries = parseUsageLines([a, b].join("\n"));
    assert.equal(entries.length, 2);
  });

  it("skips malformed and non-assistant lines without throwing", () => {
    const good = assistantLine({
      id: "msg_1",
      requestId: "req_1",
      model: "claude-fable-5",
      timestamp: "2026-08-18T18:00:00.000Z",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheCreation: 0,
    });
    const lines = [
      "",
      "not json at all {{{",
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_2" } }), // no usage
      good,
      "{ truncated mid-wri",
    ].join("\n");
    const entries = parseUsageLines(lines);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, "claude-fable-5");
  });

  it("drops an entry with no parseable timestamp", () => {
    const line = JSON.stringify({
      type: "assistant",
      requestId: "req_x",
      message: { id: "msg_x", model: "claude-fable-5", usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const entries = parseUsageLines(line);
    assert.equal(entries.length, 0);
  });
});

describe("blocksFor", () => {
  const HOUR = 60 * 60 * 1000;
  const FIVE_HOURS = 5 * HOUR;

  it("returns no blocks for empty input", () => {
    assert.deepEqual(blocksFor([], Date.now()), []);
  });

  it("groups entries within one 5-hour window into a single block", () => {
    const base = new Date("2026-08-18T10:15:00.000Z").getTime();
    const entries = [
      { timestamp: base, model: "m", input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      { timestamp: base + HOUR, model: "m", input: 20, output: 8, cacheRead: 0, cacheCreation: 0 },
      { timestamp: base + 4 * HOUR, model: "m", input: 30, output: 12, cacheRead: 0, cacheCreation: 0 },
    ];
    const blocks = blocksFor(entries, base + 4 * HOUR + 1000);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].total.input, 60);
    assert.equal(blocks[0].total.output, 25);
    // Anchored to the top of the hour containing the first entry (10:15 -> 10:00).
    assert.equal(blocks[0].start, new Date("2026-08-18T10:00:00.000Z").getTime());
    assert.equal(blocks[0].end, blocks[0].start + FIVE_HOURS);
  });

  it("starts a new block once a gap of >= 5 hours passes", () => {
    const base = new Date("2026-08-18T10:00:00.000Z").getTime();
    const entries = [
      { timestamp: base, model: "m", input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      // Exactly 5h later -> new block (>= blockMs from the current block's start).
      { timestamp: base + FIVE_HOURS, model: "m", input: 7, output: 3, cacheRead: 0, cacheCreation: 0 },
    ];
    const blocks = blocksFor(entries, base + FIVE_HOURS + 1000);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].total.input, 10);
    assert.equal(blocks[1].total.input, 7);
    assert.equal(blocks[1].start, base + FIVE_HOURS);
  });

  it("flags exactly the block containing `now` as current", () => {
    const base = new Date("2026-08-18T10:00:00.000Z").getTime();
    const entries = [
      { timestamp: base, model: "m", input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      { timestamp: base + FIVE_HOURS, model: "m", input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    ];
    const blocks = blocksFor(entries, base + 30 * 60 * 1000); // 30 min into the first block
    assert.equal(blocks[0].isCurrent, true);
    assert.equal(blocks[1].isCurrent, false);
  });

  it("aggregates per-model totals separately", () => {
    const base = new Date("2026-08-18T10:00:00.000Z").getTime();
    const entries = [
      { timestamp: base, model: "sonnet", input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      { timestamp: base + HOUR, model: "opus", input: 20, output: 8, cacheRead: 0, cacheCreation: 0 },
    ];
    const blocks = blocksFor(entries, base);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].perModel.sonnet.input, 10);
    assert.equal(blocks[0].perModel.opus.input, 20);
    assert.equal(blocks[0].total.input, 30);
  });
});
