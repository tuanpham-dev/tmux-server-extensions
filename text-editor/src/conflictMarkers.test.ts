// Behavioural parity check against git-scm's own parser cases.
import { strict as assert } from "node:assert";
import { test } from "node:test";

const src = await import("./conflictMarkers.ts");
const { findConflicts, resolvedLines } = src;

const twoWay = ["a", "<<<<<<< HEAD", "ours1", "ours2", "=======", "theirs1", ">>>>>>> feature", "z"].join("\n");
const diff3 = ["<<<<<<< HEAD", "ours", "||||||| base-label", "basetext", "=======", "theirs", ">>>>>>> other"].join("\n");
const crlf = ["<<<<<<< HEAD\r", "ours\r", "=======\r", "theirs\r", ">>>>>>> other\r"].join("\n");

test("two-way block ranges", () => {
  const [b] = findConflicts(twoWay);
  assert.equal(b.startLine, 2);
  assert.equal(b.endLine, 7);
  assert.equal(b.oursLabel, "HEAD");
  assert.equal(b.theirsLabel, "feature");
  assert.deepEqual(b.ours, { from: 3, to: 4 });
  assert.deepEqual(b.theirs, { from: 6, to: 6 });
  assert.equal(b.base, undefined);
});

test("resolutions", () => {
  const [b] = findConflicts(twoWay);
  assert.deepEqual(resolvedLines(twoWay, b, "ours"), ["ours1", "ours2"]);
  assert.deepEqual(resolvedLines(twoWay, b, "theirs"), ["theirs1"]);
  assert.deepEqual(resolvedLines(twoWay, b, "both"), ["ours1", "ours2", "theirs1"]);
});

test("diff3 base section", () => {
  const [b] = findConflicts(diff3);
  assert.deepEqual(b.base, { from: 4, to: 4 });
  assert.equal(b.baseHeaderLine, 3);
  assert.deepEqual(resolvedLines(diff3, b, "ours"), ["ours"]);
});

test("CRLF markers recognized", () => {
  const [b] = findConflicts(crlf);
  assert.ok(b, "CRLF conflict should parse");
  assert.deepEqual(resolvedLines(crlf, b, "theirs"), ["theirs\r"]);
});

test("malformed block is ignored", () => {
  assert.deepEqual(findConflicts(["<<<<<<< HEAD", "ours", "no separator"].join("\n")), []);
});

test("two blocks", () => {
  const two = [twoWay, twoWay].join("\n");
  assert.equal(findConflicts(two).length, 2);
});
