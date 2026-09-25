import { test } from "node:test";
import assert from "node:assert/strict";
import { PostTally } from "../../src/content/tally.ts";

test("first verdict counts as checked, and as blocked when hidden", () => {
  const t = new PostTally();
  assert.deepEqual(t.record("a", false), { newlyChecked: true, newlyBlocked: false });
  assert.deepEqual(t.record("b", true), { newlyChecked: true, newlyBlocked: true });
});

test("re-evaluating the same post records nothing new", () => {
  const t = new PostTally();
  t.record("a", false);
  t.record("b", true);
  assert.equal(t.record("a", false), null);
  assert.equal(t.record("b", true), null);
  assert.equal(t.record("b", false), null);
});

test("a checked post that later gets hidden counts as blocked once, not re-checked", () => {
  const t = new PostTally();
  t.record("a", false);
  assert.deepEqual(t.record("a", true), { newlyChecked: false, newlyBlocked: true });
  assert.equal(t.record("a", true), null);
});

test("a blocked post that is later visible stays counted as blocked", () => {
  const t = new PostTally();
  t.record("a", true);
  t.record("a", false);
  assert.equal(t.record("a", true), null);
});
